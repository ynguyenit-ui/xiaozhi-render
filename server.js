import { searchPodcast, parsePodcastRequest, podcastAudio } from './podcast.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createAudioCache, AUDIO_BITRATE_KBPS } from './audio-cache.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWeb, webAudio, searchWeb, allowedPage, parseMusicRequest, searchMusicMetadata, nctAudio } from './providers.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));
const mode = process.env.RESPONSE_MODE || 'json';
const rate = Number(process.env.SAMPLE_RATE || 24000);
if (!['json','mp3','pcm'].includes(mode) || ![16000,24000,44100,48000].includes(rate)) throw Error('Invalid RESPONSE_MODE or SAMPLE_RATE');
const base = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (base && !/^https?:\/\//.test(base)) throw Error('PUBLIC_BASE_URL must include https://');
let active = 0;
const maxStreams = Number(process.env.MAX_STREAMS || 2);
const normalize = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const contains = (a,b) => b && (` ${a} `).includes(` ${b} `);
function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
}
function select(tracks, song, artist) {
  const title = normalize(song), singer = normalize(artist);
  return tracks.map(t => {
    const names = [t.title, ...(t.aliases || [])].map(normalize);
    const score = Math.max(...names.map(n => n === title ? 100 : contains(n,title) ? 75 : 0));
    const artistOK = !singer || contains(normalize(t.artist), singer) || contains(normalize(t.title), singer);
    return {t, score: artistOK ? score : 0};
  }).filter(x => x.score > 0).sort((a,b) => b.score-a.score)[0]?.t;
}
const audius = (process.env.AUDIUS_API_BASE || 'https://api.audius.co/v1').replace(/\/$/,'');
function audiusURL(route) {
  const u = new URL(audius + route);
  u.searchParams.set('app_name','XiaozhiRenderMusic');
  if (process.env.AUDIUS_API_KEY) u.searchParams.set('api_key',process.env.AUDIUS_API_KEY);
  return u;
}
async function resolveTrack(song, artist, preferred = '', options={}) {
  if(preferred==='podcast')return searchPodcast(song);
  const local = preferred ? null : select(catalog, song, artist);
  if (local) return {...local, provider:'catalog'};
  if (process.env.ENABLE_WEB_SEARCH !== 'false') {
    const track = await resolveWeb(song,artist,{...options,preferred});
    if(track) return track;
  }
  if (process.env.ENABLE_AUDIUS !== 'true') return null;
  const u = audiusURL('/tracks/search');
  u.searchParams.set('query', [song,artist].filter(Boolean).join(' '));
  u.searchParams.set('limit','20');
  const response = await fetch(u, {signal:AbortSignal.timeout(12000)});
  if (!response.ok) throw Error(`Audius search HTTP ${response.status}`);
  const data = await response.json();
  return select((data.data || []).filter(t => t.is_streamable !== false).map(t => ({id:t.id,title:t.title,artist:t.user?.name || t.user?.handle || '',duration:t.duration || 0,provider:'audius'})), song, artist);
}
async function sourceFor(track) {
  if (track.provider === 'podcast') return podcastAudio(track);
  if (track.provider === 'nct') return nctAudio(track);
  if (track.provider === 'web') return webAudio(track.source_page);
  if (track.provider === 'audius') return {url:audiusURL(`/tracks/${encodeURIComponent(track.id)}/stream`).href};
  if (track.source_file) {
    const p = path.resolve(root,track.source_file);
    if (!p.startsWith(root + path.sep) || !fs.existsSync(p)) throw Error('Catalog source_file missing or outside project');
    return {file:p};
  }
  if (track.source_url) {
    const u = new URL(track.source_url);
    if (u.protocol !== 'https:') throw Error('Catalog source_url must be HTTPS');
    return {url:u.href};
  }
  throw Error('Track has no audio source');
}
const audioCache = createAudioCache(sourceFor,rate);
// Giải phóng suất phát ngay khi socket đóng; ưu tiên robot khi trình duyệt chiếm hết suất.
const audioSessions=new Set();
function acquireAudio(req,res){
  if(res.destroyed || res.writableEnded)return null;
  const robot=/ESP32-Music-Player/i.test(req.headers['user-agent'] || '');
  const peer=String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if(robot){
    for(const session of [...audioSessions])if(session.robot && session.peer===peer){
      console.log('[AUDIO REPLACED] previous stream from same robot');session.res.destroy();session.release();
    }
    if(active>=maxStreams){
      const browser=[...audioSessions].find(session=>!session.robot);
      if(browser){console.log('[AUDIO REPLACED] browser stream; robot priority');browser.res.destroy();browser.release();}
    }
  }
  if(active>=maxStreams){json(res,429,{error:'Host busy; all audio slots occupied'});return null;}
  const session={robot,peer,res,release:null};let released=false;
  session.release=()=>{
    if(released)return;released=true;audioSessions.delete(session);active=Math.max(0,active-1);
    res.off('close',session.release);res.off('finish',session.release);res.off('error',session.release);
    res.setTimeout(0);
  };
  active++;audioSessions.add(session);
  res.once('close',session.release);res.once('finish',session.release);res.once('error',session.release);
  // Ngắt kết nối không nhận dữ liệu, kể cả trường hợp kẹt drain.
  res.setTimeout(30000,()=>{console.warn('[AUDIO IDLE CLOSED]');res.destroy();session.release();});
  return session.release;
}
async function stream(track,format,req,res) {
  if(req.method==='HEAD'){res.writeHead(200,{'Content-Type':format==='mp3'?'audio/mpeg':'application/octet-stream','Cache-Control':'no-store'});return res.end();}
  const release=acquireAudio(req,res);if(!release)return;
  const audioStarted=Date.now();
  res.once('close',()=>{
    if(!res.writableFinished)console.warn('[AUDIO CLIENT CLOSED]',JSON.stringify({title:track.title,elapsed_ms:Date.now()-audioStarted}));
  });
  try { await audioCache.serve(track,format,req,res); }
  catch(err) {
    console.error('[AUDIO]',err.message);
    if(!res.headersSent)json(res,502,{error:'Audio preparation failed; check host logs'});
    else if(!res.destroyed)res.destroy();
  } finally {release();}
}
// Trả metadata sớm; chờ nguồn/file ở luồng phát, có MP3 im lặng giữ dữ liệu.
const musicJobs=new Map(), musicJobKeys=new Map(), metadataPending=new Map();
function deadline(task,ms,message){
  let timer;
  return Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));
}
function cleanMusicJobs(){
  for(const [id,job] of musicJobs){
    if(job.state!=='pending' && job.expires<Date.now()){
      musicJobs.delete(id);if(musicJobKeys.get(job.key)===id)musicJobKeys.delete(job.key);
    }
  }
}
function startMusicJob(job){
  job.state='pending';job.error=null;job.entry=null;
  const started=Date.now();
  const work=(async()=>{
    // Metadata đã chọn YouTube nghĩa là nguồn trước không có kết quả phù hợp.
    const preferred=job.preferred || (job.metadata.site==='YouTube'?'youtube':'');
    let track=['nct','podcast'].includes(job.metadata.provider)?job.metadata:await resolveTrack(job.song,job.artist,preferred);
    if(!track)throw Error('No playable matching source');
    const prepareStarted=Date.now();
    let entry;
    try{entry=['nct','podcast'].includes(track.provider)?await audioCache.playable(track):await audioCache.prepare(track,'mp3');}
    catch(error){
      if(track.provider!=='nct')throw error;
      console.warn('[NCT FALLBACK]',error.message);
      track=await resolveTrack(job.song,job.artist,job.preferred,{skipNCT:true});
      if(!track)throw Error('NCT failed and no playable fallback');
      entry=await audioCache.prepare(track,'mp3');
    }
    return {track,entry,prepare_ms:Date.now()-prepareStarted};
  })();
  job.ready=deadline(work,180000,'Music job timed out').then(result=>{
    job.state='ready';job.track=result.track;job.entry=result.entry;job.progressive=(result.track.provider==='nct' && process.env.NCT_PROGRESSIVE!=='false') || (result.track.provider==='podcast' && process.env.PODCAST_PROGRESSIVE!=='false');job.expires=Date.now()+1800000;
    console.log('[PLAY READY]',JSON.stringify({song:job.song,site:result.track.site || result.track.provider,prepare_ms:result.prepare_ms,total_ms:Date.now()-started,job:job.id}));
    return job;
  },error=>{
    job.state='failed';job.error=error;job.expires=Date.now()+30000;
    console.error('[PLAY FAILED]',JSON.stringify({song:job.song,error:error.message,job:job.id}));
    return job;
  });
}
async function musicJob(song,artist,preferred){
  const key=[normalize(song),normalize(artist),preferred,process.env.DEFAULT_MUSIC_SOURCE || 'youtube'].join('|');
  cleanMusicJobs();
  const previous=musicJobs.get(musicJobKeys.get(key));
  if(previous?.entry?.error){previous.state='failed';previous.expires=Date.now();}
  if(previous && previous.state!=='failed')return previous;
  if(metadataPending.has(key))return metadataPending.get(key);
  const task=(async()=>{
    const local=preferred?null:select(catalog,song,artist);
    const metadata=local?{...local,provider:'catalog'}:process.env.ENABLE_WEB_SEARCH==='false'?null:
      await deadline(preferred==='podcast'?searchPodcast(song):searchMusicMetadata(song,artist,{preferred}),20000,'Metadata search timed out');
    if(!metadata)return null;
    if(musicJobs.size>=32){
      const evict=[...musicJobs.values()].find(job=>job.state!=='pending');
      if(!evict)throw Error('Music jobs busy; retry later');
      musicJobs.delete(evict.id);if(musicJobKeys.get(evict.key)===evict.id)musicJobKeys.delete(evict.key);
    }
    const job={id:randomUUID(),key,song,artist,preferred,metadata,state:'pending',expires:Date.now()+1800000};
    musicJobs.set(job.id,job);musicJobKeys.set(key,job.id);startMusicJob(job);return job;
  })();
  metadataPending.set(key,task);
  try{return await task;}finally{metadataPending.delete(key);}
}
let silentMP3;
function silence(){
  if(!silentMP3){
    silentMP3=new Promise((resolve,reject)=>{
      const child=spawn(process.env.FFMPEG_PATH || 'ffmpeg',[
        '-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i',`anullsrc=r=${rate}:cl=mono`,
        '-t','1','-c:a','libmp3lame','-b:a',`${AUDIO_BITRATE_KBPS}k`,'-write_xing','0','-id3v2_version','0','-write_id3v1','0','-f','mp3','pipe:1'
      ],{stdio:['ignore','pipe','pipe']});
      const chunks=[];let size=0,stderr='';
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Cannot prepare waiting audio'));},10000);
      child.stdout.on('data',chunk=>{size+=chunk.length;if(size>32000)child.kill('SIGKILL');else chunks.push(chunk);});
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-500);});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);code===0 && size>0 && size<=32000?resolve(Buffer.concat(chunks)):reject(Error('Waiting audio failed: '+stderr));});
    }).catch(error=>{silentMP3=null;throw error;});
  }
  return silentMP3;
}
function waitMusic(job,res,ms){
  return new Promise(resolve=>{
    const timer=setTimeout(finish,ms);
    function finish(){clearTimeout(timer);res.off('close',finish);resolve();}
    res.once('close',finish);job.ready.then(finish);
  });
}
async function writeWaiting(res,buffer){
  if(res.destroyed)throw Error('Audio client disconnected');
  if(res.write(buffer))return;
  await new Promise((resolve,reject)=>{
    function clear(){res.off('drain',drain);res.off('close',close);res.off('error',close);}
    function drain(){clear();resolve();}
    function close(){clear();reject(Error('Audio client disconnected'));}
    res.once('drain',drain);res.once('close',close);res.once('error',close);
  });
}
async function streamMusicJob(job,format,req,res){
  if(format!=='mp3')return json(res,400,{error:'Music jobs support MP3 only'});
  if(job.state==='failed')return json(res,502,{error:'Music preparation failed; check host logs'});
  if(job.state==='ready' && job.entry.error){job.state='failed';job.error=job.entry.error;return json(res,502,{error:'Audio download failed; search again'});}
  if(job.state==='ready' && !job.progressive && fs.existsSync(job.entry.file))return stream(job.track,format,req,res);
  if(job.state==='ready' && job.entry.done && fs.existsSync(job.entry.file))return stream(job.track,format,req,res);
  if(req.method==='HEAD'){
    res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'no-store','Accept-Ranges':'none'});return res.end();
  }
  const release=acquireAudio(req,res);if(!release)return;
  if(job.state==='ready' && !fs.existsSync(job.entry.file))startMusicJob(job);
  const started=Date.now();
  res.once('close',()=>{if(!res.writableFinished)console.warn('[AUDIO CLIENT CLOSED]',JSON.stringify({song:job.song,elapsed_ms:Date.now()-started}));});
  try{
    const quiet=await silence();
    if(res.destroyed)return;
    if(job.state==='ready')return await (job.progressive?audioCache.serveGrowing(job.entry,req,res):audioCache.serve(job.track,format,req,res));
    if(job.state==='failed')return json(res,502,{error:'Music preparation failed; check host logs'});
    res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'no-store','Accept-Ranges':'none','X-Audio-Sample-Rate':String(rate),'X-Audio-Channels':'1','X-Audio-Bitrate-Kbps':String(AUDIO_BITRATE_KBPS),'X-Music-Waiting':'1'});
    res.flushHeaders();
    console.log('[WAIT AUDIO]',JSON.stringify({song:job.song,job:job.id}));
    while(job.state==='pending' && !res.destroyed){await writeWaiting(res,quiet);await waitMusic(job,res,1000);}
    if(res.destroyed)return;
    if(job.state==='failed')throw job.error;
    console.log('[MUSIC START]',JSON.stringify({song:job.song,waiting_ms:Date.now()-started,job:job.id}));
    await (job.progressive?audioCache.serveGrowing(job.entry,req,res,{append:true}):audioCache.serve(job.track,format,req,res,{append:true}));
  }catch(error){
    console.error('[AUDIO JOB]',error.message);
    if(!res.headersSent)json(res,502,{error:'Music preparation failed; check host logs'});
    else if(!res.destroyed)res.destroy();
  }finally{release();}
}

