import assert from 'node:assert/strict';
import test from 'node:test';
import zingPackage from 'mp3-api';
import { hasPublicZing128, webAudio, parseMusicRequest, searchZingReport, searchMusicMetadata } from './providers.js';

test('accepts only an HTTPS 128 kbps stream returned with success', () => {
  assert.equal(hasPublicZing128({err:0,data:{'128':'https://cdn.example/audio.mp3'}}), true);
});

test('rejects region/VIP errors even if the response contains a URL', () => {
  assert.equal(hasPublicZing128({err:-1110,data:{'128':'https://cdn.example/audio.mp3'}}), false);
});

test('rejects responses that only contain a higher quality stream', () => {
  assert.equal(hasPublicZing128({err:0,data:{'320':'https://cdn.example/audio.mp3'}}), false);
});

test('rejects non-HTTPS and malformed stream values', () => {
  assert.equal(hasPublicZing128({err:0,data:{'128':'http://cdn.example/audio.mp3'}}), false);
  assert.equal(hasPublicZing128({err:0,data:{'128':'VIP'}}), false);
  assert.equal(hasPublicZing128({err:null,data:{'128':'https://cdn.example/audio.mp3'}}), false);
});

test('Zing playback selects the public 128 stream and reuses its short cache', async () => {
  const original=zingPackage.ZingMp3.getSong;
  let calls=0;
  zingPackage.ZingMp3.getSong=async id=>{
    calls++;
    assert.equal(id,'TESTFREE');
    return {err:0,data:{'128':'https://cdn.example/free128.mp3','320':'https://cdn.example/high320.mp3'}};
  };
  try{
    const page='https://zingmp3.vn/bai-hat/Test/TESTFREE.html';
    assert.equal((await webAudio(page)).url,'https://cdn.example/free128.mp3');
    assert.equal((await webAudio(page)).url,'https://cdn.example/free128.mp3');
    assert.equal(calls,1);
  }finally{zingPackage.ZingMp3.getSong=original;}
});

test('Zing playback rejects VIP/region errors, 320-only responses, and invalid pages', async () => {
  const original=zingPackage.ZingMp3.getSong;
  try{
    for(const response of [{err:-1110,data:{'128':'https://cdn.example/audio.mp3'}},{err:0,data:{'320':'https://cdn.example/audio.mp3'}}]){
      zingPackage.ZingMp3.getSong=async()=>response;
      await assert.rejects(webAudio('https://zingmp3.vn/bai-hat/Test/TESTDENY.html'),/no public 128/);
    }
    zingPackage.ZingMp3.getSong=async()=>{throw Error('API must not be called');};
    await assert.rejects(webAudio('https://zingmp3.vn/album/Test/TESTDENY.html'),/Invalid Zing song page/);
  }finally{zingPackage.ZingMp3.getSong=original;}
});

test('recognizes explicit Zing source and Vietnamese voice qualifiers',()=>{
  assert.equal(parseMusicRequest('Sóng Gió','','zingmp3').preferred,'zingmp3');
  assert.deepEqual(parseMusicRequest('mở bài Sóng Gió trên Zing MP3'),{song:'Sóng Gió',artist:'',preferred:'zingmp3'});
  assert.equal(parseMusicRequest('ZingMP3: Bạc Phận').song,'Bạc Phận');
  assert.equal(parseMusicRequest('mở bài Sóng Gió trên YouTube').preferred,'youtube');
});
test('keeps region-restricted metadata and still checks a different free song',async()=>{
  const originalSearch=zingPackage.ZingMp3.search,originalSong=zingPackage.ZingMp3.getSong;
  const calls=[];
  zingPackage.ZingMp3.search=async q=>({err:0,data:{songs:[{encodeId:q==='Blocked Sample'?'BLOCKED123':'PUBLIC123',title:q,artistsNames:'Test Artist',link:'/bai-hat/Test/'+(q==='Blocked Sample'?'BLOCKED123':'PUBLIC123')+'.html'}]}});
  zingPackage.ZingMp3.getSong=async id=>{calls.push(id);return id==='BLOCKED123'?{err:-1110,msg:'Region restricted'}:{err:0,data:{'128':'https://cdn.example/free.mp3'}};};
  try{
    const denied=await searchZingReport('Blocked Sample');
    assert.equal(denied.candidates[0].title,'Blocked Sample');
    assert.equal(denied.candidates[0].reason,'region_restricted');
    assert.equal(denied.playable_tracks.length,0);
    assert.equal(await searchMusicMetadata('Blocked Sample','',{source:'zingmp3'}),null);
    const free=await searchMusicMetadata('Free Sample','',{source:'zingmp3'});
    assert.equal(free.site,'ZingMP3');
    assert.deepEqual(calls,['BLOCKED123','PUBLIC123']);
  }finally{zingPackage.ZingMp3.search=originalSearch;zingPackage.ZingMp3.getSong=originalSong;}
});
