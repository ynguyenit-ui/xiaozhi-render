// Public provider APIs; audio always passes the host's probe and MP3 encoder.
import https from 'node:https';
import { Readable } from 'node:stream';
export function ccMixterFetch(url, options={}, redirects=0) {
  const u=new URL(url);
  if(u.protocol!=='https:' || u.hostname!=='ccmixter.org' || u.username || u.password || u.port ||
    !(u.pathname==='/api/query' || /^\/content\/.+\.mp3$/i.test(u.pathname)))return Promise.reject(Error('Unsupported ccMixter URL'));
  return new Promise((resolve,reject)=>{
    // ccMixter sends a large response-header block. Bound it to 64 KiB.
    const request=https.get(u,{maxHeaderSize:65536,signal:options.signal,
      headers:{...Object.fromEntries(new Headers(options.headers)), 'Accept-Encoding':'identity'}},response=>{
      const code=response.statusCode || 502;
      if([301,302,303,307,308].includes(code) && response.headers.location){
        response.resume();
        if(redirects>=3)return reject(Error('Too many ccMixter redirects'));
        ccMixterFetch(new URL(response.headers.location,u),options,redirects+1).then(resolve,reject);return;
      }
      const headers=new Headers();
      for(const name of ['content-type','content-length','content-range'])if(response.headers[name])headers.set(name,String(response.headers[name]));
      const body=[204,205,304].includes(code)?null:Readable.toWeb(response);
      if(!body)response.resume();
      resolve(new Response(body,{status:code,headers}));
    });
    request.on('error',reject);
  });
}
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
  const transport=new URL(url).hostname==='ccmixter.org'?ccMixterFetch:fetch;
  const r = await transport(url, { headers: { Accept:'application/json', 'User-Agent':'XiaozhiMusicHost/1.0 (public audio search)' }, signal:AbortSignal.timeout(6500) });
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
