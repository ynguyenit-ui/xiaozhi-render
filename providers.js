import { spawn } from 'node:child_process';
export const normalize = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const domains = ['zingmp3.vn','nhaccuatui.com','youtube.com'];
export function allowedPage(page) {
  try {const u=new URL(page);return u.protocol==='https:' && !u.username && !u.password && (!u.port || u.port==='443') && domains.some(d => u.hostname===d || u.hostname.endsWith('.'+d));} catch{return false;}
}
export function rank(candidates,song,artist='') {
  const wanted=normalize(song), singer=normalize(artist);
  const tokens=wanted.split(' ').filter(Boolean);
  const versions=['remix','cover','karaoke','instrumental','sped up','slowed','live','mashup'];
  return candidates.filter(t => allowedPage(t.source_page)).map(t => {
    const title=normalize(t.title), all=normalize(t.title+' '+(t.artist || '')+' '+(t.description || ''));
    const overlap=tokens.filter(w => title.split(' ').includes(w)).length / Math.max(tokens.length,1);
    let score=overlap*100+(title.includes(wanted)?40:0);
    const artistWords=singer.split(' ').filter(Boolean);
    const artistMatch=!singer || artistWords.every(w=>all.split(' ').includes(w));
    if(singer)score+=artistMatch?35:-60;
    for(const v of versions) if(title.includes(v) && !wanted.includes(v))score-=50;
    if(/official|chinh thuc/.test(title))score+=8;
    if(t.duration && (t.duration<60 || t.duration>900))score-=50;
    return {...t,score:Math.round(score),overlap,artistMatch};
  }).filter(t=>t.overlap>=0.75 && t.artistMatch && t.score>=90).sort((a,b)=>b.score-a.score);
}
let jobs=0;
function extract(target,flat=false) {
  if(jobs>=3)return Promise.reject(Error('Extractor busy'));
  jobs++;
  return new Promise((resolve,reject)=>{
    const args=['-m','yt_dlp','--ignore-config','--no-warnings','--no-playlist','--socket-timeout','8','--retries','0','--skip-download','--dump-single-json'];
    if(flat)args.push('--flat-playlist');
    else args.push('-f','bestaudio[protocol=https]/bestaudio[protocol=http]/best[protocol=https]/best[protocol=http]');
    args.push('--',target);
    const p=spawn(process.env.PYTHON_PATH || 'python3',args,{stdio:['ignore','pipe','pipe']});
    let output='',error='',settled=false;
    const finish=(err,data)=>{if(settled)return;settled=true;clearTimeout(timer);jobs--;err?reject(err):resolve(data);};
    const timer=setTimeout(()=>{p.kill('SIGKILL');finish(Error('Extractor timeout'));},20000);
    p.stdout.on('data',d=>{output+=d;if(output.length>4_000_000){p.kill('SIGKILL');finish(Error('Extractor output too large'));}});
    p.stderr.on('data',d=>{error=(error+d).slice(-1500);});
    p.once('error',e=>finish(e));
    p.once('close',code=>{if(code!==0)return finish(Error(/sign in|bot|403|429/i.test(error)?'Provider blocked or needs login':'Provider extraction failed'));try{finish(null,JSON.parse(output));}catch{finish(Error('Invalid provider response'));}});
  });
}
const cache=new Map();
export async function webAudio(page) {
  if(!allowedPage(page))throw Error('Unsupported page domain');
  const cached=cache.get(page);
  if(cached && cached.expires>Date.now())return cached.source;
  const info=await extract(page);
  if(info.is_live || info.has_drm || !info.url || !/^https?:\/\//.test(info.url))throw Error('No public direct audio');
  const source={url:info.url,headers:info.http_headers || {}};
  if(cache.size>=100)cache.delete(cache.keys().next().value);
  cache.set(page,{source,expires:Date.now()+120000});
  return source;
}
async function searchSite(domain,query) {
  const u=new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q',`site:${domain} ${query}`);u.searchParams.set('count','8');
  const r=await fetch(u,{headers:{Accept:'application/json','X-Subscription-Token':process.env.BRAVE_SEARCH_API_KEY},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error(`Search API HTTP ${r.status}`);
  const data=await r.json();
  return (data.web?.results || []).filter(t=>allowedPage(t.url)).map(t=>({title:t.title,artist:'',description:t.description || '',source_page:t.url,provider:'web',site:domain}));
}
export async function searchWeb(song,artist) {
  const query=[song,artist].filter(Boolean).join(' '), candidates=[], errors=[];
  if(process.env.BRAVE_SEARCH_API_KEY) {
    // Sequential requests also work with API keys limited to one request/second.
    for(const domain of domains){try{candidates.push(...await searchSite(domain,query));}catch(e){errors.push({site:domain,error:e.message});}await new Promise(r=>setTimeout(r,1100));}
  } else {
    errors.push({site:'zingmp3.vn / nhaccuatui.com',error:'Set BRAVE_SEARCH_API_KEY to search these domains'});
    try{const data=await extract('ytsearch8:'+query,true);for(const t of data.entries || [])candidates.push({title:t.title,artist:t.uploader || t.channel || '',duration:t.duration,source_page:'https://www.youtube.com/watch?v='+t.id,provider:'web',site:'youtube.com'});}catch(e){errors.push({site:'youtube.com',error:e.message});}
  }
  const unique=[...new Map(candidates.map(t=>[t.source_page,t])).values()];
  return {candidates:rank(unique,song,artist),errors};
}
export async function resolveWeb(song,artist) {
  const result=await searchWeb(song,artist);
  for(const candidate of result.candidates.slice(0,3)) {
    try{await webAudio(candidate.source_page);return {...candidate,id:Buffer.from(candidate.source_page).toString('base64url')};}
    catch(e){result.errors.push({site:candidate.site,error:e.message});}
  }
  console.warn('[PROVIDERS]',JSON.stringify(result.errors));
  return null;
}
