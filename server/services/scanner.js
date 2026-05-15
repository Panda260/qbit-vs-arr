const axios = require('axios');
const fs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');
const db = require('./db');

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
          seen.add(host); // store just the host for readability
        } catch {
          // skip invalid URLs
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
function walkDirForVideos(dirPath, torrent, inodeIndex) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = nodePath.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walkDirForVideos(fullPath, torrent, inodeIndex);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.test(entry.name)) {
        try {
          const st = fs.statSync(fullPath);
          if (st.size >= MKV_MIN_SIZE_BYTES) {
            const key = `${st.dev}:${st.ino}`;
            if (!inodeIndex.has(key)) inodeIndex.set(key, torrent);
          }
        } catch { /* inaccessible file, skip */ }
      }
    }
  } catch { /* inaccessible dir, skip */ }
}

/**
 * Build a Map of "dev:ino" → torrent for all video files in each torrent's
 * content_path. Uses only stat() — no file content is read.
 */
async function buildInodeIndex(torrents, pathFrom, pathTo, sendEvent) {
  const inodeIndex = new Map();
  if (sendEvent) sendEvent('progress', { global: true, step: `Building hardlink inode index for ${torrents.length} torrents...`, progress: 20 });

  let skipped = 0;
  for (let i = 0; i < torrents.length; i++) {
    const torrent = torrents[i];
    const rawPath = torrent.content_path;
    if (!rawPath) continue;
    const localPath = rewritePath(rawPath, pathFrom, pathTo);
    try {
      const st = fs.statSync(localPath);
      if (st.isFile()) {
        if (VIDEO_EXTENSIONS.test(localPath) && st.size >= MKV_MIN_SIZE_BYTES) {
          const key = `${st.dev}:${st.ino}`;
          if (!inodeIndex.has(key)) inodeIndex.set(key, torrent);
        }
      } else if (st.isDirectory()) {
        walkDirForVideos(localPath, torrent, inodeIndex);
      }
    } catch { skipped++; }

    if ((i + 1) % 50 === 0 && sendEvent) {
      const pct = Math.min(30, 20 + Math.floor(((i + 1) / torrents.length) * 10));
      sendEvent('progress', { global: true, step: `Building inode index... (${i + 1}/${torrents.length})`, progress: pct });
    }
  }
  console.log(`Inode index built: ${inodeIndex.size} unique video files indexed, ${skipped} torrent paths inaccessible.`);
  return inodeIndex;
}

/**
 * Check if a given file path shares an inode with any torrent in the index.
 * Returns the matching torrent or null.
 * Uses nlink > 1 as a fast pre-check (no hardlinks → skip immediately).
 */
function matchByInode(inodeIndex, filePath, pathFrom, pathTo) {
  if (!filePath || !inodeIndex || inodeIndex.size === 0) return null;
  const localPath = rewritePath(filePath, pathFrom, pathTo);
  try {
    const st = fs.statSync(localPath);
    if (st.nlink <= 1) return null; // file has no hardlinks elsewhere
    const key = `${st.dev}:${st.ino}`;
    return inodeIndex.get(key) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Partial Hash index builder
// ---------------------------------------------------------------------------

const HASH_SAMPLE_SIZE = 1 * 1024 * 1024; // 1MB

function calculatePartialHash(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size < MKV_MIN_SIZE_BYTES) return null;

    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(HASH_SAMPLE_SIZE);
    fs.readSync(fd, head, 0, HASH_SAMPLE_SIZE, 0);

    let tail = Buffer.alloc(0);
    if (stats.size > HASH_SAMPLE_SIZE * 2) {
      tail = Buffer.alloc(HASH_SAMPLE_SIZE);
      fs.readSync(fd, tail, 0, HASH_SAMPLE_SIZE, stats.size - HASH_SAMPLE_SIZE);
    }
    fs.closeSync(fd);

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
function walkDirForHashes(dirPath, torrent, hashIndex) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = nodePath.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walkDirForHashes(fullPath, torrent, hashIndex);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.test(entry.name)) {
        const hashKey = calculatePartialHash(fullPath);
        if (hashKey) {
          if (!hashIndex.has(hashKey)) hashIndex.set(hashKey, torrent);
        }
      }
    }
  } catch { /* skip */ }
}

