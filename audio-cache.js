// Cache hoàn chỉnh cho nguồn cũ; NCT có thể phát trong khi ghi cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
function number(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
export function createAudioCache(sourceFor, rate) {
  const directory = process.env.AUDIO_CACHE_DIR || path.join(os.tmpdir(), 'xiaozhi-audio-v2');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ttl = number('AUDIO_CACHE_TTL_SECONDS', 21600, 60, 86400) * 1000;
  const budget = number('AUDIO_CACHE_MAX_MB', 128, 64, 1024) * 1024 * 1024;
  const pending = new Map(), entries = new Map(), growing = new Map();
  let jobs = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.(mp3|pcm)$/.test(name)) continue;
    const file = path.join(directory, name), stat = fs.statSync(file);
    entries.set(name, { file, size: stat.size, expires: stat.mtimeMs + ttl, used: stat.mtimeMs, readers: 0, done:true });
  }
  function prune(protectedKey) {
    let bytes = [...entries.values()].reduce((n, e) => n + e.size, 0);
    for (const [key, entry] of [...entries].sort((a,b) => a[1].used-b[1].used)) {
      if (key === protectedKey || entry.readers) continue;
      if (entry.expires > Date.now() && bytes <= budget) continue;
      fs.rmSync(entry.file, { force: true }); entries.delete(key); bytes -= entry.size;
    }
  }
  prune();
  function keyFor(track, format) {
    return createHash('sha256').update(JSON.stringify([track.provider, track.source_page || track.id, track.source_file || track.source_url || '', format, rate, 64])).digest('hex') + '.' + format;
  }
  async function* download(source, signal, podcast=false) {
    const segmented = /(^|\.)googlevideo\.com$/i.test(new URL(source.url).hostname);
    const chunkSize = 1024 * 1024;
    const concurrency = number('AUDIO_DOWNLOAD_CONCURRENCY', 3, 1, 4);
    const local = new AbortController();
    const combined = AbortSignal.any([signal, local.signal]);
    const maximum = (podcast?512:128) * 1024 * 1024;
    let downloadFailure;
    async function request(start, end) {
      const headers = new Headers(source.headers || {});
      headers.delete('range'); headers.set('Accept-Encoding', 'identity');
      if(segmented)headers.set('Range', `bytes=${start}-${end}`);
      const response = await fetch(source.url, {headers,redirect:'follow',signal:combined});
      if(!response.ok || !response.body) {
        await response.body?.cancel();throw Error(`Audio download HTTP ${response.status}`);
      }
      if(/json|text\/html/i.test(response.headers.get('content-type') || '')) {
        await response.body.cancel();throw Error('Audio source returned a page');
      }
      return response;
    }
    async function readRange(response,start,end,total=null) {
      const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if(!range || Number(range[1])!==start || Number(range[3])>maximum ||
        Number(range[2])!==Math.min(end,Number(range[3])-1) ||
        (total!==null && total!==Number(range[3]))) {
        await response.body.cancel();throw Error('Invalid audio Content-Range');
      }
      const expected=Number(range[2])-start+1, parts=[];
      let received=0;
      for await(const part of response.body) {
        received+=part.byteLength;
        if(received>expected)throw Error('Audio range exceeds expected length');
        parts.push(Buffer.from(part));
      }
      if(received!==expected)throw Error('Audio download ended early');
      return {data:Buffer.concat(parts,received),total:Number(range[3])};
    }
    try {
      const first=await request(0,chunkSize-1);
      if(!segmented || first.status!==206) {
        const expected=Number(first.headers.get('content-length'));let received=0;
        for await(const part of first.body) {
          received+=part.byteLength;
          if(received>maximum)throw Error('Audio source exceeds size limit');
          yield part;
        }
        if(expected>0 && received!==expected)throw Error('Audio download ended early');
        return;
      }
      const firstChunk=await readRange(first,0,chunkSize-1);
      yield firstChunk.data;
      const total=firstChunk.total;
      for(let offset=firstChunk.data.length;offset<total;offset+=chunkSize*concurrency) {
        const tasks=[];
        for(let i=0;i<concurrency && offset+i*chunkSize<total;i++) {
          const start=offset+i*chunkSize,end=Math.min(start+chunkSize-1,total-1);
          tasks.push((async()=>{
            const response=await request(start,end);
            if(response.status!==206){await response.body.cancel();throw Error('Audio source stopped honoring byte ranges');}
            return readRange(response,start,end,total);
          })().then(value=>({value}),error=>{downloadFailure ||= error;local.abort();return {error};}));
        }
        const results=await Promise.all(tasks);
        const failure=results.find(result=>result.error);
        if(failure)throw downloadFailure || failure.error;
        for(const result of results)yield result.value.data;
      }
    } finally {local.abort();}
  }
  async function build(track, format, key, state) {
    if (jobs >= number('MAX_PREPARES', 2, 1, 4)) throw Error('Audio preparation busy; retry shortly');
    jobs++;
    const started = Date.now(), controller = new AbortController();
    const file = path.join(directory, key), temporary = file + '.' + randomUUID() + '.part';
    if(state)state.file=temporary;
    let child, input, stderr = '';
    const timeout = setTimeout(() => { controller.abort(); input?.destroy(Error('Audio preparation timeout')); child?.kill('SIGKILL'); }, number('AUDIO_PREPARE_TIMEOUT_MS', 180000, 10000, 300000));
    try {
      const source = await sourceFor(track);
      if (controller.signal.aborted) throw Error('Audio preparation timeout');
      const args = ['-hide_banner','-loglevel','error','-nostdin',...(['nct','podcast'].includes(track.provider)?['-probesize','32768','-analyzeduration','0']:[]),'-i',source.file || 'pipe:0','-t',track.provider==='podcast'?'7200':'900','-vn','-ac','1','-ar',String(rate)];
      args.push(...(format === 'pcm' ? ['-c:a','pcm_s16le','-f','s16le'] : ['-c:a','libmp3lame','-b:a','64k','-write_xing','0','-id3v2_version','0','-write_id3v1','0','-f','mp3']), 'pipe:1');
      child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['pipe','pipe','pipe'] });
      child.stderr.on('data', d => { stderr = (stderr+d).slice(-1000); });
      child.stdin.on('error', () => {});
      const exited = new Promise((resolve,reject) => {
        child.once('error',reject);
        child.once('close',code => code === 0 ? resolve() : reject(Error('FFmpeg preparation failed: '+stderr)));
      });
      exited.catch(() => {});
      input = source.file ? null : Readable.from(download(source, controller.signal,track.provider==='podcast'));
      const feed = input ? pipeline(input,child.stdin) : Promise.resolve(child.stdin.end());
      feed.catch(() => {});
      let bytes = 0;
      const limit = new Transform({ transform(chunk,encoding,callback) {
        bytes += chunk.length;
        callback(bytes > (track.provider==='podcast'?64:48) * 1024 * 1024 ? Error('Prepared audio exceeds size limit') : null, chunk);
      }});
      const tasks = [feed, exited, pipeline(child.stdout,limit,fs.createWriteStream(temporary,{flags:'wx',mode:0o600}))];
      try {await Promise.all(tasks);}
      catch(error) {
        controller.abort(); input?.destroy(); child.kill('SIGKILL');
        await Promise.allSettled(tasks);
        throw error;
      }
      if (!bytes || controller.signal.aborted) throw Error('Audio preparation failed or timed out');
      fs.renameSync(temporary,file);
      const entry = Object.assign(state || {},{ file, size:bytes, expires:Date.now()+ttl, used:Date.now(), readers:state?.readers || 0, done:true });
      entries.set(key,entry); prune(key);
      console.log('[AUDIO READY]',JSON.stringify({title:track.title,format,bytes,ms:Date.now()-started}));
      return entry;
    } catch(error){
      if(state){state.error=error;state.done=true;}throw error;
    } finally {
      clearTimeout(timeout); controller.abort(); input?.destroy(); child?.kill('SIGKILL');
      fs.rmSync(temporary,{force:true}); jobs--;
    }
  }
  async function prepare(track, format='mp3') {
    const key = keyFor(track,format), cached = entries.get(key);
    if (cached && cached.expires > Date.now() && fs.existsSync(cached.file)) {
      cached.used=Date.now(); console.log('[AUDIO FILE CACHE]',track.title); return cached;
    }
    if (pending.has(key)) return pending.get(key);
    if (cached?.readers) {cached.used=Date.now();return cached;}
    prune();
    const progressive=(track.provider==='nct' && process.env.NCT_PROGRESSIVE!=='false') || (track.provider==='podcast' && process.env.PODCAST_PROGRESSIVE!=='false');
    const state=progressive && format==='mp3'?{readers:0,done:false}:null;
    if(state)growing.set(key,state);
    const task = build(track,format,key,state).catch(error=>{if(state){state.error=error;state.done=true;}throw error;}); pending.set(key,task);
    try {return await task;} finally {pending.delete(key);growing.delete(key);}

  }
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function playable(track){
    const complete=prepare(track,'mp3');
    complete.catch(()=>{});
    const state=growing.get(keyFor(track,'mp3'));
    if(!state)return complete;
    const threshold=number(track.provider==='podcast'?'PODCAST_BUFFER_SECONDS':'NCT_BUFFER_SECONDS',8,3,30)*8000;
    while(!state.done){
      if(state.file && fs.existsSync(state.file) && fs.statSync(state.file).size>=threshold){
        console.log('[AUDIO BUFFER READY]',JSON.stringify({title:track.title,buffer_seconds:threshold/8000}));
        return state;
      }
      await Promise.race([pause(100),complete.then(()=>{},()=>{})]);
    }
    return complete;
  }
  async function serveGrowing(entry,req,res,options={}){
    if(entry.error)throw entry.error;
    if(res.destroyed)return;
    entry.readers++;
    let handle;
    try{
      const firstPath=entry.file;
      try{handle=await fs.promises.open(firstPath,'r');}
      catch(error){if(error.code!=='ENOENT' || entry.file===firstPath)throw error;handle=await fs.promises.open(entry.file,'r');}
      if(res.destroyed)return;
      if(!options.append)res.writeHead(200,{'Content-Type':'audio/mpeg','Accept-Ranges':'none','Cache-Control':'no-store','X-Audio-Sample-Rate':String(rate),'X-Audio-Channels':'1'});
      if(req.method==='HEAD'){res.end();return;}
      let position=0;
      const buffer=Buffer.alloc(32768);
      while(!res.destroyed){
        if(entry.error)throw entry.error;
        const available=(await handle.stat()).size-position;
        if(available>0){
          const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,available),position);
          if(!bytesRead)throw Error('Cannot read buffered audio');
          position+=bytesRead;
          if(res.destroyed)return;
          if(!res.write(Buffer.from(buffer.subarray(0,bytesRead)))){
            if(res.destroyed)throw Error('Audio client disconnected');
            await new Promise((resolve,reject)=>{
              const clean=()=>{res.off('drain',drain);res.off('close',close);res.off('error',close);};
              const drain=()=>{clean();resolve();};const close=()=>{clean();reject(Error('Audio client disconnected'));};
              res.once('drain',drain);res.once('close',close);res.once('error',close);
            });
          }
        }else if(entry.done){res.end();break;}
        else await pause(100);
      }
      if(!res.destroyed)console.log('[AUDIO] progressive complete');
    }finally{try{await handle?.close();}finally{entry.readers--;}}
  }
  async function serve(track,format,req,res,options={}) {
    const entry = await prepare(track,format);
    if (res.destroyed) return;
    entry.readers++; entry.used=Date.now();
    try {
      let start=0, end=entry.size-1, status=200;
      if (req.headers.range && !options.append) {
        const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) {res.writeHead(416,{'Content-Range':`bytes */${entry.size}`});res.end();return;}
        if (!match[1]) {const suffix=Number(match[2]);start=Math.max(0,entry.size-suffix);}
        else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= entry.size) {
          res.writeHead(416,{'Content-Range':`bytes */${entry.size}`});res.end();return;
        }
        status=206;
      }
      const headers={'Content-Type':format==='pcm'?'application/octet-stream':'audio/mpeg','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=300','X-Audio-Sample-Rate':String(rate),'X-Audio-Channels':'1'};
      if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${entry.size}`;
      if(options.append && format==='mp3') {
        // Bỏ ID3 ở giữa luồng sau các frame im lặng; giữ nguyên frame nhạc.
        const descriptor=fs.openSync(entry.file,'r'),tag=Buffer.alloc(10);
        try{fs.readSync(descriptor,tag,0,10,0);}finally{fs.closeSync(descriptor);}
        if(tag.subarray(0,3).toString()==='ID3') {
          start=10+((tag[6]&127)*2097152+(tag[7]&127)*16384+(tag[8]&127)*128+(tag[9]&127));
          if(tag[5]&16)start+=10;
          if(start>end)throw Error('MP3 has no audio frames');
        }
      }
      if(!options.append)res.writeHead(status,headers);
      if(req.method==='HEAD'){res.end();return;}
      await pipeline(fs.createReadStream(entry.file,{start,end}),res);
      console.log('[AUDIO]',track.title,format,'complete');
    } finally {entry.readers--;}
  }
  return { prepare, serve, playable, serveGrowing };
}
