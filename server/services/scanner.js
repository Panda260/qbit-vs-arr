const axios = require('axios');
const fs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');
const db = require('./db');

// ---------------------------------------------------------------------------
// Resilient HTTP helper — retries on 5xx, 429, and network errors
// ---------------------------------------------------------------------------

async function axiosWithRetry(config, { retries = 3, baseDelay = 500, label = '' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios(config);
    } catch (err) {
      const status = err.response?.status;
      const isRetryable =
        status === 429 ||
        (status >= 500 && status < 600) ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNABORTED' ||
        err.code === 'EPIPE' ||
        err.code === 'EAI_AGAIN';

      if (!isRetryable || attempt === retries) {
        throw err;
      }

      // Respect Retry-After header (in seconds) for 429
      let delay = baseDelay * Math.pow(2, attempt);
      if (status === 429) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'], 10);
        if (!isNaN(retryAfter) && retryAfter > 0) {
          delay = Math.max(delay, retryAfter * 1000);
        }
      }

      if (label) {
        console.warn(`[Retry ${attempt + 1}/${retries}] ${label} — ${status || err.code} — waiting ${delay}ms`);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// qBittorrent helpers
// ---------------------------------------------------------------------------

async function getQbitAuthCookie(url, username, password) {
  const cleanUrl = url.replace(/\/$/, '');
  const params = new URLSearchParams();
  params.append('username', username);
  params.append('password', password);
  const response = await axios.post(`${cleanUrl}/api/v2/auth/login`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': cleanUrl }
  });
  if (response.data === 'Fails.') throw new Error('Invalid username or password');
  const cookie = response.headers['set-cookie'];
  if (cookie) return cookie[0].split(';')[0];
  throw new Error('No cookie returned from qBittorrent');
}

async function getQbitTorrents(url, cookie) {
  const cleanUrl = url.replace(/\/$/, '');
  const response = await axios.get(`${cleanUrl}/api/v2/torrents/info`, {
    headers: { Cookie: cookie }
  });
  return response.data;
}

async function getQbitTorrentFiles(url, cookie, hash) {
  const cleanUrl = url.replace(/\/$/, '');
  try {
    const response = await axios.get(`${cleanUrl}/api/v2/torrents/files`, {
      headers: { Cookie: cookie },
      params: { hash }
    });
    return response.data || [];
  } catch {
    return [];
  }
}

/**
 * Checks if the Radarr/Sonarr item or its files indicate German language
 */
function hasGermanLanguage(arrItem, files, releaseName) {
  const gerRegex = /german|\bger\b|\bdeu\b|(?<!web-?)\bdl\b|dual[\s_-]*language/i;
  
  if (arrItem) {
    if (arrItem.originalLanguage?.name && /german|\bger\b|\bdeu\b/i.test(arrItem.originalLanguage.name)) return true;
    const itemStr = [arrItem.title, arrItem.originalTitle, arrItem.folderName, arrItem.path].filter(Boolean).join(' ');
    if (itemStr && gerRegex.test(itemStr)) return true;
  }

  let fileList = Array.isArray(files) ? files : [files].filter(Boolean);
  for (const f of fileList) {
    const langs = f.languages || (f.language ? [f.language] : []);
    for (const l of langs) {
      if (l && l.name && /german|\bger\b|\bdeu\b/i.test(l.name)) return true;
    }
    const mediaAudio = f.mediaInfo?.audioLanguages || f.audioLanguages || '';
    if (mediaAudio && gerRegex.test(mediaAudio)) return true;

    const fileStr = [f.relativePath, f.sceneName].filter(Boolean).join(' ');
    if (fileStr && gerRegex.test(fileStr)) return true;
  }

  if (releaseName && gerRegex.test(releaseName)) return true;
  return false;
}

/**
 * Returns a summary string of the languages reported by Radarr/Sonarr.
 * e.g., "German, English" or "9x German, English | 1x English"
 */
function getLanguageSummary(files) {
  let fileList = Array.isArray(files) ? files : [files].filter(Boolean);
  if (fileList.length === 0) return "Unknown";
  
  const counts = {};
  for (const f of fileList) {
    const langs = f.languages || (f.language ? [f.language] : []);
    const langNames = langs.map(l => l.name).filter(Boolean);
    const key = langNames.length > 0 ? langNames.join(', ') : "Unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  
  const summaries = [];
  for (const [lang, count] of Object.entries(counts)) {
    if (fileList.length === 1) {
      summaries.push(lang);
    } else {
      summaries.push(`${count}x ${lang}`);
    }
  }
  return summaries.join(' | ');
}

/**
 * Fetch tracker URLs for a single torrent.
 * Returns array of announce URLs.
 */
async function getQbitTorrentTrackers(url, cookie, hash) {
  const cleanUrl = url.replace(/\/$/, '');
  try {
    const response = await axios.get(`${cleanUrl}/api/v2/torrents/trackers`, {
      headers: { Cookie: cookie },
      params: { hash }
    });
    return (response.data || [])
      .map(t => t.url)
      .filter(u => u && !u.startsWith('** ')); // skip internal qBit pseudo-trackers
  } catch {
    return [];
  }
}

/**
 * Get all unique tracker URLs from all torrents (for the dropdown).
 * Samples up to 100 torrents to keep it fast.
 */
async function getAllTrackerUrls(url, cookie, torrents) {
  const seen = new Set();
  const BATCH_SIZE = 20;
  const sample = torrents.slice(0, 200); // sample first 200 for speed

  for (let i = 0; i < sample.length; i += BATCH_SIZE) {
    const batch = sample.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (t) => {
      const trackers = await getQbitTorrentTrackers(url, cookie, t.hash);
      trackers.forEach(u => {
        try {
          const host = new URL(u).host;
          seen.add(host);
        } catch {
          seen.add(u);
        }
      });
    }));
  }
  return Array.from(seen).sort();
}

// ---------------------------------------------------------------------------
// Inode (hardlink) index builder
// ---------------------------------------------------------------------------

const MKV_MIN_SIZE_BYTES = 100 * 1024 * 1024;
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|ts|m2ts|mov|wmv|flv|webm|iso)$/i;

/**
 * Optionally rewrite a path prefix, e.g. /downloads → /data/torrents.
 * Used when qBit/Arr paths differ from the paths visible in this container.
 */
function rewritePath(p, from, to) {
  if (!from || !to || !p) return p;
  if (p.startsWith(from)) return to + p.slice(from.length);
  return p;
}