async function buildFastHashIndex(torrents, pathFrom, pathTo, sendEvent) {
  const hashIndex = new Map();
  if (sendEvent) sendEvent('progress', { global: true, step: `Building partial hash index for ${torrents.length} torrents...`, progress: 20 });

  for (let i = 0; i < torrents.length; i++) {
    const torrent = torrents[i];
    const localPath = rewritePath(torrent.content_path, pathFrom, pathTo);
    try {
      const st = fs.statSync(localPath);
      if (st.isFile()) {
        const hashKey = calculatePartialHash(localPath);
        if (hashKey && !hashIndex.has(hashKey)) hashIndex.set(hashKey, torrent);
      } else if (st.isDirectory()) {
        walkDirForHashes(localPath, torrent, hashIndex);
      }
    } catch { /* skip */ }

    if ((i + 1) % 50 === 0 && sendEvent) {
      const pct = Math.min(30, 20 + Math.floor(((i + 1) / torrents.length) * 10));
      sendEvent('progress', { global: true, step: `Building hash index... (${i + 1}/${torrents.length})`, progress: pct });
    }
  }
  console.log(`Partial hash index built: ${hashIndex.size} files indexed.`);
  return hashIndex;
}

function matchByPartialHash(hashIndex, filePath, pathFrom, pathTo) {
  if (!filePath || !hashIndex || hashIndex.size === 0) return null;
  const localPath = rewritePath(filePath, pathFrom, pathTo);
  const hashKey = calculatePartialHash(localPath);
  return hashKey ? hashIndex.get(hashKey) || null : null;
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
    const response = await axios.get(`${instance.url_internal}/api/v3/movie`, {
      headers: { 'X-Api-Key': instance.api_key }
    });
    return response.data.filter(m => m.hasFile);
  } catch (error) {
    console.error(`Failed to fetch Radarr movies (${instance.name}):`, error.message);
    return [];
  }
}

async function getSonarrSeries(instance) {
  try {
    const response = await axios.get(`${instance.url_internal}/api/v3/series`, {
      headers: { 'X-Api-Key': instance.api_key }
    });
    return response.data.filter(s => s.statistics && s.statistics.episodeFileCount > 0);
  } catch (error) {
    console.error(`Failed to fetch Sonarr series (${instance.name}):`, error.message);
    return [];
  }
}

