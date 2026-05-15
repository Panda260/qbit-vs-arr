import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Copy, ExternalLink, Check, Search, Activity, RefreshCw, XCircle, CheckCircle, Plus, X, Filter, Radio, AlertCircle } from 'lucide-react';
import axios from 'axios';

export default function Dashboard() {
  const [scanState, setScanState]     = useState({ isScanning: false, globalStep: 'Ready to scan', globalProgress: 0, instances: {} });
  const [lastScanDate, setLastScanDate] = useState(null);
  const [mediaItems, setMediaItems]   = useState([]);
  const [availableTags, setAvailableTags] = useState([]);

  // Tracker hosts available in qBit
  const [trackerHosts, setTrackerHosts] = useState([]);
  const [loadingTrackers, setLoadingTrackers] = useState(false);

  // Selected tracker hosts persisted to localStorage AND saved to backend
  const [selectedTrackers, setSelectedTrackers] = useState(() => {
    try { return JSON.parse(localStorage.getItem('selectedTrackers') || '[]'); } catch { return []; }
  });

  const [displayMode, setDisplayMode]     = useState('missing');
  const [showAllTags, setShowAllTags]     = useState(true);
  const [copiedId, setCopiedId]           = useState(null);
  const [settings, setSettings]           = useState({ ignored_keywords: [] });
  const [instances, setInstances]         = useState([]);
  const [filterInstance, setFilterInstance] = useState('all');
  const [newIgnoreKeyword, setNewIgnoreKeyword] = useState('');

  // Ref that always holds the current delay value so searchAllCrossSeed
  // picks up changes immediately — even while a loop is running.
  const crossSeedDelayRef = useRef(30);
  useEffect(() => {
    crossSeedDelayRef.current = settings.cross_seed_delay ?? 30;
  }, [settings.cross_seed_delay]);

  // Persist tracker selection to localStorage
  useEffect(() => {
    localStorage.setItem('selectedTrackers', JSON.stringify(selectedTrackers));
  }, [selectedTrackers]);

  useEffect(() => {
    fetchSettings();
    fetchLastResults();
    checkScanStatus();

    // Poll backend search all status
    const interval = setInterval(async () => {
      try {
        const res = await axios.get('/cross-seed/search-all/status');
        if (res.data.isRunning) {
          setSearchAllStatus(res.data);
        } else {
          setSearchAllStatus(null);
        }
      } catch (err) { }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const fetchSettings = async () => {
    try {
      const [settingsRes, instancesRes] = await Promise.all([
        axios.get('/settings'),
        axios.get('/instances')
      ]);
      setSettings(settingsRes.data);
      setInstances(instancesRes.data);
      // Sync selected trackers from server
      if (settingsRes.data.selected_tracker_hosts?.length > 0) {
        setSelectedTrackers(settingsRes.data.selected_tracker_hosts);
      }
    } catch (err) { console.error('Failed to fetch settings', err); }
  };

  const fetchLastResults = async () => {
    try {
      const res = await axios.get('/last-results');
      if (res.data?.media?.length > 0) {
        setMediaItems(res.data.media);
        setAvailableTags(res.data.tags || []);
        if (res.data.trackerHosts?.length > 0) setTrackerHosts(res.data.trackerHosts);
        setLastScanDate(new Date(res.data.timestamp).toLocaleString());
      }
    } catch (err) { console.error('Failed to fetch last results', err); }
  };

  const loadTrackerHosts = async () => {
    setLoadingTrackers(true);
    try {
      const res = await axios.get('/trackers');
      setTrackerHosts(res.data || []);
    } catch (err) { console.error('Failed to load trackers', err); }
    setLoadingTrackers(false);
  };

  const saveTrackerSelection = useCallback(async (hosts) => {
    try { await axios.post('/settings', { selected_tracker_hosts: hosts }); }
    catch (err) { console.error('Failed to save tracker selection', err); }
  }, []);

  const toggleTracker = (host) => {
    const next = selectedTrackers.includes(host)
      ? selectedTrackers.filter(h => h !== host)
      : [...selectedTrackers, host];
    setSelectedTrackers(next);
    saveTrackerSelection(next);
  };

  const clearTrackers = () => {
    setSelectedTrackers([]);
    saveTrackerSelection([]);
  };

  const handleScan = (startNew = false) => {
    if (startNew) {
      setScanState({ isScanning: true, globalStep: 'Starting scan...', globalProgress: 0, instances: {} });
      setMediaItems([]);
      setAvailableTags([]);
    }

    const eventSource = new EventSource(startNew ? '/api/scan?start=true' : '/api/scan');

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      setScanState(data);
    });

    eventSource.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      if (data && data.media) {
        setMediaItems(data.media);
        setAvailableTags(data.tags || []);
        if (data.trackerHosts?.length > 0) setTrackerHosts(data.trackerHosts);
      }
      setScanState({ isScanning: false, globalStep: 'Scan complete', globalProgress: 100, instances: {} });
      setLastScanDate(new Date().toLocaleString());
      eventSource.close();
    });

    eventSource.addEventListener('error', (e) => {
      try { 
        const data = JSON.parse(e.data); 
        setScanState(prev => ({ ...prev, isScanning: false, globalStep: `Error: ${data.message}` }));
      }
      catch { 
        setScanState(prev => ({ ...prev, isScanning: false, globalStep: 'Scan failed.' }));
      }
      eventSource.close();
    });
  };

  const checkScanStatus = async () => {
    try {
      const res = await axios.get('/scan-status');
      if (res.data.isScanning) {
        setScanState(res.data);
        handleScan(false); // Join the existing SSE stream
      }
    } catch (err) { console.error('Failed to check scan status', err); }
  };

  const copyCommand = (item) => {
    const cmd = (settings.upload_command || 'docker exec -it upp upPollo upload --category cross-seed-link --tags manual "{path}"')
      .replace(/{path}/g, item.path || '')
      .replace(/{title}/g, item.title || '')
      .replace(/{type}/g, item.type || '')
      .replace(/{instance}/g, item.instanceName || '')
      .replace(/{releaseName}/g, item.releaseName || '')
      .replace(/{fileName}/g, item.fileName || '');
    navigator.clipboard.writeText(cmd);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleAddIgnoreKeyword = async (e) => {
    e.preventDefault();
    if (!newIgnoreKeyword.trim()) return;
    const updated = [...(settings.ignored_keywords || []), newIgnoreKeyword.trim()];
    setSettings(prev => ({ ...prev, ignored_keywords: updated }));
    setNewIgnoreKeyword('');
    try { await axios.post('/settings', { ignored_keywords: updated }); }
    catch (err) { console.error('Failed to save ignored keywords', err); }
  };

  const handleRemoveIgnoreKeyword = async (keyword) => {
    const updated = (settings.ignored_keywords || []).filter(k => k !== keyword);
    setSettings(prev => ({ ...prev, ignored_keywords: updated }));
    try { await axios.post('/settings', { ignored_keywords: updated }); }
    catch (err) { console.error('Failed to save ignored keywords', err); }
  };

  const filteredMedia = React.useMemo(() => {
    return mediaItems.filter(item => {
      // Ignore list
      if (settings.ignored_keywords?.length > 0) {
        const searchStr = [item.path, item.releaseName, item.title, item.fileName].join(' ').toLowerCase();
        if (settings.ignored_keywords.some(kw => searchStr.includes(kw.toLowerCase()))) return false;
      }
      // Tracker filter logic:
      // An item is "effectively in qBit" (seeding) on the selected trackers IF:
      // it is inQbit AND (no trackers selected OR it has a matching tracker).
      const effectivelyInQbit = item.inQbit && (
        selectedTrackers.length === 0 || 
        selectedTrackers.some(h => (item.qbitTrackerHosts || []).includes(h))
      );

      // Instance filter
      if (filterInstance !== 'all') {
        if (filterInstance.startsWith('type_')) {
          const type = filterInstance.replace('type_', '');
          if (type === 'radarr' && item.type !== 'movie') return false;
          if (type === 'sonarr' && item.type !== 'series') return false;
        } else if (filterInstance.startsWith('name_')) {
          if (item.instanceName !== filterInstance.replace('name_', '')) return false;
        }
      }
      // Display mode
      return displayMode === 'missing' ? !effectivelyInQbit : effectivelyInQbit;
    });
  }, [mediaItems, displayMode, filterInstance, settings.ignored_keywords, selectedTrackers]);

  const [searchLoading, setSearchLoading] = useState({});

  const searchCrossSeed = async (item) => {
    setSearchLoading(prev => ({ ...prev, [item.id]: true }));
    try {
      await axios.post('/cross-seed', { path: item.path });
      setSearchLoading(prev => ({ ...prev, [item.id]: 'success' }));
    } catch {
      setSearchLoading(prev => ({ ...prev, [item.id]: 'error' }));
    }
    setTimeout(() => setSearchLoading(prev => { const n = { ...prev }; delete n[item.id]; return n; }), 3000);
  };

  const [searchAllStatus, setSearchAllStatus] = useState(null);

  const searchAllCrossSeed = async () => {
    if (!filteredMedia?.length) return;
    try {
      const paths = filteredMedia.map(item => item.path);
      const res = await axios.post('/cross-seed/search-all', { paths });
      setSearchAllStatus(res.data);
    } catch (err) {
      console.error('Failed to start search all:', err);
    }
  };

  const cancelSearchAll = async () => {
    try {
      const res = await axios.post('/cross-seed/search-all/cancel');
      setSearchAllStatus(res.data);
    } catch (err) {
      console.error('Failed to cancel search all:', err);
    }
  };

  // Match method label
  const matchBadge = (method) => {
    if (!method || method === 'none') return null;
    const styles = {
      fast_hash: { bg: 'rgba(234,179,8,0.15)',  color: '#fde047', border: '1px solid rgba(234,179,8,0.3)',  label: '⚡ HASH'    },
      hardlink: { bg: 'rgba(6,182,212,0.15)',   color: '#67e8f9', border: '1px solid rgba(6,182,212,0.4)',   label: '🔗 HARDLINK'  },
      hash:    { bg: 'rgba(6,182,212,0.1)',    color: '#22d3ee', border: '1px solid rgba(6,182,212,0.3)',   label: '🔑 HASH'    },
      history: { bg: 'rgba(168,85,247,0.15)', color: '#c084fc', border: '1px solid rgba(168,85,247,0.3)', label: '🕒 HISTORY' },
      name:    { bg: 'rgba(34,197,94,0.15)',  color: '#86efac', border: '1px solid rgba(34,197,94,0.3)',  label: '🏷️ NAME'    },
      size:    { bg: 'rgba(234,179,8,0.15)',  color: '#fde047', border: '1px solid rgba(234,179,8,0.3)',  label: '📏 SIZE'    },
    };
    const s = styles[method];
    if (!s) return null;
    return (
      <span style={{ fontSize: '0.6rem', padding: '2px 7px', borderRadius: '12px', fontWeight: 700, letterSpacing: '0.05em', background: s.bg, color: s.color, border: s.border }}>
        {s.label}
      </span>
    );
  };

  return (
    <div>
      {/* Header */}
      <div className="glass-panel mb-4 flex justify-between items-center">
        <div>
          <h2>Media Sync Dashboard</h2>
          <p>Find downloaded media that is not seeded in qBittorrent.</p>
          {!scanState.isScanning && lastScanDate && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Last scanned: {lastScanDate}
            </p>
          )}
        </div>
        <button onClick={() => handleScan(true)} disabled={scanState.isScanning} className="btn btn-primary">
          {scanState.isScanning ? <Search size={18} className="animate-spin" /> : <Play size={18} />}
          {scanState.isScanning ? 'Scanning...' : 'Start Scan'}
        </button>
      </div>

      {/* Progress */}
      {scanState.isScanning && (
        <div className="glass-panel mb-4 animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          
          {/* Global Progress (always show if scanning) */}
          {Object.keys(scanState.instances || {}).length === 0 && (
            <div>
              <div className="flex justify-between items-center mb-2">
                <span style={{ fontWeight: 500 }}>{scanState.globalStep}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{scanState.globalProgress}%</span>
              </div>
              <div className="progress-container">
                <div className="progress-bar" style={{ width: `${scanState.globalProgress}%` }} />
              </div>
            </div>
          )}

          {/* Instance Progress Bars */}
          {Object.entries(scanState.instances || {}).map(([instanceName, state]) => (
            <div key={instanceName}>
              <div className="flex justify-between items-center mb-2">
                <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>{instanceName}: {state.step}</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{state.progress}%</span>
              </div>
              <div className="progress-container" style={{ height: '6px' }}>
                <div className="progress-bar" style={{ width: `${state.progress}%`, background: 'var(--primary)' }} />
              </div>
            </div>
          ))}

          {/* Long Running Phase Warning */}
          {scanState.globalStep?.includes('Fetching tracker info') && (
            <div style={{ 
              marginTop: '0.5rem', 
              padding: '0.75rem', 
              background: 'rgba(234,179,8,0.1)', 
              border: '1px solid rgba(234,179,8,0.3)', 
              borderRadius: '8px', 
              color: '#fde047', 
              fontSize: '0.8rem', 
              display: 'flex', 
              gap: '10px',
              alignItems: 'center' 
            }}>
              <AlertCircle size={18} style={{ flexShrink: 0 }} />
              <span>
                <strong>Geduld erforderlich:</strong> Das Abrufen der Tracker-Informationen kann bei vielen Torrents sehr lange dauern. 
                Die Webseite reagiert in dieser Zeit eventuell nicht mehr, aber der Scan läuft im Hintergrund zuverlässig weiter.
              </span>
            </div>
          )}
        </div>
      )}

      {mediaItems.length > 0 && (
        <div className="sidebar-layout mt-8">
          {/* ── Sidebar ── */}
          <div className="glass-panel" style={{ height: 'fit-content' }}>

            {/* Tracker Filter */}
            <div className="flex justify-between items-center mb-3">
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Radio size={16} /> Tracker Filter
              </h3>
              {selectedTrackers.length > 0 && (
                <button onClick={clearTrackers} className="btn btn-secondary btn-sm" style={{ fontSize: '0.7rem', padding: '2px 8px' }}>
                  Clear
                </button>
              )}
            </div>
            <p className="mb-3" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              Filter die Ergebnisse auf Torrents von ausgewählten Trackern. Wirkt sofort — kein Re-Scan nötig.
            </p>

            {trackerHosts.length === 0 ? (
              <button onClick={loadTrackerHosts} disabled={loadingTrackers} className="btn btn-secondary btn-sm" style={{ width: '100%', marginBottom: '1rem' }}>
                {loadingTrackers ? <RefreshCw size={14} className="animate-spin" /> : <Filter size={14} />}
                {loadingTrackers ? 'Loading...' : 'Load Trackers'}
              </button>
            ) : (
              <div className="flex flex-col gap-1 mb-4" style={{ maxHeight: '220px', overflowY: 'auto' }}>
                {trackerHosts.map(host => (
                  <div
                    key={host}
                    onClick={() => toggleTracker(host)}
                    className={`tag-badge ${selectedTrackers.includes(host) ? 'selected' : ''}`}
                    style={{ textAlign: 'center', padding: '0.4rem 0.5rem', fontSize: '0.78rem', cursor: 'pointer', borderRadius: '6px', wordBreak: 'break-all' }}
                  >
                    {host}
                  </div>
                ))}
              </div>
            )}

            {selectedTrackers.length > 0 && (
              <div className="mb-4" style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: '8px', padding: '0.5rem 0.75rem' }}>
                <p style={{ fontSize: '0.75rem', color: '#c084fc', margin: 0 }}>
                  ⚡ Aktiv: {selectedTrackers.join(', ')}
                </p>
              </div>
            )}

            {/* Ignore List */}
            <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '1rem', marginTop: '0.5rem' }}>
              <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Ignore List</h3>
              <p className="mb-3" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Exclude items whose path/name contains:
              </p>
              <form onSubmit={handleAddIgnoreKeyword} className="flex gap-2 mb-3">
                <input
                  type="text" value={newIgnoreKeyword}
                  onChange={(e) => setNewIgnoreKeyword(e.target.value)}
                  placeholder="e.g. cross-seed"
                  style={{ flex: 1, padding: '0.4rem', fontSize: '0.875rem' }}
                />
                <button type="submit" className="btn btn-primary btn-sm" style={{ padding: '0.4rem' }}>
                  <Plus size={16} />
                </button>
              </form>
              <div className="flex flex-col gap-2">
                {(settings.ignored_keywords || []).map(kw => (
                  <div key={kw} className="glass-card flex justify-between items-center" style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}>
                    <span style={{ wordBreak: 'break-all' }}>{kw}</span>
                    <button onClick={() => handleRemoveIgnoreKeyword(kw)} className="btn btn-danger btn-sm" style={{ padding: '2px', minWidth: 'auto', background: 'transparent', color: 'var(--text-secondary)' }}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Main Content ── */}
          <div>
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-3 flex-wrap">
                <h3 style={{ margin: 0, whiteSpace: 'nowrap', fontSize: '1.5rem' }}>
                  {displayMode === 'missing' ? 'Missing Media' : 'Available Media'} ({filteredMedia.length})
                </h3>

                {/* Missing / Available toggle */}
                <div className="flex gap-2 p-1 glass-card" style={{ padding: '6px', borderRadius: '10px' }}>
                  <button onClick={() => setDisplayMode('missing')} className={`btn btn-sm ${displayMode === 'missing' ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: '0.7rem', padding: '0.25rem 0.75rem' }}>Missing</button>
                  <button onClick={() => setDisplayMode('available')} className={`btn btn-sm ${displayMode === 'available' ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: '0.7rem', padding: '0.25rem 0.75rem' }}>Available</button>
                </div>

                {/* Hide/Show qBit Tags */}
                <button onClick={() => setShowAllTags(!showAllTags)} className={`btn btn-secondary btn-sm ${showAllTags ? 'active' : ''}`} style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', whiteSpace: 'nowrap' }}>
                  <Activity size={14} /> {showAllTags ? 'Hide Qbit Tags' : 'Show Qbit Tags'}
                </button>

                {/* Instance filter */}
                <select className="btn btn-secondary btn-sm" style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', height: 'auto', background: 'var(--glass-bg)', minWidth: '160px' }} value={filterInstance} onChange={(e) => setFilterInstance(e.target.value)}>
                  <option value="all">All Instances</option>
                  <optgroup label="Type">
                    <option value="type_radarr">All Radarr</option>
                    <option value="type_sonarr">All Sonarr</option>
                  </optgroup>
                  <optgroup label="Specific Instance">
                    {instances.map(inst => <option key={inst.id} value={`name_${inst.name}`}>{inst.name}</option>)}
                  </optgroup>
                </select>

                {/* Search All */}
                {displayMode === 'missing' && (
                  <button onClick={searchAllCrossSeed} disabled={searchAllStatus !== null} className="btn btn-primary btn-sm flex items-center gap-2" style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', whiteSpace: 'nowrap' }}>
                    {searchAllStatus ? <><RefreshCw size={14} className="animate-spin" /> {searchAllStatus.current}/{searchAllStatus.total}</> : <><Search size={14} /> Search All</>}
                  </button>
                )}
              </div>
            </div>

            {/* Search all progress bar */}
            {searchAllStatus && (
              <div className="glass-panel mb-6 animate-fade-in" style={{ padding: '0.75rem 1.5rem' }}>
                <div className="flex justify-between items-center mb-2">
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: '0.85rem' }}>Searching cross-seed: <strong>{searchAllStatus.currentItem}</strong></span>
                    {searchAllStatus.eta !== null && (
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginLeft: '1rem' }}>
                        ETA: {searchAllStatus.eta}s
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      {searchAllStatus.current} / {searchAllStatus.total} ({Math.round((searchAllStatus.current / searchAllStatus.total) * 100)}%)
                    </span>
                    <button 
                      onClick={cancelSearchAll} 
                      disabled={searchAllStatus.cancelRequested}
                      className="btn btn-danger btn-sm" 
                      style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}
                    >
                      {searchAllStatus.cancelRequested ? 'Canceling...' : 'Cancel'}
                    </button>
                  </div>
                </div>
                <div className="progress-container" style={{ height: '4px' }}>
                  <div className="progress-bar" style={{ width: `${(searchAllStatus.current / searchAllStatus.total) * 100}%` }} />
                </div>
              </div>
            )}

            {/* Media list */}
            <div className="media-list">
              {filteredMedia.map(item => (
                <div key={item.id} className="glass-card flex items-center gap-6">
                  <div style={{ flex: 1 }}>
                    <div className="flex justify-between items-start mb-1">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h4 style={{ fontSize: '1.2rem', fontWeight: 600, margin: 0 }}>{item.title}</h4>
                        <span style={{ fontSize: '0.65rem', padding: '2px 8px', borderRadius: '12px', background: item.type === 'movie' ? 'rgba(59,130,246,0.2)' : 'rgba(167,139,250,0.2)', color: item.type === 'movie' ? '#93c5fd' : '#d8b4fe' }}>
                          {item.type.toUpperCase()}
                        </span>
                        {displayMode === 'seeding' && item.inQbit && matchBadge(item.matchMethod)}
                      </div>
                    </div>
                    <p style={{ fontSize: '0.95rem', color: '#60a5fa', fontWeight: 500, marginBottom: '0.5rem', wordBreak: 'break-all' }}>
                      {item.releaseName}
                    </p>
                    <div className="flex gap-4 items-center mb-2">
                      <p style={{ fontSize: '0.85rem', margin: 0 }}><span style={{ color: 'var(--text-secondary)' }}>Instance:</span> {item.instanceName}</p>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', wordBreak: 'break-all', margin: 0 }}>{item.path}</p>
                    </div>
                    {displayMode === 'seeding' && showAllTags && item.inQbit && item.qbitTags.length > 0 && (
                      <div className="flex gap-2 flex-wrap animate-fade-in">
                        {item.qbitTags.map(t => <span key={t} className="tag-badge" style={{ fontSize: '0.65rem', padding: '1px 6px', cursor: 'default' }}>{t}</span>)}
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2" style={{ minWidth: '240px' }}>
                    <button onClick={() => copyCommand(item)} className="btn btn-primary btn-sm" style={{ flex: 1, padding: '0.6rem' }}>
                      {copiedId === item.id ? <Check size={16} /> : <Copy size={16} />}
                      {copiedId === item.id ? 'Copied' : 'Upload Cmd'}
                    </button>
                    {settings.cross_seed_url && (
                      <button
                        onClick={() => searchCrossSeed(item)}
                        className={`btn btn-secondary btn-sm ${searchLoading[item.id] === 'success' ? 'status-success' : ''} ${searchLoading[item.id] === 'error' ? 'status-error' : ''}`}
                        style={{ padding: '0.6rem', width: '40px' }}
                        title="Search in cross-seed"
                        disabled={searchLoading[item.id] === true}
                      >
                        {searchLoading[item.id] === true ? <RefreshCw size={16} className="animate-spin" /> :
                         searchLoading[item.id] === 'success' ? <CheckCircle size={16} /> :
                         searchLoading[item.id] === 'error' ? <XCircle size={16} /> :
                         <Search size={16} />}
                      </button>
                    )}
                    <a href={item.arrUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm" style={{ padding: '0.6rem' }} title="Open in *Arr">
                      <ExternalLink size={16} />
                    </a>
                  </div>
                </div>
              ))}

              {filteredMedia.length === 0 && (
                <div className="glass-panel" style={{ textAlign: 'center' }}>
                  <p>All clean! No {displayMode} media found for the current filters.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
