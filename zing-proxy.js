import { ProxyAgent, fetch as proxyFetch } from 'undici';

export function createZingTransport(proxyURL, fetchImpl=proxyFetch, Agent=ProxyAgent) {
  let agent;
  try {
    const u=new URL(proxyURL);
    if(!['http:','https:'].includes(u.protocol) || !u.hostname || u.pathname!=='/' || u.search || u.hash)throw Error();
    const token=u.username || u.password?'Basic '+Buffer.from(decodeURIComponent(u.username)+':'+decodeURIComponent(u.password)).toString('base64'):undefined;
    agent=new Agent({uri:u.origin,...(token?{token}:{}),connections:2});
  } catch { throw Error('Invalid ZING_PROXY_URL: use an HTTP or HTTPS proxy URL'); }
  return {
    async request(url,options={}) {
      try {
        const r=await fetchImpl(url,{...options,dispatcher:agent});
        if([407,429].includes(r.status)){await r.body?.cancel();throw Error('Proxy unavailable');}
        return r;
      } catch(error) {
        const code=String(error?.cause?.code || error?.code || 'CONNECTION_FAILED').replace(/[^A-Z0-9_]/g,'').slice(0,60);
        throw Error('Zing proxy request failed: '+(code || 'CONNECTION_FAILED'));
      }
    },
    close:()=>agent.close(),
    destroy:()=>agent.destroy()
  };
}
let transport;
function configuredTransport() {
  // Account sessions must never travel through a public proxy.
  if(process.env.ZING_SESSION_COOKIE?.trim())return null;
  if(!process.env.ZING_PROXY_URL?.trim())return null;
  return transport ||= createZingTransport(process.env.ZING_PROXY_URL.trim());
}
export function zingProxyEnabled(){return !process.env.ZING_SESSION_COOKIE?.trim() && !!process.env.ZING_PROXY_URL?.trim();}
export async function zingFetch(url,options={}) {
  const proxy=configuredTransport();
  if(!proxy)return fetch(url,options);
  return proxy.request(url,options);
}

// Override only the request layer; the pinned library still generates API signatures.
export function configureZingProxyClient(client, providedTransport=null, options={}) {
  const sessionCookie=String(options.sessionCookie ?? (providedTransport?'':process.env.ZING_SESSION_COOKIE || '')).trim();
  if(sessionCookie){
    if(sessionCookie.length>16384 || /[\r\n\x00-\x1f\x7f]/.test(sessionCookie) ||
      !sessionCookie.split(';').every(part=>/^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;]*$/.test(part)))
      throw Error('Invalid ZING_SESSION_COOKIE: use a Cookie header value without line breaks');
    const directFetch=options.fetchImpl || fetch;
    client.requestZingMp3=async(apiPath,params)=>{
      if(!['/api/v2/search/multi','/api/v2/song/get/streaming'].includes(apiPath))throw Error('Unsupported Zing session API');
      const u=new URL(apiPath,'https://zingmp3.vn');
      for(const [k,v] of Object.entries({...params,ctime:client.CTIME,version:client.VERSION,apiKey:client.API_KEY}))u.searchParams.set(k,String(v));
      let r;
      try{
        r=await directFetch(u,{headers:{Accept:'application/json',Referer:'https://zingmp3.vn/',Cookie:sessionCookie},redirect:'error',signal:AbortSignal.timeout(6000)});
      }catch{throw Error('Zing authenticated request failed');}
      if(!r.ok){await r.body?.cancel();throw Error('Zing authenticated API HTTP '+r.status);}
      try{return await r.json();}catch{throw Error('Zing authenticated API returned invalid JSON');}
    };
    return true;
  }
  const proxy=providedTransport || configuredTransport();
  if(!proxy)return false;
  let cookie='',expires=0,pending;
  async function anonymousCookie(){
    if(expires>Date.now())return cookie;
    if(pending)return pending;
    pending=(async()=>{
      const r=await proxy.request('https://zingmp3.vn/',{signal:AbortSignal.timeout(6000)});
      if(!r.ok){await r.body?.cancel();throw Error('Zing session HTTP '+r.status);}
      cookie=(r.headers.getSetCookie?.() || []).map(value=>value.split(';')[0]).join('; ');
      await r.body?.cancel();expires=Date.now()+180000;return cookie;
    })();
    try{return await pending;}finally{pending=null;}
  }
  // Prepare the anonymous session before the first firmware request arrives.
  if(!providedTransport)void anonymousCookie().catch(()=>{});
  client.requestZingMp3=async (apiPath,params)=>{
    if(!['/api/v2/search/multi','/api/v2/song/get/streaming'].includes(apiPath))throw Error('Unsupported proxied Zing API');
    const u=new URL(apiPath,'https://zingmp3.vn');
    for(const [k,v] of Object.entries({...params,ctime:client.CTIME,version:client.VERSION,apiKey:client.API_KEY}))u.searchParams.set(k,String(v));
    const session=await anonymousCookie();
    const r=await proxy.request(u,{headers:{Accept:'application/json',...(session?{Cookie:session}:{})},signal:AbortSignal.timeout(6000)});
    if(!r.ok){await r.body?.cancel();throw Error('Zing API HTTP '+r.status);}
    return r.json();
  };
  return true;
}
