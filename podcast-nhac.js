// Read the public player on the requested Nhac.vn episode; refresh its URL.
const PAGE='https://nhac.vn/podcast/tam-cam-truyen-co-tich-pcWEmok';
const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function nhacPodcastURL(value){
  try{const u=new URL(String(value).trim());return u.protocol==='https:' && u.hostname==='nhac.vn' && !u.username && !u.password && !u.port && /^\/podcast\/[a-z0-9-]+-pcWEmok\/?$/.test(u.pathname)?PAGE:null;}catch{return null;}
}
export function parseNhacPodcast(html){
  const setup=html.match(/jwplayer\(['"]mypodcast['"]\)\.setup\(\{([\s\S]*?)\}\);/i)?.[1];
  const field=name=>setup?.match(new RegExp('\\b'+name+"\\s*:\\s*(['\"])(.*?)\\1"))?.[2]?.trim();
  const url=field('file'),title=field('title'),artist=field('description');
  if(!url || !title)throw Error('Nhac.vn podcast player unavailable');
  const u=new URL(url);
  if(u.protocol!=='https:' || u.hostname!=='anchor.fm' || u.username || u.password || u.port || !u.pathname.startsWith('/s/3b2989d0/podcast/play/'))throw Error('Unexpected Nhac.vn podcast audio source');
  return {id:'nhac-pcWEmok',provider:'podcast',site:'Nhac.vn Podcast',title,artist:artist || 'Khoa Tran',duration:0,source_page:PAGE,podcast_source:u.href};
}
export async function searchNhacPodcast(query){
  const wanted=normalize(query);
  if(!nhacPodcastURL(query) && !/^(?:truyen |ke chuyen |ke truyen )?tam cam(?: truyen co tich)?(?: (?:tren )?nhac vn)?$/.test(wanted))return null;
  const r=await fetch(PAGE,{signal:AbortSignal.timeout(8000),redirect:'error',headers:{'User-Agent':'XiaozhiPodcast/1.0'}});
  if(!r.ok || !r.body){await r.body?.cancel();throw Error('Nhac.vn podcast HTTP '+r.status);}
  let size=0;const chunks=[];
  for await(const chunk of r.body){size+=chunk.length;if(size>1024*1024)throw Error('Nhac.vn podcast page too large');chunks.push(Buffer.from(chunk));}
  return parseNhacPodcast(Buffer.concat(chunks).toString('utf8'));
}