/** Recursively walk a directory and index all video files by inode. */
async function walkDirForVideos(dirPath, torrent, inodeIndex) {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = nodePath.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walkDirForVideos(fullPath, torrent, inodeIndex);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.test(entry.name)) {
        try {
          const st = await fs.promises.stat(fullPath);
          if (st.size >= MKV_MIN_SIZE_BYTES) {
            const key = `${st.dev}:${st.ino}`;
            if (!inodeIndex.has(key)) inodeIndex.set(key, [torrent]);
            else inodeIndex.get(key).push(torrent);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}

/**
 * Build a Map of "dev:ino" → torrent for all video files in each torrent's
 * content_path. Uses only stat() — no file content is read.
 */
async function buildInodeIndex(torrents, pathFrom, pathTo, sendEvent) {
  console.log(`Building inode index for ${torrents.length} torrents...`);
  const startTime = Date.now();
  const inodeIndex = new Map();
  if (sendEvent) sendEvent('progress', { global: true, step: `Building hardlink inode index for ${torrents.length} torrents...`, progress: 20 });

  let skipped = 0;
  const BATCH_SIZE = 50; // stat is very fast, can use larger batches
  for (let i = 0; i < torrents.length; i += BATCH_SIZE) {
    const batch = torrents.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (torrent) => {
      const rawPath = torrent.content_path;
      if (!rawPath) return;
      const localPath = rewritePath(rawPath, pathFrom, pathTo);
      try {
        const st = await fs.promises.stat(localPath);
        if (st.isFile()) {
          if (VIDEO_EXTENSIONS.test(localPath) && st.size >= MKV_MIN_SIZE_BYTES) {
            const key = `${st.dev}:${st.ino}`;
            if (!inodeIndex.has(key)) inodeIndex.set(key, [torrent]);
            else inodeIndex.get(key).push(torrent);
          }
        } else if (st.isDirectory()) {
          await walkDirForVideos(localPath, torrent, inodeIndex);
        }
      } catch { skipped++; }
    }));

    // Update UI and yield
    const currentCount = Math.min(i + BATCH_SIZE, torrents.length);
    const pct = Math.min(40, 20 + Math.floor((currentCount / torrents.length) * 20));
    // Calculate ETA
    const elapsed = Date.now() - startTime;
    const avgTimePerItem = elapsed / currentCount;
    const remainingItems = torrents.length - currentCount;
    const etaSeconds = Math.round((remainingItems * avgTimePerItem) / 1000);
    const etaFormatted = etaSeconds > 60 
      ? `${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s` 
      : `${etaSeconds}s`;

    if (sendEvent) sendEvent('progress', { global: true, step: `Indexing Hardlinks (${currentCount}/${torrents.length}) - noch ca. ${etaFormatted}...`, progress: pct });
    
    checkCancel();
    await new Promise(resolve => setImmediate(resolve));
  }
  
  console.log(`Inode index built: ${inodeIndex.size} unique video files indexed, ${skipped} torrent paths inaccessible.`);
  return inodeIndex;
}

/**
 * Check if a given file path shares an inode with any torrent in the index.
 * Returns the matching torrent or null.
 *
 * NOTE: We intentionally do NOT check nlink > 1 here. On some setups (e.g.
 * bind-mounts, overlay filesystems, or cross-namespace hardlinks) the kernel
 * can report nlink=1 even for genuine hardlinks. Skipping that check is safe
 * because the inode lookup itself is authoritative.
 */
function matchByInode(inodeIndex, filePath, pathFrom, pathTo) {
  if (!filePath || !inodeIndex || inodeIndex.size === 0) return null;
  const localPath = rewritePath(filePath, pathFrom, pathTo);
  try {
    const st = fs.statSync(localPath);
    const key = `${st.dev}:${st.ino}`;
    return inodeIndex.get(key) || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Partial Hash index builder
// ---------------------------------------------------------------------------

const HASH_SAMPLE_SIZE = 1 * 1024 * 1024; // 1MB

async function calculatePartialHash(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size < MKV_MIN_SIZE_BYTES) return null;

    const fileHandle = await fs.promises.open(filePath, 'r');
    const head = Buffer.alloc(HASH_SAMPLE_SIZE);
    await fileHandle.read(head, 0, HASH_SAMPLE_SIZE, 0);

    let tail = Buffer.alloc(0);
    if (stats.size > HASH_SAMPLE_SIZE * 2) {
      tail = Buffer.alloc(HASH_SAMPLE_SIZE);
      await fileHandle.read(tail, 0, HASH_SAMPLE_SIZE, stats.size - HASH_SAMPLE_SIZE);
    }
    await fileHandle.close();

    const hash = crypto.createHash('md5')
      .update(head)
      .update(tail)
      .digest('hex');
    
    return `${stats.size}:${hash}`;
  } catch (err) {
    return null;
  }
}

/** Recursively walk a directory and index all video files by partial hash. */
async function walkDirForHashes(dirPath, torrent, hashIndex) {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = nodePath.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walkDirForHashes(fullPath, torrent, hashIndex);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.test(entry.name)) {
        const hashKey = await calculatePartialHash(fullPath);
        if (hashKey) {
          if (!hashIndex.has(hashKey)) hashIndex.set(hashKey, [torrent]);
          else hashIndex.get(hashKey).push(torrent);
        }
      }
    }
  } catch { /* skip */ }
}

async function buildFastHashIndex(torrents, pathFrom, pathTo, sendEvent) {
  console.log(`Building fast hash index for ${torrents.length} torrents...`);
  const startTime = Date.now();
  const hashIndex = new Map();
  if (sendEvent) sendEvent('progress', { global: true, step: `Building partial hash index for ${torrents.length} torrents...`, progress: 20 });

  const BATCH_SIZE = 15; // Balanced for both HDD and SSD
  for (let i = 0; i < torrents.length; i += BATCH_SIZE) {
    const batch = torrents.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (torrent) => {
      const localPath = rewritePath(torrent.content_path, pathFrom, pathTo);
      try {
        const st = await fs.promises.stat(localPath);
        if (st.isFile()) {
          const hashKey = await calculatePartialHash(localPath);
          if (hashKey) {
            if (!hashIndex.has(hashKey)) hashIndex.set(hashKey, [torrent]);
            else hashIndex.get(hashKey).push(torrent);
          }
        } else if (st.isDirectory()) {
          await walkDirForHashes(localPath, torrent, hashIndex);
        }
      } catch { /* skip */ }
    }));

    // Update UI and yield
    const currentCount = Math.min(i + BATCH_SIZE, torrents.length);
    const pct = Math.min(40, 20 + Math.floor((currentCount / torrents.length) * 20));
    // Calculate ETA
    const elapsed = Date.now() - startTime;
    const avgTimePerItem = elapsed / currentCount;
    const remainingItems = torrents.length - currentCount;
    const etaSeconds = Math.round((remainingItems * avgTimePerItem) / 1000);
    const etaFormatted = etaSeconds > 60 
      ? `${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s` 
      : `${etaSeconds}s`;

    if (sendEvent) {
      sendEvent('progress', { 
        global: true, 
        step: `Calculating Hashes (${currentCount}/${torrents.length}) - noch ca. ${etaFormatted}...`, 
        progress: pct 
      });
    }
    
    checkCancel();
    await new Promise(resolve => setImmediate(resolve));
  }

  console.log(`Partial hash index built: ${hashIndex.size} files indexed.`);
  return hashIndex;
}

