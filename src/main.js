const { app, BrowserWindow, ipcMain, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.ts']);
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const NATIVE_CONTAINERS = new Set(['.mp4', '.m4v', '.webm', '.mov']);
const NATIVE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const NATIVE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const USER_AGENT = 'ZantroMediaCenter/1.0 (https://github.com/mdnzaa/zantro)';

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath && ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
  if (ffmpegPath && !fs.existsSync(ffmpegPath)) ffmpegPath = null;
} catch {
  ffmpegPath = null;
}

let mainWindow;
let configPath;
let thumbsDir;
let bannersDir;
let streamPort = 0;
let activeStreamProc = null;

function getDefaultConfig() {
  const sysLang = (app.getLocale() || 'fr').slice(0, 2);
  const supportedLang = ['fr', 'en', 'es'].includes(sysLang) ? sysLang : 'fr';

  return {
    username: '',
    folders: [],
    files: [],
    excluded: [],
    metadata: {},
    settings: { theme: 'dark', language: supportedLang, introSound: true },
    progress: {},
    favorites: []
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      return { ...getDefaultConfig(), ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('Error reading config:', err);
  }
  return getDefaultConfig();
}

function saveConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving config:', err);
  }
}

function getThumbHash(filePath, mtimeMs) {
  return crypto.createHash('md5').update(`${filePath}_${mtimeMs}`).digest('hex');
}

