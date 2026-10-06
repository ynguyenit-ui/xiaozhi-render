// Podcast công khai: tìm tập audio qua iTunes, dùng episodeUrl đầy đủ.
const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const cache=new Map(),pending=new Map();
export function parsePodcastRequest(song,source=''){
  let query=String(song||'').trim();
  const explicit=/^(podcast|podcasts)$/i.test(source);
  const prefix=/^(?:(?:hãy|hay)\s+)?(?:(?:mở|mo|phát|phat|nghe|tìm|tim|tìm kiếm|tim kiem)\s+)?podcasts?\s*[:\-]?\s*/i;
  if(!explicit && !prefix.test(query))return null;
  return query.replace(prefix,'').trim();
}
function publicHTTPS(value){
  try{
    const u=new URL(value),h=u.hostname.toLowerCase();
    return u.protocol==='https:' && !u.username && !u.password && !u.port && h.includes('.') &&
      !/^[\d.]+$/.test(h) && !h.includes(':') && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(h);
  }catch{return false;}
}
export async function searchPodcast(query){
  if(process.env.ENABLE_PODCAST==='false')return null;
  const wanted=normalize(query);if(!wanted || query.length>200)return null;
  const hit=cache.get(wanted);if(hit && hit.expires>Date.now())return hit.track;
  if(pending.has(wanted))return pending.get(wanted);
  const task=(async()=>{
    const u=new URL('https://itunes.apple.com/search');
    u.search=new URLSearchParams({term:query,media:'podcast',entity:'podcastEpisode',country:'VN',limit:'30'});
    const response=await fetch(u,{signal:AbortSignal.timeout(12000),headers:{Accept:'application/json'}});
    if(!response.ok)throw Error('Podcast directory HTTP '+response.status);
    const data=await response.json(),words=wanted.split(' ');
    const candidates=(data.results||[]).filter(r=>r.kind==='podcast-episode' && r.episodeContentType==='audio' && publicHTTPS(r.episodeUrl) &&
      r.trackTimeMillis>0 && r.trackTimeMillis<=7200000 && /^https:\/\/podcasts\.apple\.com\//.test(r.trackViewUrl||'')).map(r=>{
      const title=normalize(r.trackName),show=normalize(r.collectionName),all=title+' '+show;
      const overlap=words.filter(w=>all.split(' ').includes(w)).length/words.length;
      const score=(title===wanted?200:show===wanted?150:0)+overlap*100;
      return {row:r,score,overlap};
    }).filter(x=>x.overlap>=.75).sort((a,b)=>b.score-a.score || Date.parse(b.row.releaseDate)-Date.parse(a.row.releaseDate));
    const row=candidates[0]?.row;
    const track=row?{id:String(row.trackId),provider:'podcast',site:'Podcast',title:row.trackName,artist:row.collectionName,
      duration:Math.round(row.trackTimeMillis/1000),source_page:row.trackViewUrl,podcast_source:row.episodeUrl}:null;
    if(cache.size>=100)cache.delete(cache.keys().next().value);
    cache.set(wanted,{track,expires:Date.now()+(track?300000:15000)});
    console.log('[PODCAST SEARCH]',JSON.stringify({query,matched:candidates.length,title:track?.title}));return track;
  })();
  pending.set(wanted,task);try{return await task;}finally{pending.delete(wanted);}
}
export function podcastAudio(track){
  // URL chỉ lấy từ kết quả directory; endpoint /audio không nhận URL người dùng.
  if(track.provider!=='podcast' || !publicHTTPS(track.podcast_source))throw Error('Invalid podcast source');
  return {url:track.podcast_source};
}
