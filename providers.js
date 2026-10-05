import { spawn } from 'node:child_process';

export const normalize = s =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const domains = [
  'youtube.com',
  'zingmp3.vn',
  'nhaccuatui.com',
  'audius.co',
  'archive.org',
  'soundcloud.com'
];

export function allowedPage(page) {
  try {
    const u = new URL(page);

    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      domains.some(
        d => u.hostname === d || u.hostname.endsWith('.' + d)
      )
    );
  } catch {
    return false;
  }
}

export function rank(candidates, song, artist = '') {
  const wanted = normalize(song);
  const singer = normalize(artist);
  const tokens = wanted.split(' ').filter(Boolean);

  const versions = [
    'remix',
    'cover',
    'karaoke',
    'instrumental',
    'sped up',
    'slowed',
    'live',
    'mashup',
    'ambient edit'
  ];

  return candidates
    .filter(t => allowedPage(t.source_page))
    .map(t => {
      const title = normalize(t.title);
      const all = normalize(t.title + ' ' + (t.artist || ''));

      const overlap =
        tokens.filter(w => title.split(' ').includes(w)).length /
        Math.max(tokens.length, 1);

      const artistMatch =
        !singer ||
        singer
          .split(' ')
          .filter(Boolean)
          .every(w => all.split(' ').includes(w));

      let score =
        overlap * 100 +
        (title.includes(wanted) ? 40 : 0) +
        (singer ? (artistMatch ? 35 : -60) : 0);

      for (const v of versions) {
        if (title.includes(v) && !wanted.includes(v)) {
          score -= 65;
        }
      }

      if (/official|chinh thuc/.test(title)) {
        score += 8;
      }

      if (t.duration && (t.duration < 60 || t.duration > 900)) {
        score -= 50;
      }

      return {
        ...t,
        score: Math.round(score),
        overlap,
        artistMatch
      };
    })
    .filter(
      t => t.overlap >= 0.75 && t.artistMatch && t.score >= 90
    )
    .sort((a, b) => b.score - a.score);
}

async function getJSON(url) {
  const r = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  });

  if (!r.ok) {
    throw Error(`HTTP ${r.status}`);
  }

  return r.json();
}

const text = v =>
  Array.isArray(v) ? v.join(', ') : String(v || '');

function audioURL(id) {
  const u = new URL(
    `https://api.audius.co/v1/tracks/${encodeURIComponent(id)}/stream`
  );

  u.searchParams.set('app_name', 'XiaozhiKeylessMusic');

  return u.href;
}

async function searchAudius(song, artist) {
  const u = new URL('https://api.audius.co/v1/tracks/search');

  u.searchParams.set(
    'query',
    [song, artist].filter(Boolean).join(' ')
  );
  u.searchParams.set('limit', '15');
  u.searchParams.set('app_name', 'XiaozhiKeylessMusic');

  const d = await getJSON(u);

  return (d.data || [])
    .filter(
      t =>
        t.is_streamable !== false &&
        /^[A-Za-z0-9_-]+$/.test(t.id)
    )
    .map(t => ({
      title: t.title,
      artist: t.user?.name || t.user?.handle || '',
      duration: t.duration || 0,
      provider: 'web',
      site: 'Audius',
      source_page: `https://audius.co/tracks/${t.id}`
    }));
}

function duration(v) {
  if (!v) return 0;

  return String(v).includes(':')
    ? String(v)
        .split(':')
        .reduce((a, n) => a * 60 + Number(n), 0)
    : Number(v) || 0;
}

const searchCache = new Map();

