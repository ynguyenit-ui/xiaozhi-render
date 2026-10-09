import zingPackage from 'mp3-api';
import { createZingTransport, configureZingProxyClient } from './zing-proxy.js';

export const proxyChecks={state:'disabled',results:[]};
export async function checkZingProxy(proxyURL) {
  const row={proxy:proxyURL,stage:'session',playable:false};
  const transport=createZingTransport(proxyURL);
  try {
    const client=Object.assign(Object.create(Object.getPrototypeOf(zingPackage.ZingMp3)),zingPackage.ZingMp3);
    configureZingProxyClient(client,transport);
    client.CTIME=String(Math.floor(Date.now()/1000));
    row.stage='search';
    const search=await client.search('Sóng Gió Jack');
    row.search_code=search.err;
    row.found=search.data?.items?.songs?.length || 0;
    row.stage='stream';
    client.CTIME=String(Math.floor(Date.now()/1000));
    const stream=await client.getSong('R9PAHzNMWGek');
    row.stream_code=stream.err;
    if(Number(stream.err)!==0 || typeof stream.data?.['128']!=='string')return row;
    const u=new URL(stream.data['128']);
    if(u.protocol!=='https:' || u.username || u.password)throw Error('Invalid audio URL');
    row.stage='audio';
    const r=await transport.request(u,{headers:{Referer:'https://zingmp3.vn/',Range:'bytes=0-4095'},signal:AbortSignal.timeout(6000)});
    row.audio_status=r.status;row.content_type=r.headers.get('content-type');
    const reader=r.body?.getReader();
    try { const chunk=await reader?.read();row.bytes=chunk?.value?.length || 0; }
    finally { await reader?.cancel().catch(()=>{}); }
    row.playable=r.ok && /^audio\//i.test(row.content_type || '') && row.bytes>0;
    return row;
  } catch(error) { row.error=error.message;return row; }
  finally { await transport.close(); }
}

// Explicit, one-time diagnostics at startup; never modifies the active proxy.
export async function runProxyChecks(value) {
  const candidates=[...new Set(String(value).split(',').map(x=>x.trim()).filter(Boolean))];
  if(candidates.length>20)throw Error('At most 20 diagnostic proxies');
  for(const value of candidates){
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol) || u.username || u.password || u.pathname!=='/' || u.search || u.hash)throw Error('Diagnostic proxies must be public HTTP/HTTPS endpoints without credentials');
  }
  proxyChecks.state='running';proxyChecks.results=[];
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,candidates.length)},async()=>{
    while(next<candidates.length){
      const url=candidates[next++];const row=await checkZingProxy(url);
      proxyChecks.results.push(row);console.log('[ZING PROXY CHECK]',JSON.stringify(row));
    }
  }));
  proxyChecks.state='complete';
  console.log('[ZING PROXY SUMMARY]',JSON.stringify({tested:candidates.length,playable:proxyChecks.results.filter(x=>x.playable).length}));
}
