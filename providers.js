// NhạcCủaTui MP3 trực tiếp; giữ các nguồn dự phòng.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const normalize = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function setting(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
export function parseMusicRequest(song, artist = '', source = '') {
  let title = String(song || '').trim();
  let preferred = /^(youtube|yt|youtube\.com)$/i.test(source) ? 'youtube' : '';
  const suffix = /\s+(?:trên|tren|từ|tu|on|from)\s+youtube(?:\.com)?\s*[.!?]*$/i;
  const prefix = /^youtube(?:\.com)?\s*:\s*/i;
  const hasQualifier = suffix.test(title) || prefix.test(title);
  if (hasQualifier) {
    preferred = 'youtube';
    title = title.replace(suffix, '').replace(prefix, '').trim();
  }
  const command = hasQualifier
    ? /^(?:hãy\s+)?(?:tìm kiếm|tim kiem|tìm|tim|kiếm|kiem|phát|phat|mở|mo)(?:\s+(?:bài hát|bai hat|bài|bai|nhạc|nhac))?\s+/i
    : /^(?:hãy\s+)?(?:tìm kiếm|tim kiem|tìm|tim|kiếm|kiem|phát|phat|mở|mo)\s+(?:bài hát|bai hat|bài|bai|nhạc|nhac)\s+/i;
  title = title.replace(command, '').trim();
  return { song: title, artist: String(artist || '').trim(), preferred };
}
const domains=['youtube.com','zingmp3.vn','nhaccuatui.com','audius.co','archive.org','soundcloud.com'];
export function allowedPage(page) {
  try {const u=new URL(page);return u.protocol==='https:' && !u.username && !u.password && (!u.port || u.port==='443') && domains.some(d=>u.hostname===d || u.hostname.endsWith('.'+d));}catch{return false;}
}
export function rank(candidates,song,artist='') {
  const wanted=normalize(song), singer=normalize(artist), tokens=wanted.split(' ').filter(Boolean);
  const versions=['remix','cover','karaoke','instrumental','sped up','slowed','live','mashup','ambient edit'];
  return candidates.filter(t=>allowedPage(t.source_page)).map(t=>{
    const title=normalize(t.title), all=normalize(t.title+' '+(t.artist || ''));
    const overlap=tokens.filter(w=>title.split(' ').includes(w)).length/Math.max(tokens.length,1);
    const artistMatch=!singer || singer.split(' ').filter(Boolean).every(w=>all.split(' ').includes(w));
    let score=overlap*100+(title.includes(wanted)?40:0)+(singer?(artistMatch?35:-60):0);
    for(const v of versions)if(title.includes(v) && !wanted.includes(v))score-=65;
    if(/official|chinh thuc/.test(title))score+=8;
    if(t.duration && (t.duration<60 || t.duration>900))score-=50;
    return {...t,score:Math.round(score),overlap,artistMatch};
  }).filter(t=>t.overlap>=0.75 && t.artistMatch && t.score>=90).sort((a,b)=>b.score-a.score);
}
// API đang được website NCT sử dụng; không cần key, chỉ chọn nguồn công khai.
const nctSearchCache=new Map(), nctPending=new Map();
function nctURL(value){
  try{const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password && !u.port && (u.hostname==='nct.vn' || u.hostname.endsWith('.nct.vn'));}catch{return false;}
}
function nctExpiry(url){
  const expiry=Number(new URL(url).searchParams.get('e'));
  return expiry>0?expiry*1000-60000:Date.now()+120000;
}
function nctTrack(row){
  const streams=(row.streamURL || []).filter(x=>x.onlyVIP===false && Number(x.status)===1 && nctURL(x.stream));
  const source=streams.find(x=>String(x.type)==='128') || streams.find(x=>String(x.type)==='320');
  if(Number(row.statusPlay)!==1 || !source || !/^[A-Za-z0-9_-]{1,100}$/.test(row.key || ''))return null;
  return {id:row.key,provider:'nct',site:'NhạcCủaTui',title:row.name,artist:row.artistName || '',duration:Number(row.duration)||0,
    source_page:'https://www.nhaccuatui.com/song/'+row.key,nct_source:source.stream,nct_expires:nctExpiry(source.stream)};
}
async function nctRequest(route,body){
  const response=await fetch('https://graph.nhaccuatui.com/api/v1/'+route,{
    method:body?'POST':'GET',headers:{Accept:'application/json','Content-Type':'application/json',Referer:'https://www.nhaccuatui.com/'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(setting('NCT_SEARCH_TIMEOUT_MS',15000,1000,20000))
  });
  if(!response.ok)throw Error('NCT HTTP '+response.status);
  const data=await response.json();if(Number(data.code)!==0)throw Error('NCT API unavailable');return data.data;
}
export async function searchNCT(song,artist=''){
  const key=normalize(song)+'|'+normalize(artist),cached=nctSearchCache.get(key);
  if(cached && cached.expires>Date.now())return cached.tracks;
  if(nctPending.has(key))return nctPending.get(key);
  const task=(async()=>{
    const keyword=[song,artist].filter(Boolean).join(' '),query=new URLSearchParams({keyword,pageindex:'1',pagesize:'5',correct:'false'});
    const data=await nctRequest('search/song?'+query,{keyword,pageindex:1,pagesize:5});
    const tracks=rank((data?.songs || []).map(nctTrack).filter(Boolean),song,artist);
    if(nctSearchCache.size>=100)nctSearchCache.delete(nctSearchCache.keys().next().value);
    nctSearchCache.set(key,{tracks,expires:Math.min(Date.now()+(tracks.length?180000:10000),...tracks.map(t=>t.nct_expires))});
    console.log('[NCT SEARCH]',JSON.stringify({song,matched:tracks.length}));return tracks;
  })();
  nctPending.set(key,task);try{return await task;}finally{nctPending.delete(key);}
}
export async function nctAudio(track){
  let selected=track;
  if(!nctURL(track.nct_source) || !(track.nct_expires>Date.now())){
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(track.id || ''))throw Error('Invalid NCT id');
    const data=await nctRequest('song/detail/'+encodeURIComponent(track.id));
    selected=nctTrack(data?.song || data);
    if(!selected)throw Error('NCT track has no public MP3');
  }
  return {url:selected.nct_source,headers:{Referer:'https://www.nhaccuatui.com/'}};
}
function musicOrder(preferred,skipNCT=false){
  const defaults=process.env.DEFAULT_MUSIC_SOURCE || 'nhaccuatui';
  const first=preferred==='youtube'?'YouTube':defaults==='soundcloud'?'SoundCloud':defaults==='youtube'?'YouTube':'NhạcCủaTui';
  return [first,...['NhạcCủaTui','YouTube','SoundCloud','Audius / Internet Archive'].filter(x=>x!==first)]
    .filter(x=>x!=='NhạcCủaTui' || (!skipNCT && process.env.ENABLE_NCT!=='false'));
}
async function getJSON(url) {
  const r=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();
}
const text=v=>Array.isArray(v)?v.join(', '):String(v || '');
function audioURL(id) {
  const u=new URL(`https://api.audius.co/v1/tracks/${encodeURIComponent(id)}/stream`);
  u.searchParams.set('app_name','XiaozhiKeylessMusic');return u.href;
}
async function searchAudius(song,artist) {
  const u=new URL('https://api.audius.co/v1/tracks/search');
  u.searchParams.set('query',[song,artist].filter(Boolean).join(' '));
  u.searchParams.set('limit','15');u.searchParams.set('app_name','XiaozhiKeylessMusic');
  const d=await getJSON(u);
  return (d.data || []).filter(t=>t.is_streamable!==false && /^[A-Za-z0-9_-]+$/.test(t.id)).map(t=>({title:t.title,artist:t.user?.name || t.user?.handle || '',duration:t.duration || 0,provider:'web',site:'Audius',source_page:`https://audius.co/tracks/${t.id}`}));
}
function duration(v) {
  if(!v)return 0;return String(v).includes(':')?String(v).split(':').reduce((a,n)=>a*60+Number(n),0):Number(v) || 0;
}
const searchCache=new Map();
async function searchArchive(song,artist) {
  const safe=s=>String(s).replace(/["\\]/g,' ').trim();
  const q=`mediatype:audio AND (title:"${safe(song)}" OR title:"${safe(normalize(song))}")`;
  const u=new URL('https://archive.org/advancedsearch.php');
  u.searchParams.set('q',q);u.searchParams.set('output','json');u.searchParams.set('rows','5');
  for(const f of ['identifier','title','creator'])u.searchParams.append('fl[]',f);
  const d=await getJSON(u), docs=d.response?.docs || [];
  const outcomes=await Promise.allSettled(docs.map(async doc=>{
    const m=await getJSON('https://archive.org/metadata/'+encodeURIComponent(doc.identifier));
    if(m.is_dark || m.metadata?.['access-restricted-item']==='true')return [];
    const mp3=(m.files || []).filter(f=>f.name?.toLowerCase().endsWith('.mp3') && !f.private && !f.is_private);
    return mp3.map(f=>({title:text(f.title) || (mp3.length===1?text(doc.title):f.name.replace(/\.mp3$/i,'').replace(/[_-]/g,' ')),artist:text(f.artist || doc.creator || m.metadata?.creator),duration:duration(f.length),provider:'web',site:'Internet Archive',source_page:`https://archive.org/download/${encodeURIComponent(doc.identifier)}/${f.name.split('/').map(encodeURIComponent).join('/')}`}));
  }));
  const candidates=outcomes.flatMap(r=>r.status==='fulfilled'?r.value:[]);
  if(docs.length && outcomes.every(r=>r.status==='rejected'))throw Error('Archive metadata requests failed');
  return candidates;
}
const extractCache = new Map();
const extractPending = new Map();

async function extract(target, flat = false) {
  const key = (flat ? 'search:' : 'audio:') + target;
  const cached = extractCache.get(key);
  if (cached && cached.expires > Date.now()) {
    console.log('[CACHE]', flat ? 'Search hit' : 'Audio link hit');
    return cached.data;
  }
  extractCache.delete(key);
  if (extractPending.has(key)) return extractPending.get(key);

  const task = (async () => {
    const data = await extractUncached(target, flat);
    let ttl = flat ? ((data.entries || []).length ? 300000 : 60000) : setting('AUDIO_LINK_CACHE_MS', 1800000, 90000, 3600000);
    if (!flat) {
      if (data.is_live || data.has_drm || !/^https?:\/\//.test(data.url || '')) {
        return data;
      }
      // Signed audio URLs may expire sooner than the cache.
      const u = new URL(data.url);
      for (const name of ['expire', 'expires', 'Expires']) {
        const seconds = Number(u.searchParams.get(name));
        if (seconds > 0) ttl = Math.min(ttl, seconds * 1000 - Date.now() - 15000);
      }
    }
    if (ttl > 0) {
      if (extractCache.size >= 100) {
        extractCache.delete(extractCache.keys().next().value);
      }
      extractCache.set(key, { data, expires: Date.now() + ttl });
    }
    return data;
  })();

  extractPending.set(key, task);
  try {
    return await task;
  } finally {
    extractPending.delete(key);
  }
}

let jobs=0;
function prepareYouTubeCookies(target) {
  const configured = process.env.YOUTUBE_COOKIES_FILE;
  const youtube = /^https:\/\/(?:[^/]+\.)?youtube\.com\//i.test(target) || target.startsWith('ytsearch');
  if (!configured || !youtube) return null;
  function failure(code, message) {
    const e = Error(message); e.code = code; return e;
  }
  let data;
  try {
    data = fs.readFileSync(configured, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      throw failure('SOURCE_COOKIE_MISSING', 'YouTube Secret File not found; check filename and YOUTUBE_COOKIES_FILE');
    }
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      throw failure('SOURCE_COOKIE_PERMISSION', 'Host user cannot read YouTube Secret File');
    }
    throw failure('SOURCE_COOKIE_READ', 'Cannot read YouTube Secret File');
  }
  data = data.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimStart();
  const lines = data.split('\n');
  if (!/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)$/.test(lines[0].trim())) {
    throw failure('SOURCE_COOKIE_FORMAT', 'Cookie file must be Netscape text, not JSON or a Cookie header');
  }
  const rows = lines.filter(line => line.trim() && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map(line => line.split('\t'));
  if (!rows.length || rows.some(row => row.length < 7 || !row[0] || !row[5] || !Number.isFinite(Number(row[4])))) {
    throw failure('SOURCE_COOKIE_ROWS', 'Cookie file needs complete tab-separated Netscape rows; export again');
  }
  const youtubeRows = rows.filter(row => {
    const domain = row[0].replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase();
    return domain === 'youtube.com' || domain.endsWith('.youtube.com');
  });
  if (!youtubeRows.length) {
    throw failure('SOURCE_COOKIE_SCOPE', 'Cookie file has no youtube.com cookies');
  }
  let directory;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaozhi-yt-'));
    const file = path.join(directory, 'cookies.txt');
    fs.writeFileSync(file, data, { mode: 0o600 });
    if (process.env.DEBUG_EXTRACTOR === 'true') {
      console.log('[YOUTUBE AUTH]', JSON.stringify({ loaded: true, youtube_rows: youtubeRows.length }));
    }
    return { file, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch {
    if (directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} }
    throw failure('SOURCE_COOKIE_TEMP', 'Cannot create private temporary YouTube cookie jar');
  }
}

function extractUncached(target, flat = false) {
  if (jobs >= 2) return Promise.reject(Error('Extractor busy'));
  let cookieJar;
  try { cookieJar = prepareYouTubeCookies(target); }
  catch (e) { return Promise.reject(e); }
  jobs++;
  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'yt_dlp', '--ignore-config', '--no-warnings',
      '--no-playlist', '--socket-timeout', '8', '--retries', '0',
      '--extractor-retries', '0',
      '--skip-download', '--dump-single-json'
    ];
    if (flat && target.startsWith('scsearch') && process.env.SC_SKIP_THUMBNAILS !== 'false') {
      // SoundCloud flat search vẫn kiểm tra ảnh bằng HEAD; host không dùng thumbnail.
      // Chỉ thay cách chạy tiến trình này, không sửa package yt-dlp trên đĩa.
      const script = [
        'from yt_dlp import main',
        'from yt_dlp.extractor.soundcloud import SoundcloudBaseIE',
        'SoundcloudBaseIE._extract_thumbnails = lambda self, info: []',
        'main()'
      ].join('\n');
      args.splice(0, 2, '-c', script);
    }
    if (cookieJar) args.push('--cookies', cookieJar.file);
    const started = Date.now();
    if (process.env.DEBUG_EXTRACTOR === 'true') args.push('--verbose');
    if (/^https:\/\/(?:[^/]+\.)?youtube\.com\//i.test(target) || target.startsWith('ytsearch')) {
      args.push('--js-runtimes', process.env.YOUTUBE_JS_RUNTIME || 'node');
      if (!flat) args.push('-S', 'abr:' + setting('YOUTUBE_SOURCE_ABR', 128, 64, 192));
    }
    if (flat) args.push('--flat-playlist');
    else args.push('-f', 'bestaudio[protocol=https]/bestaudio[protocol=http]/best[protocol=https]/best[protocol=http]');
    args.push('--', target);
    const p = spawn(process.env.PYTHON_PATH || 'python3', args, {
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'
    });
    function stopExtractor() {
      // Dừng cả runtime JS con khi extractor hết giờ, tránh để lại tiến trình chiếm CPU.
      if (process.platform !== 'win32' && p.pid) {
        try {process.kill(-p.pid, 'SIGKILL'); return;} catch {}
      }
      p.kill('SIGKILL');
    }
    let out = '', err = '', done = false;
    const timeout = flat
      ? setting('SC_SEARCH_TIMEOUT_MS', 8000, 1000, 30000)
      : setting('AUDIO_EXTRACT_TIMEOUT_MS', 60000, 1000, 90000);
    const timer = setTimeout(() => {
      stopExtractor();
      const e = Error('Extractor timeout'); e.code = 'SOURCE_TIMEOUT';
      finish(e);
    }, timeout);
    function finish(e, data) {
      if (done) return;
      done = true; clearTimeout(timer); jobs--;
      try { cookieJar?.cleanup(); } catch {}
      if (e) {
        if (process.env.DEBUG_EXTRACTOR === 'true') {
          const detail = err
            .split('\n')
            .map(line => /authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token/i.test(line)
              ? '[REDACTED]' : line)
            .join('\n')
            .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
            .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
            .slice(-2000);
          console.warn('[EXTRACT DETAIL]', JSON.stringify({
            site: /youtube|ytsearch/i.test(target) ? 'YouTube' : 'SoundCloud',
            stage: flat ? 'search' : 'audio',
            ms: Date.now() - started,
            code: e.code || 'EXTRACT_FAILED',
            detail: detail || 'No stderr before extractor ended'
          }));
        }
        reject(e);
      } else {
        console.log('[EXTRACT READY]', JSON.stringify({site:/youtube|ytsearch/i.test(target)?'YouTube':'SoundCloud',stage:flat?'search':'audio',ms:Date.now()-started}));
        resolve(data);
      }
    }
    p.stdout.on('data', d => {
      out += d;
      if (out.length > 4000000) { stopExtractor(); finish(Error('Output too large')); }
    });
    p.stderr.on('data', d => { err = (err + d).slice(-16000); });
    p.once('error', e => finish(e));
    p.once('close', c => {
      if (c !== 0) {
        let e;
        if (/sign in|log in|confirm.*bot|not a bot|429/i.test(err)) {
          e = Error('Provider blocked or needs login'); e.code = 'SOURCE_BLOCKED';
        } else if (/403|forbidden/i.test(err)) {
          e = Error('Provider HTTP 403: audio access denied'); e.code = 'SOURCE_FORBIDDEN';
        } else if (/javascript|js runtime|challenge|nsig/i.test(err)) {
          e = Error('YouTube JS runtime/challenge failed'); e.code = 'SOURCE_RUNTIME';
        } else {
          e = Error('Provider extraction failed');
        }
        return finish(e);
      }
      try { finish(null, JSON.parse(out)); }
      catch { finish(Error('Invalid provider response')); }
    });
  });
}
export async function webAudio(page) {
  if(!allowedPage(page))throw Error('Unsupported source');const u=new URL(page);
  if(u.hostname==='archive.org' && /^\/download\/[^/]+\/.+\.mp3$/i.test(u.pathname))return {url:page};
  if(u.hostname==='audius.co' && /^\/tracks\/[A-Za-z0-9_-]+$/.test(u.pathname))return {url:audioURL(u.pathname.split('/').at(-1))};
  const d=await extract(page);
  if(d.is_live || d.has_drm || !/^https?:\/\//.test(d.url || ''))throw Error('No public direct audio');
  return {url:d.url,headers:d.http_headers || {}};
}
export async function searchWeb(song,artist='') {
  const key=normalize(song)+'|'+normalize(artist);
  const cached=searchCache.get(key);if(cached && cached.expires>Date.now())return cached.result;
  const outcomes=await Promise.allSettled([searchAudius(song,artist),searchArchive(song,artist)]), candidates=[],errors=[];
  for(let i=0;i<outcomes.length;i++) {
    const r=outcomes[i];if(r.status==='fulfilled')candidates.push(...r.value);else errors.push({site:i===0?'Audius':'Internet Archive',error:r.reason.message});
  }
  // Optional: YouTube was blocked on this user's Render service, so default off.
  if(process.env.KEYLESS_YOUTUBE==='true') {
    try{const d=await extract('ytsearch8:'+[song,artist].filter(Boolean).join(' '),true);for(const t of d.entries || [])candidates.push({title:t.title,artist:t.uploader || t.channel || '',duration:t.duration,provider:'web',site:'YouTube',source_page:'https://www.youtube.com/watch?v='+t.id});}catch(e){errors.push({site:'YouTube',error:e.message});}
  }
  const result={search_mode:'keyless-audius-archive',candidates:rank([...new Map(candidates.map(t=>[t.source_page,t])).values()],song,artist),errors};
  if(!errors.length){if(searchCache.size>=100)searchCache.delete(searchCache.keys().next().value);searchCache.set(key,{result,expires:Date.now()+300000});}
  return result;
}
async function probeUncached(source) {
  const r=await fetch(source.url,{headers:{...(source.headers || {}),Range:'bytes=0-1023'},signal:AbortSignal.timeout(setting('AUDIO_PROBE_TIMEOUT_MS', 4000, 1000, 15000)),redirect:'follow'});
  const type=r.headers.get('content-type') || '';
  if(!r.ok || !r.body || /json|text\/html/i.test(type)){await r.body?.cancel();throw Error(`Audio unavailable: HTTP ${r.status}`);}
  const reader=r.body.getReader();
  try{const {value,done}=await reader.read();if(done || !value?.length)throw Error('Empty audio');}finally{await reader.cancel().catch(()=>{});}
}
async function probe(source) {
  try {
    return await probeUncached(source);
  } catch (e) {
    // Discard a cached link if the audio check fails.
    for (const [key, entry] of extractCache) {
      if (!key.startsWith('audio:')) continue;
      if (entry.data.url === source.url) extractCache.delete(key);
    }
    throw e;
  }
}

async function searchSoundCloud(song, artist = '') {
  const data = await extract(
    'scsearch8:' + [song, artist].filter(Boolean).join(' '),
    true
  );
  const tracks = (data.entries || []).map(t => ({
    title: t.title || '',
    artist: (t.artists || []).join(', ') || t.uploader || '',
    duration: t.duration || 0,
    provider: 'web',
    site: 'SoundCloud',
    source_page: t.webpage_url || t.url || ''
  }));
  return rank(tracks, song, artist);
}

const youtubeCache = new Map();
async function searchYouTubeAPI(song, artist = '') {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw Error('Set YOUTUBE_API_KEY');
  const key = normalize(song) + '|' + normalize(artist);
  const cached = youtubeCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.tracks;
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  for (const [name, value] of Object.entries({
    part: 'snippet', type: 'video', maxResults: '8',
    q: [song, artist].filter(Boolean).join(' '),
    relevanceLanguage: 'vi', regionCode: 'VN', key: apiKey
  })) u.searchParams.set(name, value);
  let data;
  try { data = await getJSON(u); }
  catch { throw Error('YouTube API failed: check key, restrictions or quota'); }
  const tracks = rank((data.items || [])
    .filter(t => /^[A-Za-z0-9_-]{11}$/.test(t.id?.videoId || '') &&
      t.snippet?.liveBroadcastContent !== 'live' &&
      t.snippet?.liveBroadcastContent !== 'upcoming')
    .map(t => ({
      title: t.snippet?.title || '', artist: t.snippet?.channelTitle || '',
      duration: 0, provider: 'web', site: 'YouTube',
      source_page: 'https://www.youtube.com/watch?v=' + t.id.videoId
    })), song, artist);
  if (youtubeCache.size >= 100) youtubeCache.delete(youtubeCache.keys().next().value);
  youtubeCache.set(key, { tracks, expires: Date.now() + 1800000 });
  return tracks;
}

const resolvedCache = new Map();
const resolvedPending = new Map();
const failedAudio = new Map();
const blockedUntil = new Map();

export async function resolveWeb(song, artist = '', options = {}) {
  const request = parseMusicRequest(song, artist, options.preferred || options.source || '');
  const key = normalize(request.song) + '|' + normalize(request.artist) + '|' + request.preferred + '|' + !!options.skipNCT;
  const cached = resolvedCache.get(key);
  if (cached && cached.expires > Date.now()) {
    console.log('[SEARCH CACHE]', request.song, cached.track.site);
    return { ...cached.track, from_cache: true };
  }
  resolvedCache.delete(key);
  if (resolvedPending.has(key)) return resolvedPending.get(key);
  const task = resolveFresh({...request,skipNCT:!!options.skipNCT}).then(track => {
    if (track) {
      if (resolvedCache.size >= 100) resolvedCache.delete(resolvedCache.keys().next().value);
      resolvedCache.set(key, { track, expires: Date.now() + 1800000 });
    }
    return track;
  });
  resolvedPending.set(key, task);
  try { return await task; }
  finally { resolvedPending.delete(key); }
}

async function resolveFresh({ song, artist, preferred, skipNCT }) {
  const started = Date.now(), errors = [];
  if (!song) return null;
  const enabledSC = process.env.ENABLE_SOUNDCLOUD !== 'false';
  const enabledYT = process.env.ENABLE_YOUTUBE === 'true';
  const youtubeFirst = preferred === 'youtube' || process.env.DEFAULT_MUSIC_SOURCE !== 'soundcloud';
  const order = musicOrder(preferred,skipNCT);
  const searches = new Map();
  const functions = {
    'NhạcCủaTui': () => searchNCT(song,artist),
    SoundCloud: () => searchSoundCloud(song, artist),
    YouTube: () => searchYouTubeAPI(song, artist),
    'Audius / Internet Archive': async () => {
      const r = await searchWeb(song, artist);
      errors.push(...r.errors);
      return r.candidates.filter(t => t.site === 'Audius' || t.site === 'Internet Archive');
    }
  };
  function start(site) {
    if (!searches.has(site)) {
      // Both success and failure are handled immediately for speculative searches.
      searches.set(site, Promise.resolve().then(functions[site]).then(
        candidates => ({ candidates }), error => ({ error })
      ));
    }
    return searches.get(site);
  }
  // Chỉ tìm song song khi người dùng đặt lại mặc định SoundCloud.
  if (!youtubeFirst && process.env.PARALLEL_SEARCH !== 'false') {
    if (enabledSC) start('SoundCloud');
    if (enabledYT && (blockedUntil.get('YouTube') || 0) <= Date.now()) start('YouTube');
  }
  console.log('[SEARCH ORDER]', order.join(' -> '));
  for (const site of order) {
    if (site === 'SoundCloud' && !enabledSC) continue;
    if (site === 'YouTube' && !enabledYT) continue;
    if ((blockedUntil.get(site) || 0) > Date.now()) {
      console.warn('[SOURCE SKIP]', site, 'Temporary cooldown after login/bot block');
      continue;
    }
    const sourceStarted = Date.now();
    console.log('[SEARCH SOURCE] Trying ' + site + ':', song);
    const outcome = await start(site);
    if (outcome.error) {
      errors.push({ site, error: outcome.error.message });
      console.warn('[SOURCE ERROR]', site, outcome.error.message);
      continue;
    }
    const candidates = outcome.candidates;
    console.log('[SOURCE RESULTS]', site, 'matched=' + candidates.length);
    if (!candidates.length) errors.push({ site, error: 'No matching track' });
    for (const t of candidates.slice(0, setting('SOURCE_CANDIDATES', 2, 1, 3))) {
      if ((failedAudio.get(t.source_page) || 0) > Date.now()) continue;
      try {
        if(t.provider==='nct')return {...t,from_cache:false};
        await probe(await webAudio(t.source_page));
        console.log('[SEARCH DONE]', JSON.stringify({ song, site: t.site, ms: Date.now() - started }));
        return { ...t, id: Buffer.from(t.source_page).toString('base64url'), from_cache: false };
      } catch (e) {
        if (failedAudio.size >= 100) failedAudio.delete(failedAudio.keys().next().value);
        if (!/busy/i.test(e.message) && !String(e.code || '').startsWith('SOURCE_COOKIE_')) {
          failedAudio.set(t.source_page, Date.now() + 30000);
        }
        errors.push({ site: t.site || site, error: e.message });
        console.warn('[SOURCE ERROR]', site, e.code || 'AUDIO_FAILED', e.message);
        if (e.code === 'SOURCE_BLOCKED') {
          blockedUntil.set(site, Date.now() + 120000);
          break;
        }
        if (e.code === 'SOURCE_FORBIDDEN' || e.code === 'SOURCE_RUNTIME' || String(e.code || '').startsWith('SOURCE_COOKIE_')) break;
      }
    }
    console.log('[SEARCH SOURCE DONE]', site, Date.now() - sourceStarted, 'ms');
  }
  console.warn('[PROVIDERS]', JSON.stringify(errors));
  console.log('[SEARCH DONE]', JSON.stringify({ song, found: false, ms: Date.now() - started }));
  return null;
}
// Tìm metadata, chưa lấy link audio hoặc kiểm tra nguồn phát.
export async function searchMusicMetadata(song, artist='', options={}) {
  const request=parseMusicRequest(song,artist,options.preferred || options.source || '');
  const youtubeFirst=request.preferred==='youtube' || process.env.DEFAULT_MUSIC_SOURCE!=='soundcloud';
  const order=musicOrder(request.preferred);
  const functions={
    'NhạcCủaTui':()=>searchNCT(request.song,request.artist),
    YouTube:()=>searchYouTubeAPI(request.song,request.artist),
    SoundCloud:()=>searchSoundCloud(request.song,request.artist),
    'Audius / Internet Archive':async()=>{
      const result=await searchWeb(request.song,request.artist);
      return result.candidates.filter(t=>t.site==='Audius' || t.site==='Internet Archive');
    }
  };
  const pending=new Map();
  function start(site){
    if(!pending.has(site))pending.set(site,Promise.resolve().then(functions[site]).then(candidates=>({candidates}),error=>({error})));
    return pending.get(site);
  }
  if(!youtubeFirst && process.env.PARALLEL_SEARCH!=='false' && process.env.ENABLE_YOUTUBE==='true')start('YouTube');
  console.log('[METADATA ORDER]',order.join(' -> '));
  for(const site of order){
    if(site==='YouTube' && process.env.ENABLE_YOUTUBE!=='true')continue;
    if(site==='SoundCloud' && process.env.ENABLE_SOUNDCLOUD==='false')continue;
    if((blockedUntil.get(site) || 0)>Date.now())continue;
    const outcome=await start(site);
    if(outcome.error){console.warn('[METADATA ERROR]',site,outcome.error.message);continue;}
    const first=outcome.candidates[0];
    if(first){
      console.log('[METADATA FOUND]',JSON.stringify({song:request.song,site,title:first.title}));
      return {...first,id:first.provider==='nct'?first.id:Buffer.from(first.source_page).toString('base64url')};
    }
  }
  return null;
}
