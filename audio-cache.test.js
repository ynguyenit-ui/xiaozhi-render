import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createAudioCache } from './audio-cache.js';

test('Zing streams before download ends and preserves music longer than 15 minutes', {timeout:30000}, async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zing-audio-regression-'));
  const previous=process.env.AUDIO_CACHE_DIR;
  process.env.AUDIO_CACHE_DIR=path.join(directory,'cache');
  let release=()=>{},sourceServer,playerServer;
  try{
    const fixture=path.join(directory,'long.wav');
    const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','905','-c:a','pcm_s16le',fixture],{timeout:10000});
    assert.equal(generated.status,0,generated.stderr?.toString());
    const input=fs.readFileSync(fixture);
    sourceServer=http.createServer((_req,res)=>{
      res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':input.length});
      res.write(input.subarray(0,512000));
      release=()=>res.end(input.subarray(512000));
    });
    await new Promise(resolve=>sourceServer.listen(0,'127.0.0.1',resolve));
    const cache=createAudioCache(async()=>({url:'http://127.0.0.1:'+sourceServer.address().port+'/long.wav'}),24000);
    const track={provider:'web',site:'ZingMP3',title:'Long regression fixture',source_page:'https://zingmp3.vn/bai-hat/Test/LONGTEST.html'};
    const entry=await cache.playable(track);
    assert.equal(entry.done,false,'audio must become playable before the upstream finishes');
    playerServer=http.createServer((req,res)=>{void cache.serveGrowing(entry,req,res).catch(()=>res.destroy());});
    await new Promise(resolve=>playerServer.listen(0,'127.0.0.1',resolve));
    const response=await fetch('http://127.0.0.1:'+playerServer.address().port+'/audio');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'audio/mpeg');
    const reader=response.body.getReader();
    const first=await reader.read();
    assert.ok(first.value.length>0);
    assert.equal(entry.done,false);
    release();
    let received=first.value.length;
    for(;;){const part=await reader.read();if(part.done)break;received+=part.value.length;}
    const complete=await cache.prepare(track);
    assert.equal(received,complete.size,'the growing stream must include the complete file');
    const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',complete.file],{timeout:10000});
    assert.equal(probe.status,0);
    assert.ok(Number(JSON.parse(probe.stdout).format.duration)>904,'the medley must not be cut at 900 seconds');
  }finally{
    release();
    for(const server of [sourceServer,playerServer])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(previous===undefined)delete process.env.AUDIO_CACHE_DIR;else process.env.AUDIO_CACHE_DIR=previous;
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