async function searchArchive(song, artist) {
  const safe = s =>
    String(s).replace(/["\\]/g, ' ').trim();

  const q =
    `mediatype:audio AND (` +
    `title:"${safe(song)}" OR ` +
    `title:"${safe(normalize(song))}")`;

  const u = new URL('https://archive.org/advancedsearch.php');

  u.searchParams.set('q', q);
  u.searchParams.set('output', 'json');
  u.searchParams.set('rows', '5');

  for (const f of ['identifier', 'title', 'creator']) {
    u.searchParams.append('fl[]', f);
  }

  const d = await getJSON(u);
  const docs = d.response?.docs || [];

  const outcomes = await Promise.allSettled(
    docs.map(async doc => {
      const m = await getJSON(
        'https://archive.org/metadata/' +
          encodeURIComponent(doc.identifier)
      );

      if (
        m.is_dark ||
        m.metadata?.['access-restricted-item'] === 'true'
      ) {
        return [];
      }

      const mp3 = (m.files || []).filter(
        f =>
          f.name?.toLowerCase().endsWith('.mp3') &&
          !f.private &&
          !f.is_private
      );

      return mp3.map(f => ({
              title: text(f.title) || (
          mp3.length === 1
            ? text(doc.title)
            : f.name
                .replace(/\.mp3$/i, '')
                .replace(/[_-]/g, ' ')
        ),

        artist: text(
          f.artist || doc.creator || m.metadata?.creator
        ),

        duration: duration(f.length),
        provider: 'web',
        site: 'Internet Archive',

        source_page:
          `https://archive.org/download/` +
          `${encodeURIComponent(doc.identifier)}/` +
          f.name.split('/').map(encodeURIComponent).join('/')
      }));
    })
  );

  const candidates = outcomes.flatMap(r =>
    r.status === 'fulfilled' ? r.value : []
  );

  if (
    docs.length &&
    outcomes.every(r => r.status === 'rejected')
  ) {
    throw Error('Archive metadata requests failed');
  }

  return candidates;
}

let jobs = 0;

function extract(target, flat = false) {
  if (jobs >= 2) {
    return Promise.reject(Error('Extractor busy'));
  }

  jobs++;

  return new Promise((resolve, reject) => {
    const args = [
      '-m',
      'yt_dlp',
      '--ignore-config',
      '--no-warnings',
      '--no-playlist',
      '--socket-timeout',
      '8',
      '--retries',
      '0',
      '--skip-download',
      '--dump-single-json'
    ];

    if (flat) {
      args.push('--flat-playlist');
    } else {
      args.push(
        '-f',
        'bestaudio[protocol=https]/' +
          'bestaudio[protocol=http]/' +
          'best[protocol=https]/' +
          'best[protocol=http]'
      );
    }

    args.push('--', target);

    const p = spawn(
      process.env.PYTHON_PATH || 'python3',
      args,
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let out = '';
    let err = '';
    let done = false;

    const finish = (e, data) => {
      if (done) return;

      done = true;
      clearTimeout(timer);
      jobs--;

      if (e) reject(e);
      else resolve(data);
    };

    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      finish(Error('Extractor timeout'));
    }, 20000);

    p.stdout.on('data', d => {
      out += d;

      if (out.length > 4_000_000) {
        p.kill('SIGKILL');
        finish(Error('Output too large'));
      }
    });

    p.stderr.on('data', d => {
      err = (err + d).slice(-1000);
    });

    p.once('error', e => finish(e));

    p.once('close', code => {
      if (code !== 0) {
        return finish(
          Error(
            /sign in|bot|403|429/i.test(err)
              ? 'Provider blocked or needs login'
              : 'Provider extraction failed'
          )
        );
      }

      try {
        finish(null, JSON.parse(out));
      } catch {
        finish(Error('Invalid provider response'));
      }
    });
  });
}

export async function webAudio(page) {
  if (!allowedPage(page)) {
    throw Error('Unsupported source');
  }

  const u = new URL(page);

  if (
    u.hostname === 'archive.org' &&
    /^\/download\/[^/]+\/.+\.mp3$/i.test(u.pathname)
  ) {
    return { url: page };
  }

  if (
    u.hostname === 'audius.co' &&
    /^\/tracks\/[A-Za-z0-9_-]+$/.test(u.pathname)
  ) {
    return {
      url: audioURL(u.pathname.split('/').at(-1))
    };
  }

  const d = await extract(page);

  if (
    d.is_live ||
    d.has_drm ||
    !/^https?:\/\//.test(d.url || '')
  ) {
    throw Error('No public direct audio');
  }

  return {
    url: d.url,
    headers: d.http_headers || {}
  };
}

export async function searchWeb(song, artist = '') {
  const key = normalize(song) + '|' + normalize(artist);

  const cached = searchCache.get(key);

  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }

  const outcomes = await Promise.allSettled([
    searchAudius(song, artist),
    searchArchive(song, artist)
  ]);

  const candidates = [];
  const errors = [];

  for (let i = 0; i < outcomes.length; i++) {
    const r = outcomes[i];

    if (r.status === 'fulfilled') {
      candidates.push(...r.value);
    } else {
      errors.push({
        site: i === 0 ? 'Audius' : 'Internet Archive',
        error: r.reason.message
      });
    }
  }

  // Chỉ tìm YouTube nếu bạn chủ động bật biến này.
  if (process.env.KEYLESS_YOUTUBE === 'true') {
    try {
      const d = await extract(
        'ytsearch8:' +
          [song, artist].filter(Boolean).join(' '),
        true
      );

      for (const t of d.entries || []) {
        candidates.push({
          title: t.title,
          artist: t.uploader || t.channel || '',
          duration: t.duration,
          provider: 'web',
          site: 'YouTube',
          source_page:
            'https://www.youtube.com/watch?v=' + t.id
        });
      }
    } catch (e) {
      errors.push({
        site: 'YouTube',
        error: e.message
      });
    }
  }

  const unique = [
    ...new Map(
      candidates.map(t => [t.source_page, t])
    ).values()
  ];

  const result = {
    search_mode: 'keyless-audius-archive',
    candidates: rank(unique, song, artist),
    errors
  };

  if (!errors.length) {
    if (searchCache.size >= 100) {
      searchCache.delete(searchCache.keys().next().value);
    }

    searchCache.set(key, {
      result,
      expires: Date.now() + 300000
    });
  }

  return result;
}