function audioPath(track, format='mp3') {
  const q = new URLSearchParams({provider:track.provider,id:String(track.id),format});
  return '/audio?' + q;
}
const page = `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Xiaozhi Music Host</title><body style="font:18px system-ui;max-width:700px;margin:40px auto;padding:20px"><h1>Xiaozhi Music Host</h1><p>Tìm theo tên bài và ca sĩ, hoặc nhập Test loa để kiểm tra host.</p><form id="f"><input id="song" placeholder="Tên bài hoặc podcast HIEU.TV" required><input id="artist" placeholder="Ca sĩ"><button>Tìm và nghe</button></form><p id="status"></p><audio id="player" controls></audio><pre id="info" style="white-space:pre-wrap"></pre><script>document.querySelector('#f').onsubmit=async e=>{e.preventDefault();const s=document.querySelector('#status');s.textContent='Đang tìm và chuẩn bị nhạc…';try{const r=await fetch('/search?'+new URLSearchParams({song:document.querySelector('#song').value,artist:document.querySelector('#artist').value}));const t=await r.json();document.querySelector('#info').textContent=JSON.stringify(t,null,2);if(!r.ok)throw Error(t.error);s.textContent=t.title+' — '+t.artist;document.querySelector('#player').src=t.audio_full_url;}catch(e){s.textContent=e.message}};</script></body></html>`;
const server = http.createServer(async (req,res) => {
  try {
    const u = new URL(req.url,'http://localhost');
    if (!['GET','HEAD'].includes(req.method)) return json(res,405,{error:'GET only'});
    if (u.pathname === '/health') return json(res,200,{status:'ok',active_streams:active,mode,sample_rate:rate,audio_bitrate_kbps:AUDIO_BITRATE_KBPS,catalog_tracks:catalog.length});
    if (u.pathname === '/') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(req.method === 'HEAD' ? '' : page);}
    if (req.method === 'HEAD' && u.pathname !== '/audio') {res.writeHead(405);return res.end();}
    if (u.pathname === '/candidates') {
      const song=(u.searchParams.get('song') || '').trim(),artist=(u.searchParams.get('artist') || '').trim();
      if(!song || song.length>200 || artist.length>200)return json(res,400,{error:'Invalid song / artist'});
      return json(res,200,await searchWeb(song,artist));
    }
    if (['/stream_pcm','/search'].includes(u.pathname)) {
      const podcastQuery=parsePodcastRequest(u.searchParams.get('song') || '',u.searchParams.get('source') || u.searchParams.get('site') || '');
      let {song, artist, preferred} = parseMusicRequest(
        u.searchParams.get('song') || '',
        u.searchParams.get('artist') || u.searchParams.get('singer') || '',
        u.searchParams.get('source') || u.searchParams.get('site') || ''
      );
      if(podcastQuery!==null){song=podcastQuery;artist='';preferred='podcast';}
      if(preferred==='podcast' && (mode!=='json' || process.env.ASYNC_MUSIC_START==='false'))return json(res,400,{error:'Podcast requires RESPONSE_MODE=json and ASYNC_MUSIC_START=true'});
      if (!song || song.length > 200 || artist.length > 200) return json(res,400,{error:'Missing song or name too long'});
      console.log('[SEARCH]',JSON.stringify({song,artist,preferred,user_agent:req.headers['user-agent'],mode}));
      const searchStarted=Date.now();
      let phase='search';
      res.once('close',()=>{
        if(!res.writableFinished)console.warn('[CLIENT CLOSED]',JSON.stringify({song,phase,elapsed_ms:Date.now()-searchStarted,user_agent:req.headers['user-agent']}));
      });
      if(mode==='json' && process.env.ASYNC_MUSIC_START!=='false'){
        phase='metadata';
        const job=await musicJob(song,artist,preferred);
        if(!job)return json(res,404,{error:'Không tìm thấy thông tin bài khớp.',title:song,artist});
        if(res.destroyed)return;
        const metadata=job.state==='ready'?job.track:job.metadata;
        const p='/audio?'+new URLSearchParams({provider:'job',id:job.id,format:'mp3'});
        console.log('[AUDIO URL SENT]',JSON.stringify({song,elapsed_ms:Date.now()-searchStarted,async:true,job:job.id}));
        return json(res,200,{title:metadata.title || song,artist:metadata.artist || artist,audio_url:p,audio_full_url:base?base+p:p,m3u8_url:'',lyric_url:'',cover_url:'',duration:metadata.duration || 0,from_cache:job.state==='ready',source_page:metadata.source_page || '',site:metadata.site || metadata.provider,ip:'',preparing:job.state==='pending'});
      }
      const track = await resolveTrack(song,artist,preferred);
      if (!track) return json(res,404,{error:'Không tìm thấy bài khớp. Thêm bài vào catalog.json hoặc thử tên khác.',title:song,artist});
      if (u.pathname === '/stream_pcm' && mode !== 'json') {
        if(res.destroyed)return;
        return await stream(track,mode,req,res);
      }
      // Chuẩn bị một lần ở nền; /audio dùng cùng công việc đang chạy.
      phase='prepare';
      const readyStarted=Date.now();
      const preparing=audioCache.prepare(track,'mp3').then(()=>{
        console.log('[PLAY READY]',JSON.stringify({song,site:track.site || track.provider,prepare_ms:Date.now()-readyStarted,total_ms:Date.now()-searchStarted}));
        phase='ready';
        if(res.destroyed && !res.writableFinished)console.log('[BACKGROUND READY]',JSON.stringify({song,total_ms:Date.now()-searchStarted}));
      });
      preparing.catch(error=>console.error('[PREPARE ERROR]',JSON.stringify({song,error:error.message})));
      if(process.env.EARLY_AUDIO_URL === 'false')await preparing;
      if(res.destroyed)return;
      console.log('[AUDIO URL SENT]',JSON.stringify({song,elapsed_ms:Date.now()-searchStarted,early:process.env.EARLY_AUDIO_URL !== 'false'}));
      const p = audioPath(track);
      return json(res,200,{title:track.title,artist:track.artist,audio_url:p,audio_full_url:base ? base+p : p,m3u8_url:'',lyric_url:'',cover_url:'',duration:track.duration || 0,from_cache:track.provider==='catalog' || !!track.from_cache,source_page:track.source_page || '',site:track.site || track.provider,ip:''});
    }
    if (u.pathname === '/audio') {
      const id = u.searchParams.get('id'), provider = u.searchParams.get('provider'), format = u.searchParams.get('format') || 'mp3';
      if (!['mp3','pcm'].includes(format)) return json(res,400,{error:'format must be mp3 or pcm'});
      if(provider==='job'){
        const job=musicJobs.get(id);
        if(!job)return json(res,404,{error:'Music job expired; search again'});
        return await streamMusicJob(job,format,req,res);
      }
      let track;
      if (provider === 'catalog') {const t=catalog.find(t => String(t.id)===id); if(t) track={...t,provider};}
      else if(provider === 'web' && process.env.ENABLE_WEB_SEARCH !== 'false' && /^[A-Za-z0-9_-]{1,2000}$/.test(id || '')) {
        const page=Buffer.from(id,'base64url').toString();
        if(allowedPage(page))track={id,provider,source_page:page,title:'Web track'};
      }
      else if(provider==='nct' && process.env.ENABLE_NCT!=='false' && /^[a-zA-Z0-9_-]{1,100}$/.test(id || '')) track={id,provider,title:'NhạcCủaTui track'};
      else if (provider === 'audius' && process.env.ENABLE_AUDIUS === 'true' && /^[a-zA-Z0-9_-]{1,100}$/.test(id || '')) track={id,provider,title:id};
      if (!track) return json(res,404,{error:'Unknown track'});
      return await stream(track,format,req,res);
    }
    json(res,404,{error:'Unknown endpoint'});
  } catch(err) {console.error('[REQUEST]',err.message);if(!res.headersSent)json(res,502,{error:'Music search failed; check host logs / Audius configuration'});else res.destroy();}
});
server.listen(Number(process.env.PORT || 10000),'0.0.0.0',() => console.log(`Music host listening; mode=${mode}; rate=${rate}; bitrate=${AUDIO_BITRATE_KBPS}kbps`));
