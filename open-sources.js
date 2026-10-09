// Public provider APIs; audio always passes the host's probe and MP3 encoder.
const plain = value => String(value || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim().slice(0,400);
export function openAudioURL(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
    return (u.hostname === 'ccmixter.org' && /^\/content\/.+\.mp3$/i.test(u.pathname)) ||
      (u.hostname === 'upload.wikimedia.org' && /^\/wikipedia\/commons\/.+\.(?:mp3|ogg|oga|opus|flac|wav)$/i.test(u.pathname));
  } catch { return false; }
}
async function readJSON(url) {
  const r = await fetch(url, { headers: { Accept:'application/json', 'User-Agent':'XiaozhiMusicHost/1.0 (public audio search)' }, signal:AbortSignal.timeout(6500) });
  if (!r.ok) throw Error('HTTP '+r.status);
  return r.json();
}
export async function searchCCMixter(song, artist='', read=readJSON) {
  const u=new URL('https://ccmixter.org/api/query');
  u.searchParams.set('f','json');u.searchParams.set('searchp',[song,artist].filter(Boolean).join(' ').slice(0,200));
  u.searchParams.set('limit','15');
  const data=await read(u);
  if(!Array.isArray(data))throw Error('Invalid ccMixter response');
  return data.flatMap(t=>(t.files || []).filter(f=>openAudioURL(f.download_url) && new URL(f.download_url).hostname==='ccmixter.org').slice(0,1).map(f=>({
    title:plain(t.upload_name),artist:plain(t.user_real_name || t.user_name),duration:0,provider:'web',site:'ccMixter',
    source_page:f.download_url,attribution_url:t.file_page_url || '',license:plain(t.license_name),license_url:t.license_url || ''
  })));
}
export async function searchCommons(song, artist='', read=readJSON) {
  const words=[song,artist].filter(Boolean).join(' ').replace(/["|<>]/g,' ').slice(0,160);
  const u=new URL('https://commons.wikimedia.org/w/api.php');
  for(const [k,v] of Object.entries({action:'query',format:'json',generator:'search',gsrsearch:'filetype:audio '+words,gsrnamespace:'6',gsrlimit:'8',prop:'imageinfo',iiprop:'url|mime|mediatype|extmetadata',iiextmetadatafilter:'ObjectName|Artist|LicenseShortName|LicenseUrl'}))u.searchParams.set(k,v);
  const data=await read(u);
  if(data.error)throw Error('Wikimedia search unavailable');
  return Object.values(data.query?.pages || {}).flatMap(p=>{
    const i=p.imageinfo?.[0],m=i?.extmetadata || {};
    if(!i || i.mediatype!=='AUDIO' || i.filehidden!==undefined || !openAudioURL(i.url) || new URL(i.url).hostname!=='upload.wikimedia.org')return [];
    return [{title:plain(m.ObjectName?.value || p.title.replace(/^File:/,'').replace(/\.(mp3|ogg|oga|opus|flac|wav)$/i,'').replace(/_/g,' ')),
      artist:plain(m.Artist?.value),duration:0,provider:'web',site:'Wikimedia Commons',source_page:i.url,
      attribution_url:i.descriptionurl || '',license:plain(m.LicenseShortName?.value),license_url:m.LicenseUrl?.value || ''}];
  });
}
