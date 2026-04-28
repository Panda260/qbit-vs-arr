const axios = require('axios');
const db = require('./db');

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
    if (sTorrentName.includes(sAlias) || sAlias.includes(sTorrentName)) return true;
  }
  return false;
}

function isSeasonMatch(torrentName, seasonNumber) {
  if (!torrentName) return false;
  // Match S1, S01, Season 1, Season 01, Staffel 1, Staffel 01
  // (?!\\d) ensures we don't match S11 when looking for S1
  const regex = new RegExp(`(?:S|Season\\s*|Staffel\\s*)0?${seasonNumber}(?!\\d)`, 'i');
  return regex.test(torrentName);
}

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

  const instances = db.getInstances();
  const results = [];

  let currentInstanceIdx = 0;
  for (const instance of instances) {
    const progress = 30 + Math.floor((currentInstanceIdx / instances.length) * 60);
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

        const aliases = [
          movie.title,
          movie.originalTitle,
          movie.folderName,
          movie.movieFile ? movie.movieFile.sceneName : null,
          movie.movieFile ? movie.movieFile.relativePath : null
        ];

        const sanitizedAliases = getSanitizedVariations(aliases);

        // Find matching torrents in qbit using pre-calculated strings
        const matchingTorrents = torrents.filter(t => matchSanitized(sanitizedAliases, t.sName));
        
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
          inQbit: matchingTorrents.length > 0
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
          
          const aliases = [
            show.title,
            show.originalTitle,
            show.path.split(/[\\/]/).pop()
          ];

          const sanitizedAliases = getSanitizedVariations(aliases);

          // Find matching torrents: must match series name AND season number
          const matchingTorrents = torrents.filter(t => 
            matchSanitized(sanitizedAliases, t.sName) &&
            isSeasonMatch(t.name, sNum)
          );
          
          const mediaTags = new Set();
          matchingTorrents.forEach(t => {
            if (t.tags) t.tags.split(',').forEach(tag => mediaTags.add(tag.trim()));
          });

          // Fallback path: /series/path/Season 01
          const fallbackPath = `${show.path}/Season ${String(sNum).padStart(2, '0')}`;
          const actualPath = matchingTorrents.length > 0 ? matchingTorrents[0].content_path : fallbackPath;

          // Extract all filenames for this specific season to allow the blacklist to check every single file
          const seasonFiles = episodeFiles.filter(f => f.seasonNumber === sNum);
          const seasonFileNames = seasonFiles.map(f => f.relativePath || f.sceneName || '').join(' | ');

          results.push({
            id: `sonarr-${instance.name}-${show.id}-s${sNum}`,
            title: `${show.title} - Season ${sNum}`,
            type: 'series',
            instanceName: instance.name,
            arrUrl: `${instance.url_external}/series/${show.titleSlug}`,
            path: actualPath,
            releaseName: `${show.path.split(/[\\/]/).pop()} S${String(sNum).padStart(2, '0')}`,
            fileName: seasonFileNames,
            qbitTags: Array.from(mediaTags),
            inQbit: matchingTorrents.length > 0
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
    timestamp: new Date()
  };

  lastScanResults = finalResults;
  console.log(`Saved scan results to memory: ${results.length} items, ${allTags.size} tags.`);
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
