const axios = require('axios');

let searchAllState = {
  isRunning: false,
  current: 0,
  total: 0,
  currentItem: '',
  cancelRequested: false,
  startTime: null,
  eta: null
};

function getSearchAllStatus() {
  if (searchAllState.isRunning && searchAllState.startTime) {
    const elapsedMs = Date.now() - searchAllState.startTime;
    if (searchAllState.current > 0) {
      const msPerItem = elapsedMs / searchAllState.current;
      const remainingItems = searchAllState.total - searchAllState.current;
      searchAllState.eta = Math.round((msPerItem * remainingItems) / 1000); // ETA in seconds
    }
  }
  return searchAllState;
}

function cancelSearchAll() {
  if (searchAllState.isRunning) {
    searchAllState.cancelRequested = true;
  }
  return getSearchAllStatus();
}

async function startSearchAll(paths, delayMs, url, apiKey) {
  if (searchAllState.isRunning) {
    throw new Error('Search all is already running');
  }
  
  if (!url || !apiKey) {
    throw new Error('cross-seed is not configured in settings.');
  }
  
  const cleanUrl = url.replace(/\/$/, '');

  searchAllState = {
    isRunning: true,
    current: 0,
    total: paths.length,
    currentItem: '',
    cancelRequested: false,
    startTime: Date.now(),
    eta: null
  };

  // Run in background without awaiting in the router
  (async () => {
    try {
      for (let i = 0; i < paths.length; i++) {
        if (searchAllState.cancelRequested) {
          console.log('Cross-Seed Search All cancelled by user.');
          break;
        }

        const path = paths[i];
        searchAllState.current = i + 1;
        searchAllState.currentItem = path;

        try {
          await axios.post(`${cleanUrl}/api/webhook?apikey=${apiKey}`,
            new URLSearchParams({ path: path, ignoreExcludeOlder: 'true', ignoreExcludeRecentSearch: 'true' }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
          );
        } catch (err) {
          console.error(`Failed to search ${path}:`, err.message);
        }

        if (searchAllState.cancelRequested) break;

        if (delayMs > 0 && i < paths.length - 1) {
          // Await the delay but check for cancellation periodically or just wait
          // Waiting with a simple timeout is fine since users can wait up to delayMs to see it cancel,
          // but better to have an interruptible sleep.
          await new Promise(resolve => {
            const timeoutId = setTimeout(resolve, delayMs);
            const checkCancel = setInterval(() => {
              if (searchAllState.cancelRequested) {
                clearTimeout(timeoutId);
                clearInterval(checkCancel);
                resolve();
              }
            }, 100);
            
            // Clean up interval when timeout finishes naturally
            setTimeout(() => clearInterval(checkCancel), delayMs);
          });
        }
      }
    } catch (e) {
      console.error('Search All loop error:', e);
    } finally {
      searchAllState.isRunning = false;
      searchAllState.cancelRequested = false;
    }
  })();

  return getSearchAllStatus();
}

module.exports = {
  startSearchAll,
  cancelSearchAll,
  getSearchAllStatus
};
