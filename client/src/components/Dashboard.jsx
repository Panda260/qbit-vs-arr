import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Copy, ExternalLink, Check, Search, Activity, RefreshCw, XCircle, CheckCircle, Plus, X, Filter, Radio } from 'lucide-react';
import axios from 'axios';

export default function Dashboard() {
  const [scanning, setScanning]       = useState(false);
  const [progress, setProgress]       = useState(0);
  const [statusText, setStatusText]   = useState('Ready to scan');
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
    fetchSettings().then(data => {
      if (data && data.scan_on_startup) {
        handleScan();
      } else {
        fetchLastResults();
      }
    });
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
      return settingsRes.data;
    } catch (err) { console.error('Failed to fetch settings', err); return null; }
  };

  const fetchLastResults = async () => {
    try {
      const res = await axios.get('/last-results');
      if (res.data?.media?.length > 0) {
        setMediaItems(res.data.media);
        setAvailableTags(res.data.tags || []);
        if (res.data.trackerHosts?.length > 0) setTrackerHosts(res.data.trackerHosts);
        setStatusText(`Last scan: ${new Date(res.data.timestamp).toLocaleString()}`);
        setProgress(100);
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

  const handleScan = () => {
    setScanning(true);
    setProgress(0);
    setStatusText('Starting scan...');
    setMediaItems([]);
    setAvailableTags([]);

    const eventSource = new EventSource('/api/scan');

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      setProgress(data.progress);
      setStatusText(data.step);
    });

    eventSource.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      setMediaItems(data.media);
      setAvailableTags(data.tags || []);
      if (data.trackerHosts?.length > 0) setTrackerHosts(data.trackerHosts);
      setScanning(false);
      setProgress(100);
      setStatusText('Scan complete');
      eventSource.close();
    });

    eventSource.addEventListener('error', (e) => {
      try { const data = JSON.parse(e.data); setStatusText(`Error: ${data.message}`); }
      catch { setStatusText('Scan failed.'); }
      setScanning(false);
      eventSource.close();
    });
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

  const [searchAllProgress, setSearchAllProgress] = useState(null);

  const searchAllCrossSeed = async () => {
    if (!filteredMedia?.length) return;
    setSearchAllProgress({ current: 0, total: filteredMedia.length });
    for (let i = 0; i < filteredMedia.length; i++) {
      const item = filteredMedia[i];
      setSearchAllProgress({ current: i + 1, total: filteredMedia.length, currentItem: item.title });
      try { await axios.post('/cross-seed', { path: item.path }); }
      catch (err) { console.error(`Failed to search ${item.title}:`, err); }
      // Use the ref so delay changes in Settings apply immediately, even mid-run
      const delayMs = Math.max(0, crossSeedDelayRef.current * 1000);
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }
    setSearchAllProgress(null);
  };

  // Match method label
  const matchBadge = (method) => {
    if (!method || method === 'none') return null;
    const styles = {
      hash:    { bg: 'rgba(6,182,212,0.15)',   color: '#67e8f9', border: '1px solid rgba(6,182,212,0.3)',   label: '🔑 HASH'    },
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
        </div>
        <button onClick={handleScan} disabled={scanning} className="btn btn-primary">
          {scanning ? <Search size={18} className="animate-spin" /> : <Play size={18} />}
          {scanning ? 'Scanning...' : 'Start Scan'}
        </button>
      </div>

      {/* Progress */}
      {(scanning || progress > 0) && (
        <div className="glass-panel mb-4 animate-fade-in">
          <div className="flex justify-between items-center mb-2">
            <span style={{ fontWeight: 500 }}>{statusText}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{progress}%</span>
          </div>
          <div className="progress-container">
            <div className="progress-bar" style={{ width: `${progress}%` }} />
          </div>
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
                  <button onClick={searchAllCrossSeed} disabled={searchAllProgress !== null} className="btn btn-primary btn-sm flex items-center gap-2" style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', whiteSpace: 'nowrap' }}>
                    {searchAllProgress ? <><RefreshCw size={14} className="animate-spin" /> {searchAllProgress.current}/{searchAllProgress.total}</> : <><Search size={14} /> Search All</>}
                  </button>
                )}
              </div>
            </div>

            {/* Search all progress bar */}
            {searchAllProgress && (
              <div className="glass-panel mb-6 animate-fade-in" style={{ padding: '0.75rem 1.5rem' }}>
                <div className="flex justify-between items-center mb-2">
                  <span style={{ fontSize: '0.85rem' }}>Searching cross-seed: <strong>{searchAllProgress.currentItem}</strong></span>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{Math.round((searchAllProgress.current / searchAllProgress.total) * 100)}%</span>
                </div>
                <div className="progress-container" style={{ height: '4px' }}>
                  <div className="progress-bar" style={{ width: `${(searchAllProgress.current / searchAllProgress.total) * 100}%` }} />
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
                        {item.inQbit && matchBadge(item.matchMethod)}
                      </div>
                    </div>
                    <p style={{ fontSize: '0.95rem', color: '#60a5fa', fontWeight: 500, marginBottom: '0.5rem', wordBreak: 'break-all' }}>
                      {item.releaseName}
                    </p>
                    <div className="flex gap-4 items-center mb-2">
                      <p style={{ fontSize: '0.85rem', margin: 0 }}><span style={{ color: 'var(--text-secondary)' }}>Instance:</span> {item.instanceName}</p>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', wordBreak: 'break-all', margin: 0 }}>{item.path}</p>
                    </div>
                    {showAllTags && item.inQbit && item.qbitTags.length > 0 && (
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