function matchByPartialHash(hashIndex, filePath, pathFrom, pathTo) {
  if (!filePath || !hashIndex || hashIndex.size === 0) return [];
  const localPath = rewritePath(filePath, pathFrom, pathTo);
  const hashKey = calculatePartialHashSync(localPath);
  return hashKey ? hashIndex.get(hashKey) || [] : [];
}

async function buildSizeIndex(torrents, url, cookie, sendEvent) {
  const BATCH_SIZE = 20;
  // Map: size_bytes => [{ torrent, fileName }]
  const sizeIndex = new Map();

  // Note: we don't have access to internalSendEvent here easily unless we pass it, 
  // but buildSizeIndex is called from scanMedia which uses the passed 'sendEvent' 
  // which I will now make sure is the internal one.
  
  if (sendEvent) sendEvent('progress', { step: `Building size index for ${torrents.length} torrents...`, progress: 22 });
  console.log(`Building size index for ${torrents.length} torrents...`);

  for (let i = 0; i < torrents.length; i += BATCH_SIZE) {
    const batch = torrents.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (torrent) => {
      const files = await getQbitTorrentFiles(url, cookie, torrent.hash);
      torrent._files = files;
      for (const file of files) {
        if (!VIDEO_EXTENSIONS.test(file.name)) continue;
        if (file.size < MKV_MIN_SIZE_BYTES) continue;
        const existing = sizeIndex.get(file.size) || [];
        existing.push({ torrent, fileName: file.name });
        sizeIndex.set(file.size, existing);
      }
    }));
    const pct = 22 + Math.floor(((i + BATCH_SIZE) / torrents.length) * 8);
    if (sendEvent) sendEvent('progress', { step: `Building size index... (${Math.min(i + BATCH_SIZE, torrents.length)}/${torrents.length})`, progress: Math.min(30, pct) });
  }
  console.log('Size index built.');
  return sizeIndex;
}

/**
 * Match by size — cross-seed aware:
 * If multiple torrents share the same size BUT also share the same sanitized name
 * (i.e., they are cross-seeds of the SAME release), we consider it unambiguous
 * and return the first one. Only reject when torrents have DIFFERENT names.
 */
function matchBySize(sizeIndex, fileSizeBytes) {
  if (!fileSizeBytes || fileSizeBytes < MKV_MIN_SIZE_BYTES) return null;
  const matches = sizeIndex.get(fileSizeBytes);
  if (!matches || matches.length === 0) return null;

  const uniqueTorrents = [...new Map(matches.map(m => [m.torrent.hash, m.torrent])).values()];
  if (uniqueTorrents.length === 1) return uniqueTorrents[0];

  // Check if all candidates share the same sanitized name (cross-seeds)
  const names = new Set(uniqueTorrents.map(t => t.sName));
  if (names.size === 1) {
    // All cross-seeds of the same release — unambiguous, pick first
    return uniqueTorrents[0];
  }

  // Genuinely different releases with same file size → ambiguous
  return null;
}

// ---------------------------------------------------------------------------
// *Arr helpers
// ---------------------------------------------------------------------------

async function getRadarrMovies(instance) {
  try {
    const response = await axiosWithRetry({
      method: 'get',
      url: `${instance.url_internal}/api/v3/movie`,
      headers: { 'X-Api-Key': instance.api_key },
      timeout: 30000
    }, { label: `Radarr movies (${instance.name})` });
    return response.data.filter(m => m.hasFile);
  } catch (error) {
    console.error(`Failed to fetch Radarr movies (${instance.name}):`, error.message);
    return [];
  }
}

async function getSonarrSeries(instance) {
  try {
    const response = await axiosWithRetry({
      method: 'get',
      url: `${instance.url_internal}/api/v3/series`,
      headers: { 'X-Api-Key': instance.api_key },
      timeout: 30000
    }, { label: `Sonarr series (${instance.name})` });
    return response.data.filter(s => s.statistics && s.statistics.episodeFileCount > 0);
  } catch (error) {
    console.error(`Failed to fetch Sonarr series (${instance.name}):`, error.message);
    return [];
  }
}

async function getSonarrEpisodeFiles(instance, seriesId) {
  try {
    const response = await axiosWithRetry({
      method: 'get',
      url: `${instance.url_internal}/api/v3/episodefile`,
      headers: { 'X-Api-Key': instance.api_key },
      params: { seriesId },
      timeout: 15000
    }, { label: `Sonarr episodefiles series=${seriesId}` });
    return response.data || [];
  } catch {
    return [];
  }
}

/**
 * Fetch history for a movie and return { sourceTitle, torrentHash } from the
 * MOST RECENT "grabbed" or "downloadFolderImported" event.
 *
 * torrentHash is only set when downloadClient === 'qBittorrent' — in that case
 * it equals the qBit info-hash and can be used for a direct, zero-file-read match.
 */
async function getRadarrMovieHistory(instance, movieId) {
  try {
    const response = await axiosWithRetry({
      method: 'get',
      url: `${instance.url_internal}/api/v3/history/movie`,
      headers: { 'X-Api-Key': instance.api_key },
      params: { movieId, pageSize: 50, page: 1, sortKey: 'date', sortDirection: 'descending' },
      timeout: 10000
    }, { label: `Radarr history movie=${movieId}` });
    const records = response.data?.records || [];
    for (const rec of records) {
      if ((rec.eventType === 'grabbed' || rec.eventType === 'downloadFolderImported') && rec.sourceTitle) {
        const isQbit = rec.data?.downloadClient?.toLowerCase().includes('qbittorrent');
        // downloadId for qBit grabs = 40-char hex torrent info-hash
        const torrentHash = isQbit && rec.downloadId?.match(/^[0-9a-f]{40}$/i)
          ? rec.downloadId.toLowerCase()
          : null;
        return { sourceTitle: rec.sourceTitle, torrentHash };
      }
    }
    return { sourceTitle: null, torrentHash: null };
  } catch {
    return { sourceTitle: null, torrentHash: null };
  }
}

