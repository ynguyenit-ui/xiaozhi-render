import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
const blocked=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(address,prefix,'ipv4');
for(const [address,prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8]])blocked.addSubnet(address,prefix,'ipv6');
async function validate(value){
  const u=new URL(value);
  if(u.protocol!=='https:' || u.username || u.password || u.port || isIP(u.hostname) || !u.hostname.includes('.'))throw Error('RSS requires public HTTPS');
  const addresses=await lookup(u.hostname,{all:true});
  if(!addresses.length || addresses.some(x=>(x.family===6 && x.address.toLowerCase().startsWith('::ffff:')) || blocked.check(x.address,x.family===6?'ipv6':'ipv4')))throw Error('RSS address is not public');
  return u;
}
async function readFeed(url,signal){
  for(let i=0;i<4;i++){
    const u=await validate(url),r=await fetch(u,{redirect:'manual',signal,headers:{Accept:'application/rss+xml, application/xml, text/xml','User-Agent':'XiaozhiPodcast/1.0'}});
    if([301,302,303,307,308].includes(r.status)){
      const target=r.headers.get('location');await r.body?.cancel();if(!target)throw Error('RSS redirect missing');url=new URL(target,u).href;continue;
    }
    if(!r.ok || !r.body){await r.body?.cancel();throw Error('RSS HTTP '+r.status);}
    const chunks=[];let size=0;
    for await(const chunk of r.body){size+=chunk.length;if(size>6*1024*1024)throw Error('RSS too large');chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks);
  }
  throw Error('RSS redirects exceeded');
}
function parse(xml){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.PYTHON_PATH || 'python3',[new URL('./podcast-rss.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
    let stdout='',size=0;const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('RSS parsing timed out'));},3000);
    child.stdin.on('error',()=>{});child.stderr.resume();
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>3*1024*1024)child.kill('SIGKILL');else stdout+=chunk;});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);try{if(code!==0 || size>3*1024*1024)throw Error('Invalid RSS');resolve(JSON.parse(stdout));}catch(error){reject(error);}});
    child.stdin.end(xml);
  });
}
const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export async function searchPodcastRSS(query,rows=[]){
  let feeds=[...new Set(rows.map(r=>r.feedUrl).filter(Boolean))].slice(0,3);
  if(!feeds.length){
    const u=new URL('https://itunes.apple.com/search');u.search=new URLSearchParams({term:query,media:'podcast',entity:'podcast',country:'VN',limit:'3'});
    const r=await fetch(u,{signal:AbortSignal.timeout(3000)});if(!r.ok){await r.body?.cancel();return null;}
    const data=await r.json();feeds=[...new Set((data.results||[]).map(r=>r.feedUrl).filter(Boolean))].slice(0,3);
  }
  const results=await Promise.allSettled(feeds.map(async feed=>{
    const xml=await readFeed(feed,AbortSignal.timeout(4000));return (await parse(xml)).map(row=>({...row,feed}));
  }));
  for(const result of results)if(result.status==='rejected')console.warn('[PODCAST RSS SOURCE FAILED]',result.reason?.message || 'RSS unavailable');
  const wanted=normalize(query),words=wanted.split(' ');
  const candidates=results.flatMap(r=>r.status==='fulfilled'?r.value:[]).filter(r=>{
    try{const u=new URL(r.url);return u.protocol==='https:' && !u.username && !u.password && !u.port && !isIP(u.hostname);}catch{return false;}
  }).map(row=>{
    const title=normalize(row.title),show=normalize(row.show),text=title+' '+show+' '+normalize(row.description);
    const overlap=words.filter(w=>text.split(' ').includes(w)).length/words.length;
    const score=overlap*100+(title===wanted?250:show===wanted?180:title.includes(wanted)?120:0);
    return {row,overlap,score};
  }).filter(r=>r.overlap>=.75).sort((a,b)=>b.score-a.score || (Date.parse(b.row.published)||0)-(Date.parse(a.row.published)||0));
  const row=candidates[0]?.row;if(!row)return null;
  console.log('[PODCAST RSS]',JSON.stringify({query,title:row.title}));
  return {id:'rss-'+createHash('sha256').update(row.guid || row.url).digest('hex').slice(0,24),provider:'podcast',site:'Podcast RSS',title:row.title,artist:row.show,duration:row.duration,source_page:row.feed,podcast_source:row.url};
}