async function probe(source) {
  const r = await fetch(source.url, {
    headers: {
      ...(source.headers || {}),
      Range: 'bytes=0-1023'
    },
    signal: AbortSignal.timeout(8000),
    redirect: 'follow'
  });

  const type = r.headers.get('content-type') || '';

  if (
    !r.ok ||
    !r.body ||
    /json|text\/html/i.test(type)
  ) {
    await r.body?.cancel();

    throw Error(
      `Audio unavailable: HTTP ${r.status}`
    );
  }

  const reader = r.body.getReader();

  try {
    const { value, done } = await reader.read();

    if (done || !value?.length) {
      throw Error('Empty audio');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
async function searchSoundCloud(song, artist = '') {
  const query = [song, artist].filter(Boolean).join(' ');

  const data = await extract('scsearch8:' + query, true);

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

export async function resolveWeb(song, artist) {
  const result = await searchWeb(song, artist);
  const errors = [...result.errors];

  // Thử nguồn hiện tại trước.
  for (const track of result.candidates.slice(0, 3)) {
    try {
      const source = await webAudio(track.source_page);
      await probe(source);

      return {
        ...track,
        id: Buffer.from(track.source_page).toString('base64url')
      };
    } catch (e) {
      errors.push({
        site: track.site,
        error: e.message
      });
    }
  }

  // Chỉ tìm SoundCloud khi nguồn hiện tại không phát được.
  if (process.env.ENABLE_SOUNDCLOUD !== 'false') {
    console.log('[FALLBACK] Trying SoundCloud:', song);

    try {
      const candidates = await searchSoundCloud(song, artist);

      for (const track of candidates.slice(0, 3)) {
        try {
          const source = await webAudio(track.source_page);
          await probe(source);

          console.log(
            '[FALLBACK] SoundCloud selected:',
            track.title
          );

          return {
            ...track,
            id: Buffer.from(track.source_page).toString('base64url')
          };
        } catch (e) {
          errors.push({
            site: 'SoundCloud',
            error: e.message
          });
        }
      }

      if (!candidates.length) {
        errors.push({
          site: 'SoundCloud',
          error: 'No matching track'
        });
      }
    } catch (e) {
      errors.push({
        site: 'SoundCloud',
        error: e.message
      });
    }
  }

  console.warn('[PROVIDERS]', JSON.stringify(errors));

  return null;
}
