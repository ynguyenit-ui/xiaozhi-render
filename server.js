import http from 'node:http';
import { createAudioCache } from './audio-cache.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWeb, webAudio, searchWeb, allowedPage, parseMusicRequest } from './providers.js';

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
async function resolveTrack(song, artist, preferred = '') {
  const local = preferred ? null : select(catalog, song, artist);
  if (local) return {...local, provider:'catalog'};
  if (process.env.ENABLE_WEB_SEARCH !== 'false') {
    const track = await resolveWeb(song,artist,{preferred});
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
async function stream(track,format,req,res) {
  if(active >= maxStreams)return json(res,429,{error:'Host busy; retry shortly'});
  active++;
  try { await audioCache.serve(track,format,req,res); }
  catch(err) {
    console.error('[AUDIO]',err.message);
    if(!res.headersSent)json(res,502,{error:'Audio preparation failed; check host logs'});
    else if(!res.destroyed)res.destroy();
  } finally {active--;}
}
function audioPath(track, format='mp3') {
  const q = new URLSearchParams({provider:track.provider,id:String(track.id),format});
  return '/audio?' + q;
}
const page = `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Xiaozhi Music Host</title><body style="font:18px system-ui;max-width:700px;margin:40px auto;padding:20px"><h1>Xiaozhi Music Host</h1><p>Tìm theo tên bài và ca sĩ, hoặc nhập Test loa để kiểm tra host.</p><form id="f"><input id="song" placeholder="Tên bài hát" required><input id="artist" placeholder="Ca sĩ"><button>Tìm và nghe</button></form><p id="status"></p><audio id="player" controls></audio><pre id="info" style="white-space:pre-wrap"></pre><script>document.querySelector('#f').onsubmit=async e=>{e.preventDefault();const s=document.querySelector('#status');s.textContent='Đang tìm và chuẩn bị nhạc…';try{const r=await fetch('/search?'+new URLSearchParams({song:document.querySelector('#song').value,artist:document.querySelector('#artist').value}));const t=await r.json();document.querySelector('#info').textContent=JSON.stringify(t,null,2);if(!r.ok)throw Error(t.error);s.textContent=t.title+' — '+t.artist;document.querySelector('#player').src=t.audio_full_url;}catch(e){s.textContent=e.message}};</script></body></html>`;
const server = http.createServer(async (req,res) => {
  try {
    const u = new URL(req.url,'http://localhost');
    if (!['GET','HEAD'].includes(req.method)) return json(res,405,{error:'GET only'});
    if (u.pathname === '/health') return json(res,200,{status:'ok',active_streams:active,mode,sample_rate:rate,catalog_tracks:catalog.length});
    if (u.pathname === '/') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(req.method === 'HEAD' ? '' : page);}
    if (req.method === 'HEAD' && u.pathname !== '/audio') {res.writeHead(405);return res.end();}
    if (u.pathname === '/candidates') {
      const song=(u.searchParams.get('song') || '').trim(),artist=(u.searchParams.get('artist') || '').trim();
      if(!song || song.length>200 || artist.length>200)return json(res,400,{error:'Invalid song / artist'});
      return json(res,200,await searchWeb(song,artist));
    }
    if (['/stream_pcm','/search'].includes(u.pathname)) {
      const {song, artist, preferred} = parseMusicRequest(
        u.searchParams.get('song') || '',
        u.searchParams.get('artist') || u.searchParams.get('singer') || '',
        u.searchParams.get('source') || u.searchParams.get('site') || ''
      );
      if (!song || song.length > 200 || artist.length > 200) return json(res,400,{error:'Missing song or name too long'});
      console.log('[SEARCH]',JSON.stringify({song,artist,preferred,user_agent:req.headers['user-agent'],mode}));
      const searchStarted=Date.now();
      const track = await resolveTrack(song,artist,preferred);
      if (!track) return json(res,404,{error:'Không tìm thấy bài khớp. Thêm bài vào catalog.json hoặc thử tên khác.',title:song,artist});
      if (res.destroyed) return;
      if (u.pathname === '/stream_pcm' && mode !== 'json') return await stream(track,mode,req,res);
      const readyStarted=Date.now();
      await audioCache.prepare(track,'mp3');
      console.log('[PLAY READY]',JSON.stringify({song,site:track.site || track.provider,prepare_ms:Date.now()-readyStarted,total_ms:Date.now()-searchStarted}));
      if(res.destroyed)return;
      const p = audioPath(track);
      return json(res,200,{title:track.title,artist:track.artist,audio_url:p,audio_full_url:base ? base+p : p,m3u8_url:'',lyric_url:'',cover_url:'',duration:track.duration || 0,from_cache:track.provider==='catalog' || !!track.from_cache,source_page:track.source_page || '',site:track.site || track.provider,ip:''});
    }
    if (u.pathname === '/audio') {
      const id = u.searchParams.get('id'), provider = u.searchParams.get('provider'), format = u.searchParams.get('format') || 'mp3';
      if (!['mp3','pcm'].includes(format)) return json(res,400,{error:'format must be mp3 or pcm'});
      let track;
      if (provider === 'catalog') {const t=catalog.find(t => String(t.id)===id); if(t) track={...t,provider};}
      else if(provider === 'web' && process.env.ENABLE_WEB_SEARCH !== 'false' && /^[A-Za-z0-9_-]{1,2000}$/.test(id || '')) {
        const page=Buffer.from(id,'base64url').toString();
        if(allowedPage(page))track={id,provider,source_page:page,title:'Web track'};
      }
      else if (provider === 'audius' && process.env.ENABLE_AUDIUS === 'true' && /^[a-zA-Z0-9_-]{1,100}$/.test(id || '')) track={id,provider,title:id};
      if (!track) return json(res,404,{error:'Unknown track'});
      return await stream(track,format,req,res);
    }
    json(res,404,{error:'Unknown endpoint'});
  } catch(err) {console.error('[REQUEST]',err.message);if(!res.headersSent)json(res,502,{error:'Music search failed; check host logs / Audius configuration'});else res.destroy();}
});
server.listen(Number(process.env.PORT || 10000),'0.0.0.0',() => console.log(`Music host listening; mode=${mode}; rate=${rate}`));
