import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCCMixter, searchCommons, openAudioURL } from './open-sources.js';
import { parseMusicRequest, rank, webAudio } from './providers.js';
test('open audio rejects arbitrary destinations and non-audio files',()=>{
  for(const value of ['https://127.0.0.1/audio.mp3','https://ccmixter.org.evil.com/content/a.mp3','https://ccmixter.org/content/a.html','http://ccmixter.org/content/a.mp3','https://upload.wikimedia.org/wikipedia/commons/a/b/video.webm'])assert.equal(openAudioURL(value),false);
  assert.equal(openAudioURL('https://ccmixter.org/content/a/song.mp3'),true);
});
test('ccMixter search uses searchp, keeps attribution, and excludes remote files',async()=>{
  const tracks=await searchCCMixter('Night','Artist',async u=>{
    assert.equal(u.searchParams.get('searchp'),'Night Artist');
    return [{upload_name:'Night',user_real_name:'Artist',license_name:'CC BY',file_page_url:'https://ccmixter.org/files/a/1',files:[{download_url:'https://ccmixter.org/content/a/night.mp3'},{download_url:'https://evil.test/song.mp3'}]}];
  });
  assert.equal(tracks.length,1);assert.equal(tracks[0].license,'CC BY');
  assert.equal(rank(tracks,'Night','Other Singer').length,0);
  assert.equal((await webAudio(tracks[0].source_page)).url,tracks[0].source_page);
});
test('Commons excludes video and hidden files and cleans attribution HTML',async()=>{
  const audio={url:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Moonlight.ogg',mediatype:'AUDIO',extmetadata:{Artist:{value:'<a>Beethoven</a>'},LicenseShortName:{value:'Public domain'}}};
  const tracks=await searchCommons('Moonlight','',async()=>({query:{pages:{1:{title:'File:Moonlight.ogg',imageinfo:[audio]},2:{title:'File:Video.ogg',imageinfo:[{...audio,mediatype:'VIDEO'}]},3:{title:'File:Hidden.ogg',imageinfo:[{...audio,filehidden:''}]}}}}));
  assert.equal(tracks.length,1);assert.equal(tracks[0].artist,'Beethoven');assert.equal(tracks[0].title,'Moonlight');
});
test('voice qualifiers select open sources and remove the command',()=>{
  assert.deepEqual(parseMusicRequest('mở a night flight trên ccMixter'),{song:'a night flight',artist:'',preferred:'ccmixter'});
  assert.equal(parseMusicRequest('Moonlight','','commons').preferred,'commons');
  assert.equal(parseMusicRequest('mở Moonlight trên nguồn mở').preferred,'open');
});
