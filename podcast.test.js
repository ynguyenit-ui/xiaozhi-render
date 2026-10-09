import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePodcastRequest} from './podcast.js';
import {parseNhacPodcast,nhacPodcastURL} from './podcast-nhac.js';
test('routes storytelling and HIEUTV voice commands without changing music',()=>{
  assert.equal(parsePodcastRequest('kể chuyện Tấm Cám'),'Tấm Cám');
  assert.equal(parsePodcastRequest('mở Tấm Cám'),'Tấm Cám');
  assert.equal(parsePodcastRequest('mở HIEUTV tập 24'),'HIEU TV 24');
  assert.equal(parsePodcastRequest('Hiếu TV'),'HIEU TV');
  assert.equal(parsePodcastRequest('Sóng Gió'),null);
});
test('Nhac episode links are restricted to the selected public episode',()=>{
  assert.ok(nhacPodcastURL('https://nhac.vn/podcast/tam-cam-truyen-co-tich-pcWEmok'));
  for(const url of ['http://nhac.vn/podcast/test-pcWEmok','https://nhac.vn.evil.com/podcast/test-pcWEmok','https://user@nhac.vn/podcast/test-pcWEmok','https://nhac.vn/podcast/test-pcOther'])assert.equal(nhacPodcastURL(url),null);
});
test('extracts only the public episode player and rejects unexpected audio hosts',()=>{
  const html=`file:'https://evil.example/ad.mp3'; jwplayer('mypodcast').setup({file:'https://anchor.fm/s/3b2989d0/podcast/play/123/audio.mp3',title:'TẤM CÁM',description:'Bình yên'});`;
  const t=parseNhacPodcast(html);assert.equal(t.title,'TẤM CÁM');assert.equal(t.provider,'podcast');assert.ok(t.podcast_source.startsWith('https://anchor.fm/'));
  assert.throws(()=>parseNhacPodcast(html.replace('https://anchor.fm/s/','http://anchor.fm/s/')),/Unexpected/);
  assert.throws(()=>parseNhacPodcast(html.replace('https://anchor.fm/s/','https://evil.example/s/')),/Unexpected/);
  assert.throws(()=>parseNhacPodcast(''),/unavailable/);
});
