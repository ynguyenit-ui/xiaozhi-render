import { searchPodcastRSS } from './podcast-rss.js';
// Podcast công khai: tìm tập audio qua iTunes, dùng episodeUrl đầy đủ.
const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const cache=new Map(),pending=new Map();
export function parsePodcastRequest(song,source=''){
  let query=String(song||'').trim();
  const explicit=/^(podcasts?|padcasts?|spotify)$/i.test(source);
  if(spotifyEpisodeURL(query))return spotifyEpisodeURL(query);
  const keyword=/\b(?:podcasts?|padcasts?)\b/i;
  if(!explicit && !keyword.test(query))return null;
  query=query.replace(/\b(?:podcasts?|padcasts?)\b/gi,' ').trim();
  query=query.replace(/^(?:(?:hãy|hay|cho tôi|cho toi|giúp tôi|giup toi)\s+)?(?:(?:mở|mo|phát|phat|nghe|tìm kiếm|tim kiem|tìm|tim|kể|ke)\s+)+/i,'');
  query=query.replace(/^(?:một tập|mot tap|một|mot)\s+/i,'');
  query=query.replace(/^[:\-\s]+/,'').replace(/\s*[:\-]+\s*$/,'');
  query=query.replace(/^(?:về|ve|about)\s+/i,'').replace(/^(?:chủ đề|chu de)\s+/i,'').replace(/^(?:truyện|truyen|câu chuyện|cau chuyen)\s+/i,'');
  return query.replace(/\s+/g,' ').trim();
}
function spotifyEpisodeURL(value){
  try{const u=new URL(String(value).trim());return u.protocol==='https:' && u.hostname==='open.spotify.com' && !u.username && !u.password && !u.port && /^\/episode\/[a-zA-Z0-9]{22}\/?$/.test(u.pathname)?'https://open.spotify.com'+u.pathname.replace(/\/$/,''):null;}catch{return null;}
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
    const spotify=spotifyEpisodeURL(query);
    if(spotify){
      const endpoint=new URL('https://open.spotify.com/oembed');endpoint.searchParams.set('url',spotify);
      const response=await fetch(endpoint,{signal:AbortSignal.timeout(7000),headers:{Accept:'application/json'}});
      if(!response.ok)throw Error('Spotify metadata HTTP '+response.status);
      const metadata=await response.json(),title=String(metadata.title || '').trim();
      if(!title || title.length>200)throw Error('Spotify episode title unavailable');
      const found=await searchPodcast(title);
      // Link một tập cụ thể: không tự thay bằng tập hoặc chương trình khác.
      const track=found && normalize(found.title)===normalize(title)?{...found,source_page:spotify}:null;
      if(cache.size>=100)cache.delete(cache.keys().next().value);
      cache.set(wanted,{track,expires:Date.now()+(track?300000:15000)});
      console.log('[SPOTIFY PUBLIC PODCAST]',JSON.stringify({title,found:!!track}));return track;
    }
    const u=new URL('https://itunes.apple.com/search');
    u.search=new URLSearchParams({term:query,media:'podcast',entity:'podcastEpisode',country:'VN',limit:'30'});
    const response=await fetch(u,{signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}});
    if(!response.ok)throw Error('Podcast directory HTTP '+response.status);
    const data=await response.json(),words=wanted.split(' ');
    const candidates=(data.results||[]).filter(r=>r.kind==='podcast-episode' && r.episodeContentType==='audio' && publicHTTPS(r.episodeUrl) &&
      r.trackTimeMillis>0 && r.trackTimeMillis<=7200000 && /^https:\/\/podcasts\.apple\.com\//.test(r.trackViewUrl||'')).map(r=>{
      const title=normalize(r.trackName),show=normalize(r.collectionName),description=normalize(String(r.description || r.shortDescription || '').replace(/<[^>]*>/g,' ').slice(0,3000)),all=title+' '+show;
      const metadataOverlap=words.filter(w=>(all+' '+description).split(' ').includes(w)).length/words.length;
      const overlap=words.filter(w=>all.split(' ').includes(w)).length/words.length;
      const phrase=(` ${title} `).includes(` ${wanted} `);
      const literal=String(r.trackName || '').toLocaleLowerCase('vi').includes(String(query).toLocaleLowerCase('vi'));
      const continuation=/\b(?:phan|tap|part)\s*[2-9]\b/.test(title) && !/\b(?:phan|tap|part)\s*\d/.test(wanted);
      const score=(title===wanted?250:show===wanted?180:phrase?120:0)+overlap*100+metadataOverlap*30+(literal?20:0)-(continuation?50:0);
      return {row:r,score,overlap:Math.max(overlap,metadataOverlap)};
    }).filter(x=>x.overlap>=.75).sort((a,b)=>b.score-a.score || Date.parse(b.row.releaseDate)-Date.parse(a.row.releaseDate));
    const row=candidates[0]?.row;
    let track=row?{id:String(row.trackId),provider:'podcast',site:'Podcast',title:row.trackName,artist:row.collectionName,
      duration:Math.round(row.trackTimeMillis/1000),source_page:row.trackViewUrl,podcast_source:row.episodeUrl}:null;
    if(!track && process.env.PODCAST_RSS_FALLBACK!=='false'){
      try{track=await searchPodcastRSS(query,data.results || []);}catch(error){console.warn('[PODCAST RSS FAILED]',error.message);}
    }
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