function parseFilename(rawName) {
  const yearMatch = rawName.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : '';
  const isSeries = /\b(S\d{1,2}E\d{1,2}|S\d{1,2}|Saison\s*\d+|Season\s*\d+)\b/i.test(rawName);

  let clean = rawName.replace(/[._]/g, ' ');
  const cutMatch = clean.match(/(\(|\[|\b(S\d{1,2}E\d{1,2}|S\d{1,2}|1080p|720p|2160p|4k|uhd|bluray|bdrip|brrip|webrip|web-dl|web|hdrip|dvdrip|x264|x265|hevc|h264|aac|ac3|dts|multi|french|truefrench|vff|vf2|vf|vostfr|saison|season)\b)/i);
  if (cutMatch && cutMatch.index > 1) clean = clean.slice(0, cutMatch.index);

  if (year) {
    const yIdx = clean.search(new RegExp(`\\b${year}\\b`));
    if (yIdx > 2) clean = clean.slice(0, yIdx);
  }

  clean = clean.replace(/-[A-Za-z0-9]+$/g, '').replace(/[\s-]+$/g, '').replace(/\s+/g, ' ').trim();
  return { title: clean || rawName, year, isSeries };
}

function normalizeStr(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFileKey(name) {
  return String(name || '').replace(/^File:/i, '').replace(/_/g, ' ').trim().toLowerCase();
}

function mapGenreToCategory(genre) {
  const g = normalizeStr(genre);
  if (!g) return 'other';
  if (g.includes('action') || g.includes('aventure') || g.includes('adventure')) return 'action';
  if (g.includes('sci') || g.includes('fantast') || g.includes('fantasy')) return 'scifi';
  if (g.includes('comed') || g.includes('humour')) return 'comedy';
  if (g.includes('horreur') || g.includes('horror') || g.includes('thriller') || g.includes('suspense')) return 'horror';
  if (g.includes('anim') || g.includes('enfant') || g.includes('famille') || g.includes('family')) return 'animation';
  if (g.includes('doc')) return 'doc';
  if (g.includes('serie') || g.includes('tv')) return 'series';
  if (g.includes('dram') || g.includes('romance') || g.includes('musi') || g.includes('danse') || g.includes('crime')) return 'drama';
  return 'other';
}

async function fetchJson(url, headers = {}) {
  try {
    const res = await net.fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(9000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function downloadImage(url, destPath) {
  try {
    const res = await net.fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(9000)
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1500) return false;
    fs.writeFileSync(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

async function fetchWikipediaSummary(pageTitle, lang = 'fr') {
  if (!pageTitle) return null;
  const slug = encodeURIComponent(pageTitle.replace(/\s+/g, '_'));
  const data = await fetchJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${slug}`);
  if (!data || data.type === 'disambiguation') return null;
  return { extract: data.extract || '', thumb: data.thumbnail?.source || '' };
}

async function fetchEmbyDetailsFromWikidata(imdbId, lang = 'fr') {
  if (!imdbId) return null;
  const prefLang = ['fr', 'en', 'es'].includes(lang) ? lang : 'fr';

  const qRes = await fetchJson(
    `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(`SELECT ?item WHERE { ?item wdt:P345 "${imdbId}" } LIMIT 1`)}`,
    { Accept: 'application/sparql-results+json' }
  );
  const itemUri = qRes?.results?.bindings?.[0]?.item?.value;
  if (!itemUri) return null;
  const movieQid = itemUri.split('/').pop();

  const entityRes = await fetchJson(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${movieQid}&props=claims|sitelinks|labels&languages=${prefLang}|en&format=json`
  );
  const movieEntity = entityRes?.entities?.[movieQid];
  if (!movieEntity) return null;

  const actorQids = (movieEntity.claims?.P161 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean).slice(0, 14);
  const genreQids = (movieEntity.claims?.P136 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean).slice(0, 5);

  const frTitle = movieEntity.sitelinks?.frwiki?.title || '';
  const enTitle = movieEntity.sitelinks?.enwiki?.title || '';
  const esTitle = movieEntity.sitelinks?.eswiki?.title || '';

  const wikiTitle = prefLang === 'fr' ? (frTitle || enTitle) : prefLang === 'es' ? (esTitle || enTitle) : (enTitle || frTitle);
  const wikiLang = prefLang === 'fr' && frTitle ? 'fr' : prefLang === 'es' && esTitle ? 'es' : 'en';

  const allIds = [...actorQids, ...genreQids];
  const [wikiSummary, batchEntities] = await Promise.all([
    wikiTitle ? fetchWikipediaSummary(wikiTitle, wikiLang) : Promise.resolve(null),
    allIds.length
      ? fetchJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${allIds.join('|')}&props=labels|descriptions|claims&languages=${prefLang}|en&format=json`)
      : Promise.resolve(null)
  ]);

  const entities = batchEntities?.entities || {};
  const genres = genreQids.map((id) => entities[id]?.labels?.[prefLang]?.value || entities[id]?.labels?.en?.value || '').filter(Boolean);

  const rawActors = [];
  const imageFiles = [];
  for (const id of actorQids) {
    const ent = entities[id];
    if (!ent) continue;
    const name = ent.labels?.[prefLang]?.value || ent.labels?.en?.value;
    if (!name) continue;
    const bio = ent.descriptions?.[prefLang]?.value || ent.descriptions?.en?.value || '';
    const imgFile = ent.claims?.P18?.[0]?.mainsnak?.datavalue?.value || '';
    if (imgFile) imageFiles.push(imgFile);
    rawActors.push({ name, bio, imgFile });
  }

  const photoMap = new Map();
  if (imageFiles.length) {
    const params = new URLSearchParams({
      action: 'query',
      titles: imageFiles.map((f) => `File:${f}`).join('|'),
      prop: 'imageinfo',
      iiprop: 'url',
      iiurlwidth: '260',
      format: 'json'
    });
    const imgRes = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params.toString()}`);
    for (const p of Object.values(imgRes?.query?.pages || {})) {
      const url = p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url;
      if (url && p.title) photoMap.set(normalizeFileKey(p.title), url);
    }
  }

  const cast = rawActors.map((a) => ({
    name: a.name,
    bio: a.bio,
    photoUrl: a.imgFile ? (photoMap.get(normalizeFileKey(a.imgFile)) || '') : ''
  }));

  return {
    title: movieEntity.labels?.[prefLang]?.value || movieEntity.labels?.en?.value || '',
    synopsis: wikiSummary?.extract || '',
    genres,
    cast
  };
}

async function fetchSeriesFromTVMaze(imdbId) {
  if (!imdbId) return null;
  const show = await fetchJson(`https://api.tvmaze.com/lookup/shows?imdb=${imdbId}`);
  if (!show || !show.id) return null;
  const full = await fetchJson(`https://api.tvmaze.com/shows/${show.id}?embed=cast`);
  if (!full) return null;

  const cast = (full._embedded?.cast || []).slice(0, 14).map((item) => ({
    name: item.person?.name || '',
    bio: item.character?.name ? `Rôle : ${item.character.name}` : '',
    photoUrl: item.person?.image?.medium || item.person?.image?.original || ''
  })).filter((c) => c.name);

  return {
    title: full.name || '',
    synopsis: (full.summary || '').replace(/<[^>]+>/g, '').trim(),
    posterUrl: full.image?.original || full.image?.medium || '',
    cast
  };
}

async function lookupMovieOnline(title, year, lang, isSeriesHint = false) {
  if (!title || /^[\d\s:-]+$/.test(title) || title.length < 2) return null;

  const cleanNorm = normalizeStr(title);
  const firstChar = cleanNorm.replace(/\s/g, '')[0] || 'x';
  const queryWithYear = year ? `${cleanNorm} ${year}` : cleanNorm;
  const country = ['fr', 'es'].includes(lang) ? lang : 'us';

  const [imdbWithYear, itunesData] = await Promise.all([
    fetchJson(`https://v3.sg.media-imdb.com/suggestion/${firstChar}/${encodeURIComponent(queryWithYear)}.json`),
    fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(title)}&media=movie&country=${country}&limit=8`)
  ]);

  let imdbData = imdbWithYear;
  if ((!imdbData || !imdbData.d || !imdbData.d.length) && year) {
    imdbData = await fetchJson(`https://v3.sg.media-imdb.com/suggestion/${firstChar}/${encodeURIComponent(cleanNorm)}.json`);
  }

  let imdbId = '';
  let matchedTitle = title;
  let matchedYear = year;
  let actorsStr = '';
  let posterUrl = '';
  let synopsis = '';
  let category = isSeriesHint ? 'series' : 'other';
  let cast = [];
  let isSeries = isSeriesHint;

  if (imdbData && Array.isArray(imdbData.d)) {
    const candidates = imdbData.d.filter((item) =>
      ['movie', 'tvSeries', 'tvMiniSeries'].includes(item.qid) || ['feature', 'TV series'].includes(item.q)
    );

    const bestImdb = candidates.find((item) => {
      const itemNorm = normalizeStr(item.l);
      const titleClose = itemNorm === cleanNorm || itemNorm.includes(cleanNorm) || cleanNorm.includes(itemNorm);
      const yearOk = !year || !item.y || Math.abs(Number(item.y) - Number(year)) <= 1;
      return titleClose && yearOk;
    }) || candidates[0];

    if (bestImdb) {
      imdbId = bestImdb.id || '';
      matchedTitle = bestImdb.l || title;
      matchedYear = bestImdb.y ? String(bestImdb.y) : year;
      actorsStr = bestImdb.s || '';
      if (bestImdb.i && bestImdb.i.imageUrl) posterUrl = bestImdb.i.imageUrl.replace(/\._V1_.*\./, '._V1_UX900_.');
      if (bestImdb.qid === 'tvSeries' || bestImdb.qid === 'tvMiniSeries') {
        isSeries = true;
        category = 'series';
      }
    }
  }

  if (imdbId) {
    const [wikiDetails, tvMaze] = await Promise.all([
      fetchEmbyDetailsFromWikidata(imdbId, lang),
      isSeries ? fetchSeriesFromTVMaze(imdbId) : Promise.resolve(null)
    ]);

    if (wikiDetails) {
      if (wikiDetails.title && lang === 'fr') matchedTitle = wikiDetails.title;
      if (wikiDetails.synopsis) synopsis = wikiDetails.synopsis;
      if (wikiDetails.cast.length) cast = wikiDetails.cast;
      if (category === 'other') {
        for (const g of wikiDetails.genres) {
          const mapped = mapGenreToCategory(g);
          if (mapped !== 'other') { category = mapped; break; }
        }
      }
    }

    if (tvMaze) {
      if (tvMaze.cast.length) cast = tvMaze.cast;
      if (!synopsis && tvMaze.synopsis) synopsis = tvMaze.synopsis;
      if (!posterUrl && tvMaze.posterUrl) posterUrl = tvMaze.posterUrl;
    }
  }

  if (itunesData && Array.isArray(itunesData.results)) {
    const bestItunes = itunesData.results.find((r) => {
      const rNorm = normalizeStr(r.trackName);
      const titleClose = rNorm === cleanNorm || rNorm.includes(cleanNorm) || cleanNorm.includes(rNorm);
      const rYear = (r.releaseDate || '').slice(0, 4);
      const yearOk = !matchedYear || !rYear || Math.abs(Number(rYear) - Number(matchedYear)) <= 1;
      return titleClose && yearOk;
    });

    if (bestItunes) {
      if (!synopsis) synopsis = bestItunes.longDescription || bestItunes.shortDescription || '';
      if (category === 'other' && bestItunes.primaryGenreName) category = mapGenreToCategory(bestItunes.primaryGenreName);
      if (!posterUrl && bestItunes.artworkUrl100) posterUrl = bestItunes.artworkUrl100.replace('100x100bb', '1200x1200bb');
    }
  }

  if (!cast.length && actorsStr) {
    cast = actorsStr.split(',').map((n) => ({ name: n.trim(), bio: '', photoUrl: '' })).filter((c) => c.name);
  }
  if (cast.length) actorsStr = cast.map((c) => c.name).join(', ');

  if (!actorsStr && !synopsis && !posterUrl) return null;
  return { title: matchedTitle, year: matchedYear, actors: actorsStr, cast, synopsis, category, posterUrl };
}

let enriching = false;
async function autoEnrichMissingMetadata() {
  if (enriching) return;
  enriching = true;
  try {
    const config = loadConfig();
    const videos = buildVideoList(config);
    const lang = config.settings?.language || 'fr';

    for (const vid of videos) {
      const existing = config.metadata[vid.path];
      if (existing && (existing.manual || existing.enrichVersion === 3)) continue;

      const parsed = parseFilename(path.basename(vid.path, path.extname(vid.path)));
      const found = await lookupMovieOnline(parsed.title, parsed.year, lang, parsed.isSeries);
      if (!found) {
        config.metadata[vid.path] = { ...(existing || {}), enrichVersion: 3 };
        saveConfig(config);
        continue;
      }

      let bannerPath = existing?.bannerPath || '';
      if (!bannerPath && found.posterUrl) {
        const dest = path.join(bannersDir, `${vid.id}.jpg`);
        const ok = await downloadImage(found.posterUrl, dest);
        if (ok) bannerPath = dest;
      }

      config.metadata[vid.path] = {
        title: found.title || parsed.title,
        year: found.year || parsed.year,
        category: parsed.isSeries ? 'series' : (found.category || 'other'),
        actors: found.actors || '',
        cast: found.cast || [],
        synopsis: found.synopsis || '',
        bannerPath,
        enrichVersion: 3
      };
      saveConfig(config);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('zantro:videos-updated', { config, videos: buildVideoList(config) });
      }
    }
  } finally {
    enriching = false;
  }
}

function findSidecarBanner(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  for (const ext of IMAGE_EXTENSIONS) {
    const candidate = path.join(dir, `${base}${ext}`);
    if (fs.existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

function scanDirectory(dirPath, depth = 0, results = []) {
  if (depth > 4 || !fs.existsSync(dirPath)) return results;
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return results; }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) scanDirectory(fullPath, depth + 1, results);
    else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) results.push(fullPath);
  }
  return results;
}

function buildVideoList(config) {
  const uniquePaths = new Set();
  const excluded = new Set(config.excluded || []);

  for (const folder of config.folders || []) {
    if (fs.existsSync(folder)) scanDirectory(folder).forEach((p) => { if (!excluded.has(p)) uniquePaths.add(p); });
  }
  for (const file of config.files || []) {
    if (!excluded.has(file) && fs.existsSync(file) && VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase())) uniquePaths.add(file);
  }

  const videos = [];
  const metaMap = config.metadata || {};

  for (const filePath of uniquePaths) {
    try {
      const stat = fs.statSync(filePath);
      const id = getThumbHash(filePath, stat.mtimeMs);
      const thumbPath = path.join(thumbsDir, `${id}.jpg`);
      const autoThumb = fs.existsSync(thumbPath) ? pathToFileURL(thumbPath).href : null;

      const rawName = path.basename(filePath, path.extname(filePath));
      const parsed = parseFilename(rawName);
      const custom = metaMap[filePath] || {};

      let customBannerUrl = null;
      if (custom.bannerPath && fs.existsSync(custom.bannerPath)) customBannerUrl = pathToFileURL(custom.bannerPath).href;

      videos.push({
        id,
        path: filePath,
        fileUrl: pathToFileURL(filePath).href,
        title: custom.title || parsed.title,
        year: custom.year !== undefined ? custom.year : parsed.year,
        category: custom.category || (parsed.isSeries ? 'series' : 'other'),
        actors: custom.actors || '',
        cast: custom.cast || [],
        synopsis: custom.synopsis || '',
        bannerPath: custom.bannerPath || '',
        bannerUrl: customBannerUrl || findSidecarBanner(filePath) || autoThumb,
        thumbUrl: autoThumb,
        folder: path.basename(path.dirname(filePath)),
        size: stat.size,
        mtime: stat.mtimeMs
      });
    } catch {}
  }

  videos.sort((a, b) => b.mtime - a.mtime);
  return videos;
}

function parseDurationSeconds(str) {
  const m = str.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

function inspectMedia(filePath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(null);
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => {
      const duration = parseDurationSeconds(stderr);
      const vMatch = stderr.match(/Video:\s*([a-zA-Z0-9_]+)/i);
      const aMatch = stderr.match(/Audio:\s*([a-zA-Z0-9_]+)/i);
      resolve({
        duration,
        videoCodec: vMatch ? vMatch[1].toLowerCase() : '',
        audioCodec: aMatch ? aMatch[1].toLowerCase() : ''
      });
    });
    proc.on('error', () => resolve(null));
  });
}

// =========================================
// SERVEUR DE STREAMING DIRECT (1 SECONDE)
// =========================================
function killActiveStream() {
  if (activeStreamProc) {
    try { activeStreamProc.kill('SIGKILL'); } catch {}
    activeStreamProc = null;
  }
}

function startStreamServer() {
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${streamPort}`);
    if (reqUrl.pathname !== '/stream') {
      res.writeHead(404);
      return res.end();
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      return res.end();
    }

    const filePath = reqUrl.searchParams.get('path');
    const start = Math.max(0, parseFloat(reqUrl.searchParams.get('start') || '0') || 0);
    const vCopy = reqUrl.searchParams.get('vcopy') === '1';

    if (!filePath || !ffmpegPath || !fs.existsSync(filePath)) {
      res.writeHead(404);
      return res.end();
    }

    killActiveStream();

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store'
    });

    const videoArgs = vCopy
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '22', '-pix_fmt', 'yuv420p'];

    const args = [
      '-ss', String(start),
      '-i', filePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      ...videoArgs,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1'
    ];

    const proc = spawn(ffmpegPath, args);
    activeStreamProc = proc;
    proc.stdout.pipe(res);

    const cleanup = () => {
      if (activeStreamProc === proc) activeStreamProc = null;
      try { proc.kill('SIGKILL'); } catch {}
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    proc.on('error', cleanup);
  });

  server.listen(0, '127.0.0.1', () => {
    streamPort = server.address().port;
  });
}

function loadLocales() {
  const localesDir = path.join(__dirname, '..', 'locales');
  const locales = {};
  for (const lang of ['fr', 'en', 'es']) {
    const file = path.join(localesDir, `${lang}.json`);
    if (fs.existsSync(file)) locales[lang] = JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  return locales;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: '#050507',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  configPath = path.join(userData, 'zantro-config.json');
  thumbsDir = path.join(userData, 'thumbnails');
  bannersDir = path.join(userData, 'banners');

  if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });
  if (!fs.existsSync(bannersDir)) fs.mkdirSync(bannersDir, { recursive: true });

  startStreamServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killActiveStream();
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers
ipcMain.handle('zantro:init', () => {
  const config = loadConfig();
  setTimeout(autoEnrichMissingMetadata, 400);
  return { config, videos: buildVideoList(config), locales: loadLocales() };
});

ipcMain.handle('zantro:actor-bio', async (_event, actorName) => {
  const config = loadConfig();
  const lang = config.settings?.language || 'fr';
  let info = await fetchWikipediaSummary(actorName, lang);
  if (!info && lang !== 'en') info = await fetchWikipediaSummary(actorName, 'en');
  return info || { extract: '', thumb: '' };
});

ipcMain.handle('zantro:set-username', (_event, username) => {
  const config = loadConfig();
  config.username = String(username || '').trim().slice(0, 32);
  saveConfig(config);
  return config.username;
});

ipcMain.handle('zantro:scan', () => {
  const config = loadConfig();
  setTimeout(autoEnrichMissingMetadata, 200);
  return buildVideoList(config);
});

ipcMain.handle('zantro:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
  if (result.canceled || !result.filePaths.length) return null;

  const config = loadConfig();
  for (const dir of result.filePaths) {
    if (!config.folders.includes(dir)) config.folders.push(dir);
    config.excluded = (config.excluded || []).filter((p) => !p.startsWith(dir + path.sep));
  }
  saveConfig(config);
  setTimeout(autoEnrichMissingMetadata, 150);
  return { config, videos: buildVideoList(config) };
});

ipcMain.handle('zantro:pick-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Vidéos', extensions: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'ts'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;

  const config = loadConfig();
  config.files = config.files || [];
  for (const file of result.filePaths) {
    if (!config.files.includes(file)) config.files.push(file);
    config.excluded = (config.excluded || []).filter((p) => p !== file);
  }
  saveConfig(config);
  setTimeout(autoEnrichMissingMetadata, 150);
  return { config, videos: buildVideoList(config) };
});

ipcMain.handle('zantro:pick-banner', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  const imgPath = result.filePaths[0];
  return { path: imgPath, url: pathToFileURL(imgPath).href };
});

ipcMain.handle('zantro:add-dropped', (_event, droppedPaths) => {
  const config = loadConfig();
  config.files = config.files || [];
  for (const p of droppedPaths) {
    if (!fs.existsSync(p)) continue;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      if (!config.folders.includes(p)) config.folders.push(p);
      config.excluded = (config.excluded || []).filter((ex) => !ex.startsWith(p + path.sep));
    } else if (stat.isFile() && VIDEO_EXTENSIONS.has(path.extname(p).toLowerCase())) {
      if (!config.files.includes(p)) config.files.push(p);
      config.excluded = (config.excluded || []).filter((ex) => ex !== p);
    }
  }
  saveConfig(config);
  setTimeout(autoEnrichMissingMetadata, 150);
  return { config, videos: buildVideoList(config) };
});

ipcMain.handle('zantro:remove-folder', (_event, folderPath) => {
  const config = loadConfig();
  config.folders = (config.folders || []).filter((f) => f !== folderPath);
  saveConfig(config);
  return { config, videos: buildVideoList(config) };
});

ipcMain.handle('zantro:remove-file', (_event, filePath) => {
  const config = loadConfig();
  config.files = (config.files || []).filter((f) => f !== filePath);
  saveConfig(config);
  return { config, videos: buildVideoList(config) };
});

ipcMain.handle('zantro:remove-video', (_event, videoPath) => {
  const config = loadConfig();
  config.files = (config.files || []).filter((f) => f !== videoPath);
  config.excluded = config.excluded || [];
  if (!config.excluded.includes(videoPath)) config.excluded.push(videoPath);
  config.favorites = (config.favorites || []).filter((f) => f !== videoPath);
  if (config.progress && config.progress[videoPath]) delete config.progress[videoPath];
  saveConfig(config);
  return { config, videos: buildVideoList(config) };
});

ipcMain.handle('zantro:save-metadata', (_event, { videoPath, data }) => {
  const config = loadConfig();
  config.metadata = config.metadata || {};
  const prev = config.metadata[videoPath] || {};
  config.metadata[videoPath] = { ...prev, ...data, manual: true };
  saveConfig(config);
  return { config, videos: buildVideoList(config) };
});

ipcMain.handle('zantro:save-settings', (_event, partialSettings) => {
  const config = loadConfig();
  config.settings = { ...config.settings, ...partialSettings };
  saveConfig(config);
  return config.settings;
});

ipcMain.handle('zantro:save-progress', (_event, { videoPath, currentTime, duration }) => {
  const config = loadConfig();
  if (duration > 0) {
    const ratio = currentTime / duration;
    if (ratio >= 0.95) delete config.progress[videoPath];
    else if (currentTime > 3) config.progress[videoPath] = { currentTime, duration, updatedAt: Date.now() };
    saveConfig(config);
  }
  return config.progress;
});

ipcMain.handle('zantro:clear-progress', () => {
  const config = loadConfig();
  config.progress = {};
  saveConfig(config);
  return config.progress;
});

ipcMain.handle('zantro:toggle-favorite', (_event, videoPath) => {
  const config = loadConfig();
  if (config.favorites.includes(videoPath)) config.favorites = config.favorites.filter((f) => f !== videoPath);
  else config.favorites.push(videoPath);
  saveConfig(config);
  return config.favorites;
});

ipcMain.handle('zantro:save-thumb', (_event, { id, dataUrl }) => {
  try {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const thumbPath = path.join(thumbsDir, `${id}.jpg`);
    fs.writeFileSync(thumbPath, Buffer.from(base64, 'base64'));
    return pathToFileURL(thumbPath).href;
  } catch {
    return null;
  }
});

ipcMain.handle('zantro:make-thumb', (_event, { id, filePath }) => {
  return new Promise((resolve) => {
    const thumbPath = path.join(thumbsDir, `${id}.jpg`);
    if (fs.existsSync(thumbPath)) return resolve(pathToFileURL(thumbPath).href);
    if (!ffmpegPath || !fs.existsSync(filePath)) return resolve(null);

    const proc = spawn(ffmpegPath, [
      '-y', '-ss', '00:00:25', '-i', filePath,
      '-frames:v', '1', '-vf', 'scale=420:-1', '-q:v', '4', thumbPath
    ]);
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(thumbPath)) resolve(pathToFileURL(thumbPath).href);
      else resolve(null);
    });
    proc.on('error', () => resolve(null));
  });
});

ipcMain.handle('zantro:cancel-prepare', () => {
  killActiveStream();
});

ipcMain.handle('zantro:prepare-play', async (_event, videoPath) => {
  const directUrl = pathToFileURL(videoPath).href;
  if (!ffmpegPath || !fs.existsSync(videoPath) || !streamPort) {
    return { fileUrl: directUrl, isStream: false, duration: 0 };
  }

  const info = await inspectMedia(videoPath);
  if (!info) return { fileUrl: directUrl, isStream: false, duration: 0 };

  const ext = path.extname(videoPath).toLowerCase();
  const containerOk = NATIVE_CONTAINERS.has(ext);
  const videoOk = NATIVE_VIDEO_CODECS.has(info.videoCodec);
  const audioOk = !info.audioCodec || NATIVE_AUDIO_CODECS.has(info.audioCodec);

  if (containerOk && videoOk && audioOk) {
    return { fileUrl: directUrl, isStream: false, duration: info.duration };
  }

  const streamUrl = `http://127.0.0.1:${streamPort}/stream?path=${encodeURIComponent(videoPath)}&vcopy=${videoOk ? '1' : '0'}`;
  return {
    fileUrl: streamUrl,
    isStream: true,
    duration: info.duration
  };
});