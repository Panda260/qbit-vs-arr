const axios = require('axios');
const db = require('./db');

// ---------------------------------------------------------------------------
// qBittorrent helpers
// ---------------------------------------------------------------------------

async function getQbitAuthCookie(url, username, password) {
  try {
    const cleanUrl = url.replace(/\/$/, '');
    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password', password);
    
    const response = await axios.post(`${cleanUrl}/api/v2/auth/login`, params.toString(), 
      {
        headers: { 
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': cleanUrl
        }
      }
    );
    
    if (response.data === 'Fails.') {
      throw new Error('Invalid username or password (qBittorrent returned Fails)');
    }
    
    const cookie = response.headers['set-cookie'];
    if (cookie) return cookie[0].split(';')[0];
    throw new Error('No cookie returned from qBittorrent');
  } catch (error) {
    throw new Error('Failed to authenticate with qBittorrent: ' + (error.response?.data || error.message));
  }
}

async function getQbitTorrents(url, cookie) {
  try {
    const cleanUrl = url.replace(/\/$/, '');
    const response = await axios.get(`${cleanUrl}/api/v2/torrents/info`, {
      headers: { Cookie: cookie }
    });
    return response.data;
  } catch (error) {
    throw new Error('Failed to fetch torrents from qBittorrent: ' + error.message);
  }
}

/**
 * Fetch the file list for a single torrent.
 * Returns array of { name, size } objects.
 */
async function getQbitTorrentFiles(url, cookie, hash) {
  try {
    const cleanUrl = url.replace(/\/$/, '');
    const response = await axios.get(`${cleanUrl}/api/v2/torrents/files`, {
      headers: { Cookie: cookie },
      params: { hash }
    });
    return response.data || [];
  } catch (error) {
    // Non-fatal: if we can't get files for a torrent, we just skip it
    return [];
  }
}

// ---------------------------------------------------------------------------
// Size index builder
// ---------------------------------------------------------------------------

const MKV_MIN_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB – ignore NFOs, samples, subs
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|ts|m2ts|mov|wmv|flv|webm|iso)$/i;

/**
 * Build a Map<fileSizeBytes, torrent[]> from all .mkv / video files across
 * all qBit torrents.  Torrents whose file list cannot be fetched are skipped.
 *
 * We fetch file lists in parallel batches to keep it fast.
 *
 * The map value is an array because two different torrents could share the
 * exact same file size.  We use that to detect ambiguity and refuse a match.
 */
async function buildSizeIndex(torrents, url, cookie, sendEvent) {
  const BATCH_SIZE = 20; // concurrent requests to qBit
  const sizeIndex = new Map(); // size_bytes => [{ torrent, fileName }]

  sendEvent('progress', { step: `Building size index for ${torrents.length} torrents...`, progress: 22 });

  for (let i = 0; i < torrents.length; i += BATCH_SIZE) {
    const batch = torrents.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (torrent) => {
      const files = await getQbitTorrentFiles(url, cookie, torrent.hash);
      torrent._files = files; // cache on torrent object for later use

      for (const file of files) {
        if (!VIDEO_EXTENSIONS.test(file.name)) continue;
        if (file.size < MKV_MIN_SIZE_BYTES) continue;

        const existing = sizeIndex.get(file.size) || [];
        existing.push({ torrent, fileName: file.name });
        sizeIndex.set(file.size, existing);
      }
    }));

    const pct = 22 + Math.floor(((i + BATCH_SIZE) / torrents.length) * 8);
    sendEvent('progress', { step: `Building size index... (${Math.min(i + BATCH_SIZE, torrents.length)}/${torrents.length})`, progress: Math.min(30, pct) });
  }

  return sizeIndex;
}

/**
 * Look up a file size in the index.
 * Returns the matching torrent ONLY if exactly one torrent has this size
 * (ambiguous = no match, to avoid false positives).
 */
function matchBySize(sizeIndex, fileSizeBytes) {
  if (!fileSizeBytes || fileSizeBytes < MKV_MIN_SIZE_BYTES) return null;

  const matches = sizeIndex.get(fileSizeBytes);
  if (!matches || matches.length === 0) return null;

  // Deduplicate by torrent hash (same torrent may have multiple matching files)
  const uniqueTorrents = [...new Map(matches.map(m => [m.torrent.hash, m.torrent])).values()];

  if (uniqueTorrents.length === 1) {
    return uniqueTorrents[0]; // Unambiguous match
  }

  // Multiple different torrents share the same file size → too risky, skip
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
    console.error(`Failed to fetch Radarr movies (${instance.name}): `, error.message);
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
    console.error(`Failed to fetch Sonarr series (${instance.name}): `, error.message);
    return [];
  }
}

