import React, { useState, useEffect } from 'react';
import { Play, Copy, ExternalLink, Check, Search, Activity, RefreshCw, XCircle, CheckCircle, Plus, X } from 'lucide-react';
import axios from 'axios';

export default function Dashboard() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('Ready to scan');
  
  const [mediaItems, setMediaItems] = useState([]);
  const [availableTags, setAvailableTags] = useState([]);
  
  // Load selected tags from localStorage
  const [selectedTags, setSelectedTags] = useState(() => {
    const saved = localStorage.getItem('selectedTags');
    return saved ? JSON.parse(saved) : [];
  });
  
  const [displayMode, setDisplayMode] = useState('missing'); // 'missing' | 'available'
  const [showAllTags, setShowAllTags] = useState(true);
  const [copiedId, setCopiedId] = useState(null);
  const [settings, setSettings] = useState({ ignored_keywords: [] });
  const [instances, setInstances] = useState([]);
  const [filterInstance, setFilterInstance] = useState('all'); // 'all' | 'radarr' | 'sonarr' | 'instance_name'
  const [newIgnoreKeyword, setNewIgnoreKeyword] = useState('');

  // Save selected tags and settings to localStorage
  useEffect(() => {
    localStorage.setItem('selectedTags', JSON.stringify(selectedTags));
  }, [selectedTags]);

  // Load last scan results from server on mount
  useEffect(() => {
    fetchLastResults();
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const [settingsRes, instancesRes] = await Promise.all([
        axios.get('/settings'),
        axios.get('/instances')
      ]);
      setSettings(settingsRes.data);
      setInstances(instancesRes.data);
    } catch (error) {
      console.error("Failed to fetch settings", error);
    }
  };

  const fetchLastResults = async () => {
    try {
      const res = await axios.get('/last-results');
      if (res.data && res.data.media && res.data.media.length > 0) {
        setMediaItems(res.data.media);
        setAvailableTags(res.data.tags);
        setStatusText(`Last scan: ${new Date(res.data.timestamp).toLocaleString()}`);
        setProgress(100);
      }
    } catch (error) {
      console.error("Failed to fetch last scan results", error);
    }
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
      setAvailableTags(data.tags);
      setScanning(false);
      setProgress(100);
      setStatusText('Scan complete');
      eventSource.close();
    });

    eventSource.addEventListener('error', (e) => {
      const data = JSON.parse(e.data);
      setStatusText(`Error: ${data.message}`);
      setScanning(false);
      eventSource.close();
    });
  };

  const toggleTag = (tag) => {
    setSelectedTags(prev => 
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  };

  const copyCommand = (item) => {
    const cmdTemplate = settings.upload_command || 'docker exec -it upp upPollo upload --category cross-seed-link --tags manual "{path}"';
    const cmd = cmdTemplate
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
    
    try {
      await axios.post('/settings', { ignored_keywords: updated });
    } catch (error) {
      console.error("Failed to save ignored keywords", error);
    }
  };

  const handleRemoveIgnoreKeyword = async (keyword) => {
    const updated = (settings.ignored_keywords || []).filter(k => k !== keyword);
    setSettings(prev => ({ ...prev, ignored_keywords: updated }));
    
    try {
      await axios.post('/settings', { ignored_keywords: updated });
    } catch (error) {
      console.error("Failed to save ignored keywords", error);
    }
  };

  const filteredMedia = React.useMemo(() => {
    return mediaItems.filter(item => {
      // 0. Ignore List Filter
      if (settings.ignored_keywords && settings.ignored_keywords.length > 0) {
        const pathLower = item.path ? item.path.toLowerCase() : '';
        const releaseLower = item.releaseName ? item.releaseName.toLowerCase() : '';
        const titleLower = item.title ? item.title.toLowerCase() : '';
        const fileLower = item.fileName ? item.fileName.toLowerCase() : '';
        
        const shouldIgnore = settings.ignored_keywords.some(keyword => {
          const kw = keyword.toLowerCase();
          return pathLower.includes(kw) || releaseLower.includes(kw) || titleLower.includes(kw) || fileLower.includes(kw);
        });
        if (shouldIgnore) return false;
      }
      // 1. Instance Filter
      if (filterInstance !== 'all') {
        if (filterInstance.startsWith('type_')) {
          const type = filterInstance.replace('type_', '');
          if (type === 'radarr' && item.type !== 'movie') return false;
          if (type === 'sonarr' && item.type !== 'series') return false;
        } else if (filterInstance.startsWith('name_')) {
          const instName = filterInstance.replace('name_', '');
          if (item.instanceName !== instName) return false;
        }
      }

      // 2. Tag Filter
      if (selectedTags.length > 0) {
        if (!item.inQbit) return false;
        return selectedTags.some(tag => item.qbitTags.includes(tag));
      }

      // 3. Display Mode Filter
      if (displayMode === 'missing') {
        return !item.inQbit;
      } else {
        return item.inQbit;
      }
    });
  }, [mediaItems, selectedTags, displayMode, filterInstance, settings.ignored_keywords]);

  const [searchLoading, setSearchLoading] = useState({}); // { id: boolean }

  const searchCrossSeed = async (item) => {
    setSearchLoading(prev => ({ ...prev, [item.id]: true }));
    try {
      await axios.post('/cross-seed', { path: item.path });
      // Show success briefly
      setSearchLoading(prev => ({ ...prev, [item.id]: 'success' }));
    } catch (error) {
      console.error(error);
      setSearchLoading(prev => ({ ...prev, [item.id]: 'error' }));
    }
    setTimeout(() => {
      setSearchLoading(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }, 3000);
  };

  const [searchAllProgress, setSearchAllProgress] = useState(null);

  const searchAllCrossSeed = async () => {
    const itemsToSearch = filteredMedia;
    if (!itemsToSearch || itemsToSearch.length === 0) return;
    
    setSearchAllProgress({ current: 0, total: itemsToSearch.length });

    for (let i = 0; i < itemsToSearch.length; i++) {
      const item = itemsToSearch[i];
      setSearchAllProgress({ current: i + 1, total: itemsToSearch.length, currentItem: item.title });
      
      try {
        await axios.post('/cross-seed', { path: item.path });
      } catch (error) {
        console.error(`Failed to search ${item.title}:`, error);
      }
      
      // Delay to avoid hitting cross-seed too hard
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    setSearchAllProgress(null);
  };

  return (
    <div>
      <div className="glass-panel mb-4 flex justify-between items-center">
        <div>
          <h2>Media Sync Dashboard</h2>
          <p>Find downloaded media that is not seeded in qBittorrent.</p>
        </div>
        <button 
          onClick={handleScan} 
          disabled={scanning} 
          className="btn btn-primary"
        >
          {scanning ? <Search size={18} className="animate-spin" /> : <Play size={18} />}
          {scanning ? 'Scanning...' : 'Start Scan'}
        </button>
      </div>

      {(scanning || progress > 0) && (
        <div className="glass-panel mb-4 animate-fade-in">
          <div className="flex justify-between items-center mb-2">
            <span style={{ fontWeight: 500 }}>{statusText}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{progress}%</span>
          </div>
          <div className="progress-container">
            <div className="progress-bar" style={{ width: `${progress}%` }}></div>
          </div>
        </div>
      )}

      {mediaItems.length > 0 && (
        <div className="sidebar-layout mt-8">
          {/* Sidebar */}
          <div className="glass-panel" style={{ height: 'fit-content' }}>
            <div className="flex justify-between items-center mb-4">
              <h3 style={{ margin: 0 }}>Tracker Tags</h3>
              {selectedTags.length > 0 && (
                <button 
                  onClick={() => setSelectedTags([])} 
                  className="btn btn-secondary btn-sm"
                  style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                >
                  Clear
                </button>
              )}
            </div>
            <p className="mb-4" style={{ fontSize: '0.875rem' }}>
              Select tags to filter the list by tracker.
            </p>
            <div className="flex flex-col gap-2">
              {availableTags.map(tag => (
                <div 
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`tag-badge ${selectedTags.includes(tag) ? 'selected' : ''}`}
                  style={{ textAlign: 'center', padding: '0.5rem', fontSize: '0.875rem' }}
                >
                  {tag}
                </div>
              ))}
              {availableTags.length === 0 && (
                <p>No tags found in qBittorrent.</p>
              )}
            </div>

            {/* Ignore List Section */}
            <div className="mt-8">
              <h3 style={{ margin: 0, marginBottom: '1rem' }}>Ignore List</h3>
              <p className="mb-4" style={{ fontSize: '0.875rem' }}>
                Exclude items if their path contains:
              </p>
              
              <form onSubmit={handleAddIgnoreKeyword} className="flex gap-2 mb-4">
                <input 
                  type="text" 
                  value={newIgnoreKeyword} 
                  onChange={(e) => setNewIgnoreKeyword(e.target.value)} 
                  placeholder="e.g. Kaleidoscope" 
                  style={{ flex: 1, padding: '0.4rem', fontSize: '0.875rem' }}
                />
                <button type="submit" className="btn btn-primary btn-sm" style={{ padding: '0.4rem' }}>
                  <Plus size={16} />
                </button>
              </form>

              <div className="flex flex-col gap-2">
                {(settings.ignored_keywords || []).map(keyword => (
                  <div key={keyword} className="glass-card flex justify-between items-center" style={{ padding: '0.5rem', fontSize: '0.875rem' }}>
                    <span style={{ wordBreak: 'break-all' }}>{keyword}</span>
                    <button 
                      onClick={() => handleRemoveIgnoreKeyword(keyword)} 
                      className="btn btn-danger btn-sm"
                      style={{ padding: '2px', minWidth: 'auto', background: 'transparent', color: 'var(--text-secondary)' }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Main Content */}
          <div>
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-8">
                <h3 style={{ margin: 0, whiteSpace: 'nowrap', fontSize: '1.5rem' }}>
                  {displayMode === 'missing' ? 'Missing Media' : 'Available Media'} ({filteredMedia.length})
                </h3>
                
                <div className="flex gap-2 p-1 glass-card" style={{ padding: '6px', borderRadius: '10px' }}>
                  <button 
                    onClick={() => setDisplayMode('missing')} 
                    className={`btn btn-sm ${displayMode === 'missing' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.75rem' }}
                  >
                    Missing
                  </button>
                  <button 
                    onClick={() => setDisplayMode('available')} 
                    className={`btn btn-sm ${displayMode === 'available' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.75rem' }}
                  >
                    Available
                  </button>
                </div>

                <button 
                  onClick={() => setShowAllTags(!showAllTags)} 
                  className={`btn btn-secondary btn-sm ${showAllTags ? 'active' : ''}`}
                  style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', whiteSpace: 'nowrap' }}
                >
                  <Activity size={14} /> {showAllTags ? 'Hide Qbit Tags' : 'Show Qbit Tags'}
                </button>

                <select 
                  className="btn btn-secondary btn-sm"
                  style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', height: 'auto', background: 'var(--glass-bg)', minWidth: '160px' }}
                  value={filterInstance}
                  onChange={(e) => setFilterInstance(e.target.value)}
                >
                  <option value="all">All Instances</option>
                  <optgroup label="Type">
                    <option value="type_radarr">All Radarr</option>
                    <option value="type_sonarr">All Sonarr</option>
                  </optgroup>
                  <optgroup label="Specific Instance">
                    {instances.map(inst => (
                      <option key={inst.id} value={`name_${inst.name}`}>{inst.name}</option>
                    ))}
                  </optgroup>
                </select>

                {displayMode === 'missing' && (
                  <button 
                    onClick={searchAllCrossSeed} 
                    disabled={searchAllProgress !== null}
                    className="btn btn-primary btn-sm flex items-center gap-2"
                    style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', whiteSpace: 'nowrap' }}
                  >
                    {searchAllProgress ? (
                      <><RefreshCw size={14} className="animate-spin" /> {searchAllProgress.current} / {searchAllProgress.total}</>
                    ) : (
                      <><Search size={14} /> Search All</>
                    )}
                  </button>
                )}
              </div>
            </div>
            
            {searchAllProgress && (
              <div className="glass-panel mb-6 animate-fade-in" style={{ padding: '0.75rem 1.5rem' }}>
                <div className="flex justify-between items-center mb-2">
                  <span style={{ fontSize: '0.85rem' }}>Searching cross-seed: <strong>{searchAllProgress.currentItem}</strong></span>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    {Math.round((searchAllProgress.current / searchAllProgress.total) * 100)}%
                  </span>
                </div>
                <div className="progress-container" style={{ height: '4px' }}>
                  <div 
                    className="progress-bar" 
                    style={{ width: `${(searchAllProgress.current / searchAllProgress.total) * 100}%` }}
                  ></div>
                </div>
              </div>
            )}
            
            <div className="media-list">
              {filteredMedia.map(item => (
                <div key={item.id} className="glass-card flex items-center gap-6">
                  <div style={{ flex: 1 }}>
                    <div className="flex justify-between items-start mb-1">
                      <div className="flex items-center gap-3">
                        <h4 style={{ fontSize: '1.2rem', fontWeight: 600, margin: 0 }}>{item.title}</h4>
                        <span style={{ 
                          fontSize: '0.65rem', 
                          padding: '2px 8px', 
                          borderRadius: '12px', 
                          background: item.type === 'movie' ? 'rgba(59, 130, 246, 0.2)' : 'rgba(167, 139, 250, 0.2)',
                          color: item.type === 'movie' ? '#93c5fd' : '#d8b4fe'
                        }}>
                          {item.type.toUpperCase()}
                        </span>
                      </div>
                    </div>
                    
                    <p style={{ fontSize: '0.95rem', color: '#60a5fa', fontWeight: 500, marginBottom: '0.5rem', wordBreak: 'break-all' }}>
                      {item.releaseName}
                    </p>
                    
                    <div className="flex gap-4 items-center mb-2">
                      <p style={{ fontSize: '0.85rem', margin: 0 }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Instance:</span> {item.instanceName}
                      </p>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', wordBreak: 'break-all', margin: 0 }}>
                        {item.path}
                      </p>
                    </div>
                    
                    {showAllTags && item.inQbit && item.qbitTags.length > 0 && (
                      <div className="flex gap-2 flex-wrap animate-fade-in">
                        {item.qbitTags.map(t => (
                          <span key={t} className="tag-badge" style={{ fontSize: '0.65rem', padding: '1px 6px', cursor: 'default' }}>{t}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2" style={{ minWidth: '240px' }}>
                    <button 
                      onClick={() => copyCommand(item)}
                      className="btn btn-primary btn-sm"
                      style={{ flex: 1, padding: '0.6rem' }}
                    >
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

                    <a 
                      href={item.arrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-secondary btn-sm"
                      style={{ padding: '0.6rem' }}
                      title="Open in *Arr"
                    >
                      <ExternalLink size={16} />
                    </a>
                  </div>
                </div>
              ))}
              
              {filteredMedia.length === 0 && (
                <div className="glass-panel" style={{ textAlign: 'center' }}>
                  <p>All clean! No missing media found for the current filters.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