function extractSeasonNumber(rec) {
  if (rec.seasonNumber !== undefined && rec.seasonNumber !== null) return rec.seasonNumber;
  if (rec.episode && rec.episode.seasonNumber !== undefined && rec.episode.seasonNumber !== null) {
    return rec.episode.seasonNumber;
  }
  if (rec.sourceTitle) {
    const match = rec.sourceTitle.match(/(?:S|Season\s*|Staffel\s*)0?(\d{1,2})/i);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Fetch Sonarr series history and return a Map of seasonNumber -> { sourceTitle, torrentHash }
 * from the most recent grabbed/imported event for each season.
 */
async function getSonarrSeriesHistory(instance, seriesId) {
  try {
    const response = await axiosWithRetry({
      method: 'get',
      url: `${instance.url_internal}/api/v3/history/series`,
      headers: { 'X-Api-Key': instance.api_key },
      params: { seriesId },
      timeout: 15000
    }, { label: `Sonarr history series=${seriesId}` });
    
    const records = (response.data || []).sort((a, b) => new Date(b.date) - new Date(a.date));
    const seasonHistoryMap = new Map(); // seasonNumber (number) -> { sourceTitle, torrentHash }

    for (const rec of records) {
      if ((rec.eventType === 'grabbed' || rec.eventType === 'downloadFolderImported') && rec.sourceTitle) {
        const sNum = extractSeasonNumber(rec);
        if (sNum === null) continue;

        if (!seasonHistoryMap.has(sNum)) {
          let title = rec.sourceTitle;

          // Individual episode grab → strip episode number → season-pack name
          const isEpisode = /S\d{1,2}E\d{1,2}(?!-E)/i.test(title);
          if (isEpisode) {
            title = title.replace(/E\d{1,2}/i, '');
          }

          const isQbit = rec.data?.downloadClient?.toLowerCase().includes('qbittorrent');
          const rawHash = rec.downloadId || rec.data?.torrentInfoHash || '';
          const torrentHash = isQbit && rawHash.match(/^[0-9a-f]{40}$/i)
            ? rawHash.toLowerCase()
            : null;

          seasonHistoryMap.set(sNum, { sourceTitle: title, torrentHash });
        }
      }
    }
    return seasonHistoryMap;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Name-matching helpers
// ---------------------------------------------------------------------------

function sanitizeString(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getSanitizedVariations(aliases) {
  const result = new Set();
  for (let alias of aliases) {
    if (!alias) continue;
    let base = alias
      .replace(/\.(mkv|mp4|avi|ts|iso|srt|sub|nfo)$/i, '')
      .replace(/(\[|\{)[a-z]+-?[a-z0-9]+(\]|\})/gi, '');
    const variations = [
      base,
      base.replace(/(teil|part|vol|volume)[\s-]*(\d+)/ig, '$2'),
      base.replace(/&/g, 'und'),
      base.replace(/&/g, 'and'),
      base.replace(/ä/ig, 'ae').replace(/ö/ig, 'oe').replace(/ü/ig, 'ue').replace(/ß/ig, 'ss'),
      base.replace(/ä/ig, 'a').replace(/ö/ig, 'o').replace(/ü/ig, 'u').replace(/ß/ig, 's'),
      // Normalize spaces/dots to nothing (scene names use dots as spaces)
      base.replace(/[\s.]+/g, ''),
    ];
    for (const v of variations) {
      const s = sanitizeString(v);
      if (s && s.length > 3) result.add(s);
    }
  }
  return Array.from(result);
}

function matchSanitized(sanitizedAliases, sTorrentName) {
  if (!sTorrentName) return false;
  for (const sAlias of sanitizedAliases) {
    if (sAlias === sTorrentName) return true;
    if (sTorrentName.includes(sAlias) || sAlias.includes(sTorrentName)) {
      const diff = Math.abs(sAlias.length - sTorrentName.length);
      if (diff <= 25) return true;
    }
  }
  return false;
}

function isSeasonMatch(torrentName, seasonNumber) {
  if (!torrentName) return false;
  const regex = new RegExp(`(?:S|Season\\s*|Staffel\\s*)0?${seasonNumber}(?!\\d)`, 'i');
  return regex.test(torrentName);
}

// ---------------------------------------------------------------------------
// Tracker host matching helper
// ---------------------------------------------------------------------------

/**
 * Check if a torrent has at least one tracker whose host is in selectedTrackerHosts.
 * Uses the pre-fetched t._trackerHosts array.
 */
function torrentHasTracker(torrent, selectedTrackerHosts) {
  if (!selectedTrackerHosts || selectedTrackerHosts.length === 0) return true;
  if (!torrent._trackerHosts || torrent._trackerHosts.length === 0) return false;
  return selectedTrackerHosts.some(host => torrent._trackerHosts.includes(host));
}

// ---------------------------------------------------------------------------
// Scan orchestration
// ---------------------------------------------------------------------------

function checkCancel() {
  if (currentScanState.cancelRequested) {
    throw new Error('Scan cancelled by user');
  }
}


let lastScanResults = { media: [], tags: [], trackerHosts: [], timestamp: null };
let scanListeners = new Set();
let currentScanState = { isScanning: false, cancelRequested: false, globalStep: 'Idle', globalProgress: 0, instances: {} };

function getScannerState() {
  return currentScanState;
}

function cancelScan() {
  if (currentScanState.isScanning) {
    currentScanState.cancelRequested = true;
  }
}

function addScanListener(listener) {
  scanListeners.add(listener);
}

function removeScanListener(listener) {
  scanListeners.delete(listener);
}

function broadcastEvent(type, data) {
  if (type === 'progress') {
    if (data.global) {
      currentScanState.globalStep = data.step;
      currentScanState.globalProgress = data.progress;
    } else if (data.instanceName) {
      if (!currentScanState.instances) currentScanState.instances = {};
      currentScanState.instances[data.instanceName] = {
        step: data.step,
        progress: data.progress
      };
    }
    currentScanState.isScanning = true;
    
    // Broadcast the full state for progress events
    scanListeners.forEach(fn => {
      try { fn(type, currentScanState); } catch (e) { console.error('Broadcast error:', e); }
    });
  } else if (type === 'complete' || type === 'error') {
    currentScanState.isScanning = false;
    currentScanState.globalProgress = 100;
    currentScanState.globalStep = type === 'complete' ? 'Finished' : 'Error';
    currentScanState.instances = {}; // clear instances
    
    // Broadcast the actual final results or error message
    scanListeners.forEach(fn => {
      try { fn(type, data); } catch (e) { console.error('Broadcast error:', e); }
    });
  }
}

async function scanMedia(sendEvent) {
  const internalSendEvent = (type, data) => {
    broadcastEvent(type, data);
    if (sendEvent) {
      try { sendEvent(type, data); } catch {}
    }
  };

  try {
    console.log('Scanner: scanMedia initiated.');
    currentScanState.cancelRequested = false;
    // Clear old results from memory and DB at the start of a new scan
    lastScanResults = { media: [], tags: [], trackerHosts: [], timestamp: null };
    db.setSetting('last_results', JSON.stringify(lastScanResults));
    
    internalSendEvent('progress', { global: true, step: 'Initializing', progress: 0 });

    const qbitUrl      = db.getSetting('qbit_url', '');
    const qbitUser     = db.getSetting('qbit_user', '');
    const qbitPass     = db.getSetting('qbit_password', '');
    const matchMode    = db.getSetting('match_mode', 'hardlink'); // 'hardlink' | 'fast_hash' | 'hybrid' | 'name_then_size' | 'name_only' | 'size_only'
    const selectedTrackerHosts = db.getSetting('selected_tracker_hosts', []); // [] = no filter (all)
    const pathReplaceFrom = db.getSetting('path_replace_from', '');
    const pathReplaceTo   = db.getSetting('path_replace_to', '');

    if (!qbitUrl) throw new Error('qBittorrent is not configured.');

    internalSendEvent('progress', { global: true, step: 'Logging into qBittorrent...', progress: 10 });
    console.log(`Logging into qBittorrent at ${qbitUrl}...`);
    const cookie = await getQbitAuthCookie(qbitUrl, qbitUser, qbitPass);

    internalSendEvent('progress', { global: true, step: 'Fetching qBittorrent Torrents...', progress: 15 });
    console.log('Fetching torrent list from qBittorrent...');
    let allTorrents = await getQbitTorrents(qbitUrl, cookie);
    console.log(`Fetched ${allTorrents.length} torrents.`);

    const allTags = new Set();
    const allTrackerHosts = new Set();

    // Pre-sanitize torrent names
    allTorrents.forEach(t => {
      // Strip video extension for single-file torrents (e.g. "Movie.2022.mkv" → "Movie.2022")
      // so they match Radarr/Sonarr scene names which never include the extension.
      const strippedName = t.name.replace(/\.(mkv|mp4|avi|ts|m2ts|mov|wmv|flv|webm|iso)$/i, '');
      t.sName = sanitizeString(strippedName);
      if (t.tags) t.tags.split(',').forEach(tag => allTags.add(tag.trim()));
    });

  // Pre-fetch tracker hosts for tracker-filtered scan
  internalSendEvent('progress', { global: true, step: 'Fetching tracker info (UI may be slow)...', progress: 18 });
  console.log('Fetching tracker information for all torrents...');
  const TRACKER_BATCH = 20;
  let processedCount = 0;
  for (let i = 0; i < allTorrents.length; i += TRACKER_BATCH) {
    const batch = allTorrents.slice(i, i + TRACKER_BATCH);
    await Promise.all(batch.map(async (t) => {
      try {
        const trackers = await getQbitTorrentTrackers(qbitUrl, cookie, t.hash);
        t._trackerHosts = trackers.map(u => { 
          try { return new URL(u).host; } catch { return u; } 
        }).filter(Boolean);
        t._trackerHosts.forEach(h => allTrackerHosts.add(h));
      } catch (err) {
        console.error(`Failed to fetch trackers for ${t.name}:`, err.message);
      } finally {
        processedCount++;
        // Update UI every 5 items to show constant progress without flooding the connection
        if (processedCount % 5 === 0 || processedCount === allTorrents.length) {
          internalSendEvent('progress', { 
            global: true, 
            step: `Fetching tracker info (${processedCount}/${allTorrents.length})...`, 
            progress: 18 + Math.floor((processedCount / allTorrents.length) * 5)
          });
        }
      }
    }));
    
    checkCancel();
    // Yield to event loop after each batch
    await new Promise(resolve => setImmediate(resolve));
  }
  console.log('Finished fetching tracker info.');
  internalSendEvent('progress', { global: true, step: 'Applying tracker filters...', progress: 24 });

  // We no longer filter torrents in the backend!
  // The backend always matches against ALL torrents so we know exactly which trackers a file is seeding on.
  // The UI will handle the tracker filtering dynamically to decide if it's "missing" from the selected tracker.
  const torrents = allTorrents;

  internalSendEvent('progress', { global: true, step: `Starting file index (${torrents.length} items)...`, progress: 25 });
  await new Promise(resolve => setImmediate(resolve)); // Yield to flush messages

  checkCancel();

  // Build inode index when hardlink mode is active
  let inodeIndex = null;
  if (matchMode === 'hardlink') {
    inodeIndex = await buildInodeIndex(torrents, pathReplaceFrom, pathReplaceTo, (type, data) => {
      internalSendEvent(type, { global: true, ...data });
    });
  }

  // Build partial hash index when fast_hash mode is active
  let hashIndex = null;
  if (matchMode === 'fast_hash') {
    hashIndex = await buildFastHashIndex(torrents, pathReplaceFrom, pathReplaceTo, (type, data) => {
      internalSendEvent(type, { global: true, ...data });
    });
  }

  // Build size index when needed
  let sizeIndex = null;
  if (matchMode !== 'name_only' && matchMode !== 'hybrid' && matchMode !== 'hardlink' && matchMode !== 'fast_hash') {
    sizeIndex = await buildSizeIndex(torrents, qbitUrl, cookie, (type, data) => {
      internalSendEvent(type, { global: true, ...data });
    });
    console.log(`Size index built: ${sizeIndex.size} unique sizes.`);
  }

  const instances = db.getInstances();
  
  internalSendEvent('progress', { global: true, step: 'Scanning Arr instances...', progress: 50 });
  
  const instancePromises = instances.map(async (instance) => {
    const instanceResults = [];
    const instanceSendEvent = (step, progress) => {
      internalSendEvent('progress', { instanceName: instance.name, step, progress });
    };

    if (currentScanState.cancelRequested) return [];

    console.log(`Starting scan of instance: ${instance.name} (${instance.type})`);

    if (instance.type === 'radarr') {
      const movies = await getRadarrMovies(instance);

      // ── Pre-fetch all history in batches (concurrency-controlled) ──
      const needsHistory = matchMode === 'hybrid' || matchMode === 'hardlink' || matchMode === 'fast_hash';
      const movieHistoryMap = new Map(); // movieId → { sourceTitle, torrentHash }
      if (needsHistory && movies.length > 0) {
        const HISTORY_BATCH = 10;
        let historyFailed = 0;
        const historyStartTime = Date.now();
        instanceSendEvent(`Fetching history (0/${movies.length})...`, 0);

        for (let i = 0; i < movies.length; i += HISTORY_BATCH) {
          checkCancel();
          const batch = movies.slice(i, i + HISTORY_BATCH);

          await Promise.all(batch.map(async (movie) => {
            const hist = await getRadarrMovieHistory(instance, movie.id);
            if (hist.sourceTitle || hist.torrentHash) {
              movieHistoryMap.set(movie.id, hist);
            } else {
              // Track if we got no data (might be a real "no history" or a failed call)
              movieHistoryMap.set(movie.id, hist);
            }
          })).catch(err => {
            historyFailed += batch.length;
            console.warn(`History batch failed for ${instance.name}: ${err.message}`);
          });

          // Progress + ETA
          const done = Math.min(i + HISTORY_BATCH, movies.length);
          const elapsed = Date.now() - historyStartTime;
          const avgTime = elapsed / done;
          const remaining = movies.length - done;
          const etaSec = Math.round((remaining * avgTime) / 1000);
          const eta = etaSec > 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : `${etaSec}s`;
          const pct = Math.floor((done / movies.length) * 40);
          instanceSendEvent(`Fetching history (${done}/${movies.length}) - noch ca. ${eta}`, Math.min(40, pct));

          // Small cooldown to avoid overwhelming Radarr
          if (i + HISTORY_BATCH < movies.length) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }

        if (historyFailed > 0) {
          console.warn(`Radarr ${instance.name}: ${historyFailed}/${movies.length} history calls failed after retries.`);
        }
        console.log(`Radarr ${instance.name}: History pre-fetch done. ${movieHistoryMap.size} entries, ${historyFailed} failed.`);
      }

      // ── Now match each movie (fast — no more API calls) ──
      for (let i = 0; i < movies.length; i++) {
        checkCancel();
        const movie = movies[i];
        
        // Update UI and yield every 10 items to reduce overhead
        if ((i + 1) % 10 === 0 || (i + 1) === movies.length) {
          const itemProgress = 40 + Math.floor(((i + 1) / movies.length) * 59);
          instanceSendEvent(`[${i + 1}/${movies.length}] ${movie.title}`, Math.min(99, itemProgress));
          await new Promise(resolve => setImmediate(resolve));
        }

        const mf = movie.movieFile;

        // ── Build aliases ────────────────────────────────────────────
        // Priority: sceneName > relativePath > title/folder
        const fileAliases = [mf?.sceneName, mf?.relativePath].filter(Boolean);
        const baseAliases = fileAliases.length > 0
          ? fileAliases
          : [movie.title, movie.originalTitle, movie.folderName].filter(Boolean);

        // ── Use pre-fetched history ────────────────────────────
        let historySourceTitle = null;
        let historyTorrentHash = null;
        if (needsHistory) {
          const hist = movieHistoryMap.get(movie.id) || { sourceTitle: null, torrentHash: null };
          historySourceTitle = hist.sourceTitle;
          historyTorrentHash = hist.torrentHash;
        }

        // Combine all aliases (history name takes priority)
        const allAliases = historySourceTitle
          ? [historySourceTitle, ...baseAliases]
          : baseAliases;

        const sanitizedAliases = getSanitizedVariations(allAliases);

        // ── Matching ─────────────────────────────────────────────────
        let matchingTorrents = [];
        let matchMethod = 'none';

        // Step -2: Partial Hash match — read first/last 1MB
        if (matchMode === 'fast_hash' && hashIndex && mf) {
          const arrFilePath = mf.path || (movie.path && mf.relativePath ? nodePath.join(movie.path, mf.relativePath) : null);
          if (arrFilePath) {
            const hashMatches = matchByPartialHash(hashIndex, arrFilePath, pathReplaceFrom, pathReplaceTo);
            if (hashMatches && hashMatches.length > 0) { matchingTorrents = hashMatches; matchMethod = 'fast_hash'; }
          }
        }

        // Step -1: Hardlink (inode) match — only stat() calls, no file reads
        if (matchingTorrents.length === 0 && matchMode === 'hardlink' && inodeIndex && mf) {
          const arrFilePath = mf.path || (movie.path && mf.relativePath ? nodePath.join(movie.path, mf.relativePath) : null);
          if (arrFilePath) {
            const inoMatches = matchByInode(inodeIndex, arrFilePath, pathReplaceFrom, pathReplaceTo);
            if (inoMatches && inoMatches.length > 0) { matchingTorrents = inoMatches; matchMethod = 'hardlink'; }
          }
        }

        // Step 0: Direct torrent hash match (hybrid/hardlink/fast_hash, qBit downloads)
        // downloadId from Radarr IS the qBit info-hash — zero file reads, 100% accurate.
        if (matchingTorrents.length === 0 && (matchMode === 'hybrid' || matchMode === 'hardlink' || matchMode === 'fast_hash') && historyTorrentHash) {
          const hashMatch = torrents.find(t => t.hash?.toLowerCase() === historyTorrentHash);
          if (hashMatch) { matchingTorrents = [hashMatch]; matchMethod = 'hash'; }
        }

        // Step 1: Name match (always try unless size_only or already matched)
        if (matchingTorrents.length === 0 && matchMode !== 'size_only') {
          matchingTorrents = torrents.filter(t => matchSanitized(sanitizedAliases, t.sName));
          if (matchingTorrents.length > 0) matchMethod = (matchMode === 'hybrid' || matchMode === 'hardlink' || matchMode === 'fast_hash') && historySourceTitle ? 'history' : 'name';
        }

        // Step 2: Size fallback
        if (matchingTorrents.length === 0 && mf?.size) {
          if (matchMode === 'size_only' || matchMode === 'name_then_size') {
            if (!sizeIndex) {
              sizeIndex = await buildSizeIndex(torrents, qbitUrl, cookie, () => {});
            }
            const sizeTorrent = matchBySize(sizeIndex, mf.size);
            if (sizeTorrent) { matchingTorrents = [sizeTorrent]; matchMethod = 'size'; }
          }
        }

        // ── Tags + Tracker hosts ──────────────────────────────────────
        const mediaTags = new Set();
        const mediaTrackerHosts = new Set();
        matchingTorrents.forEach(t => {
          if (t.tags) t.tags.split(',').forEach(tag => mediaTags.add(tag.trim()));
          if (t._trackerHosts) t._trackerHosts.forEach(h => mediaTrackerHosts.add(h));
        });

        const actualPath = movie.path;
        const releaseName = matchingTorrents.length > 0 ? matchingTorrents[0].name : (mf ? (mf.sceneName || mf.relativePath || movie.title) : movie.title);
        const isGerman = hasGermanLanguage(movie, mf, releaseName);
        const arrLanguage = getLanguageSummary(mf);

        instanceResults.push({
          id: `radarr-${instance.name}-${movie.id}`,
          title: movie.title,
          type: 'movie',
          instanceName: instance.name,
          arrUrl: `${instance.url_external}/movie/${movie.titleSlug}`,
          path: actualPath,
          releaseName,
          fileName: mf ? mf.relativePath : '',
          qbitTags: Array.from(mediaTags),
          qbitTrackerHosts: Array.from(mediaTrackerHosts),
          inQbit: matchingTorrents.length > 0,
          matchMethod,
          isGerman,
          arrLanguage,
          matchedTorrents: matchingTorrents.map(t => ({ hash: t.hash, name: t.name, content_path: t.content_path, tags: t.tags, category: t.category }))
        });
      }

    } else if (instance.type === 'sonarr') {
      const series = await getSonarrSeries(instance);
      const needsHistory = matchMode === 'hybrid' || matchMode === 'hardlink' || matchMode === 'fast_hash';

      // ── Pre-fetch all history + episode files in batches ──
      const seriesHistoryMap = new Map(); // seriesId → { sourceTitle, torrentHash }
      const seriesEpFilesMap = new Map(); // seriesId → episodeFiles[]
      if (series.length > 0) {
        const SERIES_BATCH = 10;
        let batchFailed = 0;
        const batchStartTime = Date.now();
        instanceSendEvent(`Fetching series data (0/${series.length})...`, 0);

        for (let i = 0; i < series.length; i += SERIES_BATCH) {
          checkCancel();
          const batch = series.slice(i, i + SERIES_BATCH);

          await Promise.all(batch.map(async (show) => {
            // Fetch episode files
            try {
              const epFiles = await getSonarrEpisodeFiles(instance, show.id);
              seriesEpFilesMap.set(show.id, epFiles);
            } catch {
              seriesEpFilesMap.set(show.id, []);
            }

            // Fetch history if needed
            if (needsHistory) {
              const hist = await getSonarrSeriesHistory(instance, show.id);
              seriesHistoryMap.set(show.id, hist);
            }
          })).catch(err => {
            batchFailed += batch.length;
            console.warn(`Sonarr batch failed for ${instance.name}: ${err.message}`);
          });

          // Progress + ETA
          const done = Math.min(i + SERIES_BATCH, series.length);
          const elapsed = Date.now() - batchStartTime;
          const avgTime = elapsed / done;
          const remaining = series.length - done;
          const etaSec = Math.round((remaining * avgTime) / 1000);
          const eta = etaSec > 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : `${etaSec}s`;
          const pct = Math.floor((done / series.length) * 40);
          instanceSendEvent(`Fetching series data (${done}/${series.length}) - noch ca. ${eta}`, Math.min(40, pct));

          // Small cooldown
          if (i + SERIES_BATCH < series.length) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }

        if (batchFailed > 0) {
          console.warn(`Sonarr ${instance.name}: ${batchFailed}/${series.length} series batch calls failed.`);
        }
        console.log(`Sonarr ${instance.name}: Pre-fetch done. ${seriesEpFilesMap.size} ep-file sets, ${seriesHistoryMap.size} history entries.`);
      }

      // ── Now match each series/season (fast — no more API calls) ──
      for (let i = 0; i < series.length; i++) {
        checkCancel();
        const show = series[i];

        // Update UI and yield every 10 items to reduce overhead
        if ((i + 1) % 10 === 0 || (i + 1) === series.length) {
          const itemProgress = 40 + Math.floor(((i + 1) / series.length) * 59);
          instanceSendEvent(`[${i + 1}/${series.length}] ${show.title}`, Math.min(99, itemProgress));
          await new Promise(resolve => setImmediate(resolve));
        }

        if (!show.seasons) continue;

        const episodeFiles = seriesEpFilesMap.get(show.id) || [];
        const showHistMap = seriesHistoryMap.get(show.id);

        for (const season of show.seasons) {
          if (!season.statistics || season.statistics.episodeFileCount === 0) continue;
          const sNum = season.seasonNumber;
          const seasonFiles = episodeFiles.filter(f => f.seasonNumber === sNum);

          // Get history for THIS specific season
          let historySourceTitle = null;
          let historyTorrentHash = null;
          if (needsHistory && showHistMap && showHistMap.has(sNum)) {
            const hist = showHistMap.get(sNum);
            historySourceTitle = hist.sourceTitle;
            historyTorrentHash = hist.torrentHash;
          }

          const seasonSceneNames = [...new Set(seasonFiles.map(f => f.sceneName).filter(Boolean))];
          const seasonPaths     = [...new Set(seasonFiles.map(f => f.relativePath).filter(Boolean))];

          const fileAliases = seasonSceneNames.length > 0 || seasonPaths.length > 0
            ? [...seasonSceneNames, ...seasonPaths]
            : [show.title, show.originalTitle, show.path.split(/[/\\]/).pop()].filter(Boolean);

          const allAliases = historySourceTitle ? [historySourceTitle, ...fileAliases] : fileAliases;
          const sanitizedAliases = getSanitizedVariations(allAliases);

          let matchingTorrents = [];
          let matchMethod = 'none';

          // Step -2: Partial Hash match on episode files
          if (matchMode === 'fast_hash' && hashIndex && seasonFiles.length > 0) {
            for (const ef of seasonFiles) {
              const arrFilePath = ef.path || (show.path && ef.relativePath ? nodePath.join(show.path, ef.relativePath) : null);
              if (arrFilePath) {
                const hashMatches = matchByPartialHash(hashIndex, arrFilePath, pathReplaceFrom, pathReplaceTo);
                if (hashMatches && hashMatches.length > 0) { matchingTorrents = hashMatches; matchMethod = 'fast_hash'; break; }
              }
            }
          }

          // Step -1: Hardlink (inode) match on episode files
          if (matchingTorrents.length === 0 && matchMode === 'hardlink' && inodeIndex && seasonFiles.length > 0) {
            for (const ef of seasonFiles) {
              const arrFilePath = ef.path || (show.path && ef.relativePath ? nodePath.join(show.path, ef.relativePath) : null);
              if (arrFilePath) {
                const inoMatches = matchByInode(inodeIndex, arrFilePath, pathReplaceFrom, pathReplaceTo);
                if (inoMatches && inoMatches.length > 0) { matchingTorrents = inoMatches; matchMethod = 'hardlink'; break; }
              }
            }
          }

          // Step 0: Direct hash match (hybrid/hardlink/fast_hash + qBit download)
          if (matchingTorrents.length === 0 && (matchMode === 'hybrid' || matchMode === 'hardlink' || matchMode === 'fast_hash') && historyTorrentHash) {
            const hashMatch = torrents.find(t => t.hash?.toLowerCase() === historyTorrentHash);
            if (hashMatch) { matchingTorrents = [hashMatch]; matchMethod = 'hash'; }
          }

          // Step 1: Name + season match
          if (matchingTorrents.length === 0 && matchMode !== 'size_only') {
            matchingTorrents = torrents.filter(t =>
              matchSanitized(sanitizedAliases, t.sName) && isSeasonMatch(t.name, sNum)
            );
            if (matchingTorrents.length > 0) matchMethod = (matchMode === 'hybrid' || matchMode === 'hardlink' || matchMode === 'fast_hash') && historySourceTitle ? 'history' : 'name';
          }

          if (matchingTorrents.length === 0 && seasonFiles.length > 0) {
            if (matchMode === 'size_only' || matchMode === 'name_then_size') {
              if (!sizeIndex) {
                console.log('Dynamic size index build started for Sonarr...');
                sizeIndex = await buildSizeIndex(torrents, qbitUrl, cookie, internalSendEvent);
              }
              for (const ef of seasonFiles) {
                const sizeTorrent = matchBySize(sizeIndex, ef.size);
                if (sizeTorrent) { matchingTorrents = [sizeTorrent]; matchMethod = 'size'; break; }
              }
            }
          }

          const mediaTags = new Set();
          const mediaTrackerHosts = new Set();
          matchingTorrents.forEach(t => {
            if (t.tags) t.tags.split(',').forEach(tag => mediaTags.add(tag.trim()));
            if (t._trackerHosts) t._trackerHosts.forEach(h => mediaTrackerHosts.add(h));
          });

          // Determine real season folder path from files if available
          let seasonFolderPath = null;
          if (seasonFiles.length > 0 && seasonFiles[0].relativePath) {
            const relDir = nodePath.dirname(seasonFiles[0].relativePath);
            if (relDir && relDir !== '.' && relDir !== '') {
              seasonFolderPath = nodePath.join(show.path, relDir).replace(/\\/g, '/');
            }
          }
          const actualPath = seasonFolderPath || (sNum === 0 ? `${show.path}/Specials` : `${show.path}/Season ${sNum}`);
          const seasonFileNames = seasonFiles.map(f => f.relativePath || f.sceneName || '').join(' | ');
          const releaseName = matchingTorrents.length > 0
            ? matchingTorrents[0].name
            : (historySourceTitle || `${show.path.split(/[/\\]/).pop()} S${String(sNum).padStart(2, '0')}`);
          const isGerman = hasGermanLanguage(show, seasonFiles, releaseName);
          const arrLanguage = getLanguageSummary(seasonFiles);

          instanceResults.push({
            id: `sonarr-${instance.name}-${show.id}-s${sNum}`,
            title: `${show.title} - Season ${sNum}`,
            type: 'series',
            instanceName: instance.name,
            arrUrl: `${instance.url_external}/series/${show.titleSlug}`,
            path: actualPath,
            releaseName,
            fileName: seasonFileNames,
            qbitTags: Array.from(mediaTags),
            qbitTrackerHosts: Array.from(mediaTrackerHosts),
            inQbit: matchingTorrents.length > 0,
            matchMethod,
            isGerman,
            arrLanguage,
            matchedTorrents: matchingTorrents.map(t => ({ hash: t.hash, name: t.name, content_path: t.content_path, tags: t.tags, category: t.category }))
          });
        }
      }
    }

    // ── Per-instance summary log ──────────────────────────────────────
    const iTotal    = instanceResults.length;
    const iHardlink = instanceResults.filter(r => r.matchMethod === 'hardlink').length;
    const iHash     = instanceResults.filter(r => r.matchMethod === 'hash').length;
    const iHistory  = instanceResults.filter(r => r.matchMethod === 'history').length;
    const iName     = instanceResults.filter(r => r.matchMethod === 'name').length;
    const iSize     = instanceResults.filter(r => r.matchMethod === 'size').length;
    const iMissing  = instanceResults.filter(r => r.matchMethod === 'none').length;
    const iType     = instanceResults[0]?.type ?? instance.type;
    console.log(
      `[${instance.name}] done: ${iTotal} ${iType}(s) | ` +
      `hardlink=${iHardlink}, hash=${iHash}, history=${iHistory}, name=${iName}, size=${iSize}, missing=${iMissing}`
    );
    // Log first unmatched item to help diagnose path/name issues
    const firstMissing = instanceResults.find(r => r.matchMethod === 'none');
    if (firstMissing) {
      console.log(`  [${instance.name}] first unmatched: "${firstMissing.title}" | path=${firstMissing.path} | releaseName=${firstMissing.releaseName}`);
    }
    // Log first matched item to confirm data looks right
    const firstMatched = instanceResults.find(r => r.matchMethod !== 'none');
    if (firstMatched) {
      console.log(`  [${instance.name}] first matched (${firstMatched.matchMethod}): "${firstMatched.title}" | qbitPath=${firstMatched.path}`);
    }

    instanceSendEvent('Finished', 100);
    return instanceResults;
  });

  let finalMedia = [];
  for (const res of await Promise.all(instancePromises)) {
    if (res) finalMedia = finalMedia.concat(res);
  }

  if (currentScanState.cancelRequested) {
    throw new Error('Scan cancelled by user');
  }

  const results = finalMedia;

  internalSendEvent('progress', { global: true, step: 'Finalizing...', progress: 100 });

  const hardlinkMatches = results.filter(r => r.matchMethod === 'hardlink').length;
  const hashMatches     = results.filter(r => r.matchMethod === 'hash').length;
  const historyMatches  = results.filter(r => r.matchMethod === 'history').length;
  const nameMatches     = results.filter(r => r.matchMethod === 'name').length;
  const sizeMatches     = results.filter(r => r.matchMethod === 'size').length;
  const missing         = results.filter(r => r.matchMethod === 'none').length;
  const movieCount      = results.filter(r => r.type === 'movie').length;
  const seriesCount     = results.filter(r => r.type === 'series').length;

  console.log(
    `Scan done: ${results.length} items (movies=${movieCount}, series=${seriesCount}) | ` +
    `hardlink=${hardlinkMatches}, hash=${hashMatches}, history=${historyMatches}, name=${nameMatches}, size=${sizeMatches}, missing=${missing} | ` +
    `mode=${matchMode}`
  );

  const finalResults = {
    media: results,
    tags: Array.from(allTags).filter(t => t),
    trackerHosts: Array.from(allTrackerHosts).sort(),
    timestamp: new Date().toISOString(),
    matchMode
  };

  lastScanResults = finalResults;
  db.setSetting('last_results', JSON.stringify(finalResults));

    internalSendEvent('complete', finalResults);
    return finalResults;
  } catch (err) {
    console.error('Scanner: scanMedia error:', err);
    internalSendEvent('error', { message: err.message });
    throw err;
  }
}

function getLastResults() {
  return lastScanResults;
}

async function testQbit(url, username, password) {
  const cookie = await getQbitAuthCookie(url, username, password);
  await getQbitTorrents(url, cookie);
  return true;
}

async function testArr(type, url, apiKey) {
  const endpoint = type === 'radarr' ? '/api/v3/movie' : '/api/v3/series';
  await axios.get(`${url}${endpoint}`, {
    headers: { 'X-Api-Key': apiKey },
    params: { limit: 1 }
  });
  return true;
}

/**
 * Fetch all unique tracker hosts from qBit (for the dropdown).
 */
async function fetchTrackerHosts(url, username, password) {
  const cookie = await getQbitAuthCookie(url, username, password);
  const torrents = await getQbitTorrents(url, cookie);
  return getAllTrackerUrls(url, cookie, torrents);
}

module.exports = {
  scanMedia,
  getScannerState,
  cancelScan,
  addScanListener,
  removeScanListener,
  getLastResults,
  testQbit,
  testArr,
  fetchTrackerHosts
};