async function getSonarrEpisodeFiles(instance, seriesId) {
  try {
    const response = await axios.get(`${instance.url_internal}/api/v3/episodefile?seriesId=${seriesId}`, {
      headers: { 'X-Api-Key': instance.api_key }
    });
    return response.data || [];
  } catch (error) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Name-matching helpers (unchanged logic, kept for hybrid approach)
// ---------------------------------------------------------------------------

function sanitizeString(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getSanitizedVariations(aliases) {
  const result = new Set();
  
  for (let alias of aliases) {
    if (!alias) continue;
    
    // Remove common extensions and metadata tags like [tmdbid-123]
    let baseAlias = alias
      .replace(/\.(mkv|mp4|avi|ts|iso|srt|sub)$/i, '')
      .replace(/(\[|\{)[a-z]+-?[a-z0-9]+(\]|\})/gi, '');
      
    // Create variations to handle German/English naming differences and umlauts
    const variations = [
      baseAlias,
      baseAlias.replace(/(teil|part|vol|volume)[\s-]*(\d+)/ig, '$2'),
      baseAlias.replace(/&/g, 'und'),
      baseAlias.replace(/&/g, 'and'),
      baseAlias.replace(/(teil|part|vol|volume)[\s-]*(\d+)/ig, '$2').replace(/&/g, 'und'),
      baseAlias.replace(/ä/ig, 'ae').replace(/ö/ig, 'oe').replace(/ü/ig, 'ue').replace(/ß/ig, 'ss'),
      baseAlias.replace(/ä/ig, 'a').replace(/ö/ig, 'o').replace(/ü/ig, 'u').replace(/ß/ig, 's')
    ];
    
    for (const variation of variations) {
      const sAlias = sanitizeString(variation);
      if (sAlias && sAlias.length > 3) {
        result.add(sAlias);
      }
    }
  }
  return Array.from(result);
}

function matchSanitized(sanitizedAliases, sTorrentName) {
  if (!sTorrentName) return false;
  for (const sAlias of sanitizedAliases) {
    if (sAlias === sTorrentName) return true; // Exact match is always valid
    
    if (sTorrentName.includes(sAlias) || sAlias.includes(sTorrentName)) {
      // Prevent generic file/folder names from matching specific release names.
      // If the length difference is too large (e.g. 'enolaholmes2' vs 'enolaholmes21080ph265hdr...'), it's a false positive.
      const diff = Math.abs(sAlias.length - sTorrentName.length);
      if (diff <= 25) {
        return true;
      }
    }
  }
  return false;
}

function isSeasonMatch(torrentName, seasonNumber) {
  if (!torrentName) return false;
  // Match S1, S01, Season 1, Season 01, Staffel 1, Staffel 01
  // (?!\d) ensures we don't match S11 when looking for S1
  const regex = new RegExp(`(?:S|Season\\s*|Staffel\\s*)0?${seasonNumber}(?!\\d)`, 'i');
  return regex.test(torrentName);
}

// ---------------------------------------------------------------------------
// Scan orchestration
// ---------------------------------------------------------------------------

let lastScanResults = {
  media: [],
  tags: [],
  timestamp: null
};

async function scanMedia(sendEvent) {
  sendEvent('progress', { step: 'Initializing', progress: 0 });

  const qbitUrl = db.getSetting('qbit_url', '');
  const qbitUser = db.getSetting('qbit_user', '');
  const qbitPass = db.getSetting('qbit_password', '');
  const matchMode = db.getSetting('match_mode', 'name_then_size'); // 'name_then_size' | 'name_only' | 'size_only'
  
  if (!qbitUrl) {
    throw new Error('qBittorrent is not configured.');
  }

  sendEvent('progress', { step: 'Logging into qBittorrent...', progress: 10 });
  const cookie = await getQbitAuthCookie(qbitUrl, qbitUser, qbitPass);

  sendEvent('progress', { step: 'Fetching qBittorrent Torrents...', progress: 20 });
  const torrents = await getQbitTorrents(qbitUrl, cookie);
  
  const allTags = new Set();
  torrents.forEach(t => {
    t.sName = sanitizeString(t.name); // Pre-calculate sanitized name for O(1) matching
    if (t.tags) {
      t.tags.split(',').forEach(tag => allTags.add(tag.trim()));
    }
  });

  // Build the size index upfront (only when we need it)
  let sizeIndex = null;
  if (matchMode === 'name_then_size' || matchMode === 'size_only') {
    sizeIndex = await buildSizeIndex(torrents, qbitUrl, cookie, sendEvent);
    console.log(`Size index built: ${sizeIndex.size} unique file sizes indexed.`);
  }

  const instances = db.getInstances();
  const results = [];

  let currentInstanceIdx = 0;
  for (const instance of instances) {
    const progress = 32 + Math.floor((currentInstanceIdx / instances.length) * 60);
    sendEvent('progress', { step: `Scanning ${instance.name}...`, progress });

    if (instance.type === 'radarr') {
      const movies = await getRadarrMovies(instance);
      for (let i = 0; i < movies.length; i++) {
        const movie = movies[i];
        
        const itemProgress = progress + Math.floor(((i + 1) / movies.length) * (60 / instances.length));
        sendEvent('progress', { 
          step: `[${i + 1}/${movies.length}] ${instance.name} - ${movie.title}`, 
          progress: Math.min(99, itemProgress)
        });

        // Yield to event loop every 10 items so SSE messages flush to frontend
        if (i % 10 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }

        const fileAliases = [
          movie.movieFile ? movie.movieFile.sceneName : null,
          movie.movieFile ? movie.movieFile.relativePath : null
        ].filter(Boolean);

        const aliases = fileAliases.length > 0 
          ? fileAliases 
          : [movie.title, movie.originalTitle, movie.folderName];

        const sanitizedAliases = getSanitizedVariations(aliases);

        // --- Step 1: Name matching ---
        let matchingTorrents = [];
        let matchMethod = 'none';

        if (matchMode === 'name_only' || matchMode === 'name_then_size') {
          matchingTorrents = torrents.filter(t => matchSanitized(sanitizedAliases, t.sName));
          if (matchingTorrents.length > 0) {
            matchMethod = 'name';
          }
        }

        // --- Step 2: Size fallback (if no name match and size index available) ---
        if (matchingTorrents.length === 0 && sizeIndex && movie.movieFile) {
          const arrFileSize = movie.movieFile.size; // size in bytes from Radarr
          const sizeTorrent = matchBySize(sizeIndex, arrFileSize);
          if (sizeTorrent) {
            matchingTorrents = [sizeTorrent];
            matchMethod = 'size';
          }
        }

        // Extract tags from matching torrents
        const mediaTags = new Set();
        matchingTorrents.forEach(t => {
          if (t.tags) t.tags.split(',').forEach(tag => mediaTags.add(tag.trim()));
        });

        // Use qBit path if available, else fallback to Arr path
        const actualPath = matchingTorrents.length > 0 ? matchingTorrents[0].content_path : movie.path;

        // Get release name from movieFile if available
        const releaseName = movie.movieFile ? (movie.movieFile.sceneName || movie.movieFile.relativePath || movie.title) : movie.title;

        results.push({
          id: `radarr-${instance.name}-${movie.id}`,
          title: movie.title,
          type: 'movie',
          instanceName: instance.name,
          arrUrl: `${instance.url_external}/movie/${movie.titleSlug}`,
          path: actualPath,
          releaseName: releaseName,
          fileName: movie.movieFile ? movie.movieFile.relativePath : '',
          qbitTags: Array.from(mediaTags),
          inQbit: matchingTorrents.length > 0,
          matchMethod // 'name' | 'size' | 'none'
        });
      }
    } else if (instance.type === 'sonarr') {
      const series = await getSonarrSeries(instance);
      for (let i = 0; i < series.length; i++) {
        const show = series[i];
        
        const itemProgress = progress + Math.floor(((i + 1) / series.length) * (60 / instances.length));
        sendEvent('progress', { 
          step: `[${i + 1}/${series.length}] ${instance.name} - ${show.title}`, 
          progress: Math.min(99, itemProgress)
        });

        // Yield to event loop every 5 items (series are heavier) so SSE messages flush to frontend
        if (i % 5 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }

        if (!show.seasons) continue;
        
        let episodeFiles = [];
        try {
          episodeFiles = await getSonarrEpisodeFiles(instance, show.id);
        } catch (e) { }
        
        for (const season of show.seasons) {
          // Only process seasons that have downloaded files
          if (!season.statistics || season.statistics.episodeFileCount === 0) continue;
          
          const sNum = season.seasonNumber;
          
          const seasonFiles = episodeFiles.filter(f => f.seasonNumber === sNum);
          const seasonSceneNames = Array.from(new Set(seasonFiles.map(f => f.sceneName).filter(Boolean)));
          const seasonPaths = Array.from(new Set(seasonFiles.map(f => f.relativePath).filter(Boolean)));

          const aliases = (seasonSceneNames.length > 0 || seasonPaths.length > 0)
            ? [...seasonSceneNames, ...seasonPaths]
            : [show.title, show.originalTitle, show.path.split(/[/\\]/).pop()];

          const sanitizedAliases = getSanitizedVariations(aliases);

          // --- Step 1: Name matching ---
          let matchingTorrents = [];
          let matchMethod = 'none';

          if (matchMode === 'name_only' || matchMode === 'name_then_size') {
            matchingTorrents = torrents.filter(t => 
              matchSanitized(sanitizedAliases, t.sName) &&
              isSeasonMatch(t.name, sNum)
            );
            if (matchingTorrents.length > 0) {
              matchMethod = 'name';
            }
          }

          // --- Step 2: Size fallback for Sonarr ---
          // Strategy: if at least ONE episode file from Arr matches a qBit torrent
          // by size → the season is considered "in qBit".
          // This is conservative (less false negatives), which is the priority.
          if (matchingTorrents.length === 0 && sizeIndex && seasonFiles.length > 0) {
            for (const episodeFile of seasonFiles) {
              const arrFileSize = episodeFile.size;
              const sizeTorrent = matchBySize(sizeIndex, arrFileSize);
              if (sizeTorrent) {
                matchingTorrents = [sizeTorrent];
                matchMethod = 'size';
                break; // One match is enough
              }
            }
          }
          
          const mediaTags = new Set();
          matchingTorrents.forEach(t => {
            if (t.tags) t.tags.split(',').forEach(tag => mediaTags.add(tag.trim()));
          });

          // Fallback path: /series/path/Season 01
          const fallbackPath = `${show.path}/Season ${String(sNum).padStart(2, '0')}`;
          const actualPath = matchingTorrents.length > 0 ? matchingTorrents[0].content_path : fallbackPath;

          // Extract all filenames for this specific season to allow the blacklist to check every single file
          const seasonFileNames = seasonFiles.map(f => f.relativePath || f.sceneName || '').join(' | ');

          results.push({
            id: `sonarr-${instance.name}-${show.id}-s${sNum}`,
            title: `${show.title} - Season ${sNum}`,
            type: 'series',
            instanceName: instance.name,
            arrUrl: `${instance.url_external}/series/${show.titleSlug}`,
            path: actualPath,
            releaseName: `${show.path.split(/[/\\]/).pop()} S${String(sNum).padStart(2, '0')}`,
            fileName: seasonFileNames,
            qbitTags: Array.from(mediaTags),
            inQbit: matchingTorrents.length > 0,
            matchMethod // 'name' | 'size' | 'none'
          });
        }
      }
    }
    currentInstanceIdx++;
  }

  sendEvent('progress', { step: 'Finalizing...', progress: 100 });

  const finalResults = {
    media: results,
    tags: Array.from(allTags).filter(t => t),
    timestamp: new Date(),
    matchMode
  };

  lastScanResults = finalResults;
  
  const nameMatches = results.filter(r => r.matchMethod === 'name').length;
  const sizeMatches = results.filter(r => r.matchMethod === 'size').length;
  const missing = results.filter(r => r.matchMethod === 'none').length;
  console.log(`Scan complete: ${results.length} items | name=${nameMatches}, size=${sizeMatches}, missing=${missing} | mode=${matchMode}`);
  
  return finalResults;
}

function getLastResults() {
  console.log(`Retrieving last scan results from memory: ${lastScanResults.media.length} items.`);
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
    params: { limit: 1 } // Fetch only 1 to minimize traffic
  });
  return true;
}

module.exports = {
  scanMedia,
  getLastResults,
  testQbit,
  testArr
};