async function getSonarrEpisodeFiles(instance, seriesId) {
  try {
    const response = await axios.get(`${instance.url_internal}/api/v3/episodefile?seriesId=${seriesId}`, {
      headers: { 'X-Api-Key': instance.api_key }
    });
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
    const response = await axios.get(`${instance.url_internal}/api/v3/history`, {
      headers: { 'X-Api-Key': instance.api_key },
      params: { movieId, pageSize: 50, page: 1, sortKey: 'date', sortDirection: 'descending' }
    });
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

/**
 * Fetch Sonarr series history and return { sourceTitle, torrentHash } from the
 * most recent grabbed/imported event. For individual episode grabs, strips
 * the episode number so the result works as a season-pack name.
 */
async function getSonarrSeriesHistory(instance, seriesId) {
  try {
    const response = await axios.get(`${instance.url_internal}/api/v3/history/series`, {
      headers: { 'X-Api-Key': instance.api_key },
      params: { seriesId }
    });
    const records = (response.data || []).sort((a, b) => new Date(b.date) - new Date(a.date));
    for (const rec of records) {
      if ((rec.eventType === 'grabbed' || rec.eventType === 'downloadFolderImported') && rec.sourceTitle) {
        let title = rec.sourceTitle;

        // Individual episode grab → strip episode number → season-pack name
        // e.g. "Hijack.S01E07.GERMAN..." → "Hijack.S01.GERMAN..."
        // Guard: don't strip multi-episode ranges like S01E01-E07
        const isEpisode = /S\d{1,2}E\d{1,2}(?!-E)/i.test(title);
        if (isEpisode) {
          title = title.replace(/E\d{1,2}/i, '');
        }

        const isQbit = rec.data?.downloadClient?.toLowerCase().includes('qbittorrent');
        const rawHash = rec.downloadId || rec.data?.torrentInfoHash || '';
        const torrentHash = isQbit && rawHash.match(/^[0-9a-f]{40}$/i)
          ? rawHash.toLowerCase()
          : null;

        return { sourceTitle: title, torrentHash };
      }
    }
    return { sourceTitle: null, torrentHash: null };
  } catch {
    return { sourceTitle: null, torrentHash: null };
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

let lastScanResults = { media: [], tags: [], trackerHosts: [], timestamp: null };
let scanListeners = new Set();
let currentScanState = { isScanning: false, globalStep: 'Idle', globalProgress: 0, instances: {} };

function getScannerState() {
  return currentScanState;
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

  console.log('Scanner: scanMedia initiated.');
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
        t._trackerHosts = trackers.map(u => { try { return new URL(u).host; } catch { return null; } }).filter(Boolean);
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
    
    // Yield to event loop after each batch
    await new Promise(resolve => setImmediate(resolve));
  }
  console.log('Finished fetching tracker info.');

  // Apply tracker filter: only consider torrents matching selected tracker hosts
  const torrents = selectedTrackerHosts.length > 0
    ? allTorrents.filter(t => torrentHasTracker(t, selectedTrackerHosts))
    : allTorrents;

  console.log(`Tracker filter: ${selectedTrackerHosts.length > 0 ? selectedTrackerHosts.join(',') : 'none'} → ${torrents.length}/${allTorrents.length} torrents active`);

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

    instanceSendEvent(`Starting scan...`, 0);
    console.log(`Starting scan of instance: ${instance.name} (${instance.type})`);

    if (instance.type === 'radarr') {
      const movies = await getRadarrMovies(instance);

      for (let i = 0; i < movies.length; i++) {
        const movie = movies[i];
        const itemProgress = Math.floor(((i + 1) / movies.length) * 100);
        instanceSendEvent(`[${i + 1}/${movies.length}] ${movie.title}`, Math.min(99, itemProgress));
        await new Promise(resolve => setImmediate(resolve));

        const mf = movie.movieFile;

        // ── Build aliases ────────────────────────────────────────────
        // Priority: sceneName > relativePath > title/folder
        const fileAliases = [mf?.sceneName, mf?.relativePath].filter(Boolean);
        const baseAliases = fileAliases.length > 0
          ? fileAliases
          : [movie.title, movie.originalTitle, movie.folderName].filter(Boolean);

        // ── HYBRID / HARDLINK / FAST_HASH MODE: fetch history ────────────────────────────
        let historySourceTitle = null;
        let historyTorrentHash = null;
        if (matchMode === 'hybrid' || matchMode === 'hardlink' || matchMode === 'fast_hash') {
          const hist = await getRadarrMovieHistory(instance, movie.id);
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
            const hashMatch = matchByPartialHash(hashIndex, arrFilePath, pathReplaceFrom, pathReplaceTo);
            if (hashMatch) { matchingTorrents = [hashMatch]; matchMethod = 'fast_hash'; }
          }
        }

        // Step -1: Hardlink (inode) match — only stat() calls, no file reads
        if (matchingTorrents.length === 0 && matchMode === 'hardlink' && inodeIndex && mf) {
          const arrFilePath = mf.path || (movie.path && mf.relativePath ? nodePath.join(movie.path, mf.relativePath) : null);
          if (arrFilePath) {
            const inoMatch = matchByInode(inodeIndex, arrFilePath, pathReplaceFrom, pathReplaceTo);
            if (inoMatch) { matchingTorrents = [inoMatch]; matchMethod = 'hardlink'; }
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

        const actualPath = matchingTorrents.length > 0 ? matchingTorrents[0].content_path : movie.path;
        const releaseName = mf ? (mf.sceneName || mf.relativePath || movie.title) : movie.title;

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
          matchMethod
        });
      }

    } else if (instance.type === 'sonarr') {
      const series = await getSonarrSeries(instance);

      for (let i = 0; i < series.length; i++) {
        const show = series[i];
        const itemProgress = Math.floor(((i + 1) / series.length) * 100);
        instanceSendEvent(`[${i + 1}/${series.length}] ${show.title}`, Math.min(99, itemProgress));
        await new Promise(resolve => setImmediate(resolve));

        if (!show.seasons) continue;

        let episodeFiles = [];
        try { episodeFiles = await getSonarrEpisodeFiles(instance, show.id); } catch {}

        // HYBRID / HARDLINK / FAST_HASH: get latest grabbed sourceTitle + torrentHash for the series
        let historySourceTitle = null;
        let historyTorrentHash = null;
        if (matchMode === 'hybrid' || matchMode === 'hardlink' || matchMode === 'fast_hash') {
          const hist = await getSonarrSeriesHistory(instance, show.id);
          historySourceTitle = hist.sourceTitle;
          historyTorrentHash = hist.torrentHash;
        }

        for (const season of show.seasons) {
          if (!season.statistics || season.statistics.episodeFileCount === 0) continue;
          const sNum = season.seasonNumber;
          const seasonFiles = episodeFiles.filter(f => f.seasonNumber === sNum);
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
              if (ef.path) {
                const hashMatch = matchByPartialHash(hashIndex, ef.path, pathReplaceFrom, pathReplaceTo);
                if (hashMatch) { matchingTorrents = [hashMatch]; matchMethod = 'fast_hash'; break; }
              }
            }
          }

          // Step -1: Hardlink (inode) match on episode files
          if (matchingTorrents.length === 0 && matchMode === 'hardlink' && inodeIndex && seasonFiles.length > 0) {
            for (const ef of seasonFiles) {
              if (ef.path) {
                const inoMatch = matchByInode(inodeIndex, ef.path, pathReplaceFrom, pathReplaceTo);
                if (inoMatch) { matchingTorrents = [inoMatch]; matchMethod = 'hardlink'; break; }
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

          const fallbackPath = `${show.path}/Season ${String(sNum).padStart(2, '0')}`;
          const actualPath = matchingTorrents.length > 0 ? matchingTorrents[0].content_path : fallbackPath;
          const seasonFileNames = seasonFiles.map(f => f.relativePath || f.sceneName || '').join(' | ');

          instanceResults.push({
            id: `sonarr-${instance.name}-${show.id}-s${sNum}`,
            title: `${show.title} - Season ${sNum}`,
            type: 'series',
            instanceName: instance.name,
            arrUrl: `${instance.url_external}/series/${show.titleSlug}`,
            path: actualPath,
            releaseName: `${show.path.split(/[/\\]/).pop()} S${String(sNum).padStart(2, '0')}`,
            fileName: seasonFileNames,
            qbitTags: Array.from(mediaTags),
            qbitTrackerHosts: Array.from(mediaTrackerHosts),
            inQbit: matchingTorrents.length > 0,
            matchMethod
          });
        }
      }
    }
    
    instanceSendEvent('Finished', 100);
    return instanceResults;
  });

  const allResultsNested = await Promise.all(instancePromises);
  const results = allResultsNested.flat();

  internalSendEvent('progress', { global: true, step: 'Finalizing...', progress: 100 });

  const historyMatches = results.filter(r => r.matchMethod === 'history').length;
  const nameMatches    = results.filter(r => r.matchMethod === 'name').length;
  const sizeMatches    = results.filter(r => r.matchMethod === 'size').length;
  const missing        = results.filter(r => r.matchMethod === 'none').length;

  console.log(`Scan done: ${results.length} items | history=${historyMatches}, name=${nameMatches}, size=${sizeMatches}, missing=${missing} | mode=${matchMode}`);

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
  getLastResults, 
  testQbit, 
  testArr, 
  fetchTrackerHosts,
  getScannerState,
  addScanListener,
  removeScanListener
};
