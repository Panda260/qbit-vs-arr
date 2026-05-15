const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { scanMedia, getLastResults, testQbit, testArr, fetchTrackerHosts } = require('../services/scanner');
const axios = require('axios');

// --- Test Connections ---
router.post('/test/qbit', async (req, res) => {
  const { url, username, password } = req.body;
  try { await testQbit(url, username, password); res.json({ success: true }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/test/arr', async (req, res) => {
  const { type, url, apiKey } = req.body;
  try { await testArr(type, url, apiKey); res.json({ success: true }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

// --- Auth Check ---
router.get('/auth-check', (req, res) => {
  res.json({ success: true, auth_enabled: req.authEnabled, authenticated: req.authenticated });
});

// --- Settings ---
router.get('/settings', (req, res) => {
  res.json({
    auth_enabled: db.getSetting('auth_enabled', false),
    admin_user: db.getSetting('admin_user', 'admin'),
    has_password: !!db.getSetting('admin_password', ''),
    qbit_url: db.getSetting('qbit_url', ''),
    qbit_user: db.getSetting('qbit_user', ''),
    has_qbit_pass: !!db.getSetting('qbit_password', ''),
    cross_seed_url: db.getSetting('cross_seed_url', ''),
    cross_seed_api_key: db.getSetting('cross_seed_api_key', ''),
    upload_command: db.getSetting('upload_command', 'docker exec -it upp upPollo upload --category cross-seed-link --tags manual "{path}"'),
    ignored_keywords: JSON.parse(db.getSetting('ignored_keywords', '[]')),
    match_mode: db.getSetting('match_mode', 'fast_hash'),
    selected_tracker_hosts: db.getSetting('selected_tracker_hosts', []),
    cross_seed_delay: parseFloat(db.getSetting('cross_seed_delay', '30')),
    scan_on_startup: db.getSetting('scan_on_startup', true),
    path_replace_from: db.getSetting('path_replace_from', ''),
    path_replace_to: db.getSetting('path_replace_to', '')
  });
});

router.post('/settings', (req, res) => {
  const {
    auth_enabled, admin_user, admin_password,
    qbit_url, qbit_user, qbit_password,
    cross_seed_url, cross_seed_api_key,
    ignored_keywords, upload_command, match_mode,
    selected_tracker_hosts, cross_seed_delay, scan_on_startup
  } = req.body;

  if (auth_enabled !== undefined)          db.setSetting('auth_enabled', auth_enabled);
  if (admin_user !== undefined)            db.setSetting('admin_user', admin_user);
  if (admin_password)                      db.setSetting('admin_password', admin_password);
  if (qbit_url !== undefined)              db.setSetting('qbit_url', qbit_url);
  if (qbit_user !== undefined)             db.setSetting('qbit_user', qbit_user);
  if (qbit_password)                       db.setSetting('qbit_password', qbit_password);
  if (cross_seed_url !== undefined)        db.setSetting('cross_seed_url', cross_seed_url);
  if (cross_seed_api_key !== undefined)    db.setSetting('cross_seed_api_key', cross_seed_api_key);
  if (upload_command !== undefined)        db.setSetting('upload_command', upload_command);
  if (cross_seed_delay !== undefined)      db.setSetting('cross_seed_delay', String(cross_seed_delay));
  if (scan_on_startup !== undefined)       db.setSetting('scan_on_startup', scan_on_startup);
  if (match_mode !== undefined)            db.setSetting('match_mode', match_mode);
  if (ignored_keywords !== undefined)      db.setSetting('ignored_keywords', JSON.stringify(ignored_keywords));
  if (selected_tracker_hosts !== undefined) db.setSetting('selected_tracker_hosts', selected_tracker_hosts);

  const { path_replace_from, path_replace_to } = req.body;
  if (path_replace_from !== undefined)     db.setSetting('path_replace_from', path_replace_from);
  if (path_replace_to !== undefined)       db.setSetting('path_replace_to', path_replace_to);

  res.json({ success: true });
});

// --- Tracker hosts (for dropdown) ---
router.get('/trackers', async (req, res) => {
  const url  = db.getSetting('qbit_url', '');
  const user = db.getSetting('qbit_user', '');
  const pass = db.getSetting('qbit_password', '');
  if (!url) return res.status(400).json({ error: 'qBittorrent not configured' });
  try {
    const hosts = await fetchTrackerHosts(url, user, pass);
    res.json(hosts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Instances ---
router.get('/instances', (req, res) => res.json(db.getInstances()));
router.post('/instances', (req, res) => { const id = db.addInstance(req.body); res.json({ id, success: true }); });
router.put('/instances/:id', (req, res) => { db.updateInstance(req.params.id, req.body); res.json({ success: true }); });
router.delete('/instances/:id', (req, res) => { db.deleteInstance(req.params.id); res.json({ success: true }); });

// --- Scanner (SSE) ---
router.get('/scan-status', (req, res) => {
  const { getScannerState } = require('../services/scanner');
  res.json(getScannerState());
});

router.get('/scan', async (req, res) => {
  const { scanMedia, getScannerState, addScanListener, removeScanListener } = require('../services/scanner');
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (type, data) => {
    if (!res.writableEnded) {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  const listener = (type, data) => {
    sendEvent(type, data);
    if (type === 'complete' || type === 'error') {
      res.end();
    }
  };

  const state = getScannerState();
  addScanListener(listener);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    }
  }, 15000); // 15s heartbeat

  req.on('close', () => {
    clearInterval(heartbeat);
    removeScanListener(listener);
  });

  if (state.isScanning) {
    // Send current status immediately so client knows where we are
    sendEvent('progress', { step: state.step, progress: state.progress });
  } else if (req.query.start === 'true') {
    // Start new scan (it will broadcast to our listener automatically)
    scanMedia().catch(error => {
      console.error('Scan error:', error);
      // scanMedia already broadcasts 'error' internally if we wrapped it
    });
  } else {
    // Not scanning and not asked to start -> close immediately
    sendEvent('complete', getLastResults());
  }
});

router.post('/scan/cancel', (req, res) => {
  const { cancelScan } = require('../services/scanner');
  cancelScan();
  res.json({ success: true });
});

// --- cross-seed ---
const { startSearchAll, cancelSearchAll, getSearchAllStatus } = require('../services/crossSeedSearch');

router.post('/cross-seed', async (req, res) => {
  try {
    const { path: mediaPath } = req.body;
    let url = db.getSetting('cross_seed_url', '');
    const apiKey = db.getSetting('cross_seed_api_key', '');
    if (!url || !apiKey) return res.status(400).json({ message: 'cross-seed is not configured in settings.' });
    url = url.replace(/\/$/, '');
    const response = await axios.post(`${url}/api/webhook?apikey=${apiKey}`,
      new URLSearchParams({ path: mediaPath, ignoreExcludeOlder: 'true', ignoreExcludeRecentSearch: 'true' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json({ message: 'Search request sent successfully', status: response.status });
  } catch (error) {
    res.status(500).json({ message: 'Search failed: ' + (error.response?.data || error.message) });
  }
});

router.post('/test/cross-seed', async (req, res) => {
  try {
    let { url, apiKey } = req.body;
    if (!url || !apiKey) return res.status(400).json({ message: 'Missing credentials' });
    url = url.replace(/\/$/, '');
    await axios.get(`${url}/api/ping?apikey=${apiKey}`);
    res.json({ message: 'cross-seed connection successful' });
  } catch (error) {
    res.status(500).json({ message: 'Connection failed: ' + (error.response?.data || error.message) });
  }
});

router.get('/cross-seed/search-all/status', (req, res) => {
  res.json(getSearchAllStatus());
});

router.post('/cross-seed/search-all', async (req, res) => {
  try {
    const { paths } = req.body;
    if (!paths || !Array.isArray(paths)) return res.status(400).json({ message: 'paths array is required' });
    
    let url = db.getSetting('cross_seed_url', '');
    const apiKey = db.getSetting('cross_seed_api_key', '');
    const delay = parseFloat(db.getSetting('cross_seed_delay', '30')) * 1000;
    
    const status = await startSearchAll(paths, delay, url, apiKey);
    res.json(status);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/cross-seed/search-all/cancel', (req, res) => {
  res.json(cancelSearchAll());
});

// --- Last Results ---
router.get('/last-results', (req, res) => res.json(getLastResults()));

module.exports = router;
