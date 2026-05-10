import React, { useState, useEffect } from 'react';
import { Save, Plus, Trash2, CheckCircle, XCircle, RefreshCw, Activity, Edit2 } from 'lucide-react';
import axios from 'axios';

const MATCH_MODES = [
  {
    value: 'hybrid',
    label: '🕒 Hybrid: History + Name (Recommended)',
    description: 'Fetches the most recent "grabbed" event from Radarr/Sonarr history to get the exact scene/release name, then matches it against the qBittorrent torrent name. Falls back to sanitized name matching if no history found. Most reliable for NZB + Torrent mixed setups.',
  },
  {
    value: 'name_then_size',
    label: '🏷️ Name → Size Fallback',
    description: 'Matches by sanitized release name first (fast). If no name match is found, falls back to exact video file size matching. Cross-seed duplicates with the same release name are correctly identified. Good default for pure torrent setups.',
  },
  {
    value: 'name_only',
    label: '🔤 Name Only',
    description: 'Only matches by sanitized release name. No size fallback. Fast but may miss items if the torrent name differs from the release name in *Arr (e.g. renamed torrents or NZB downloads).',
  },
  {
    value: 'size_only',
    label: '📏 Size Only',
    description: 'Matches solely by exact video file size (≥100 MB). Ignores names entirely. Useful when torrent names are unrelated to release names. Note: if two different releases share the same file size, the match is skipped to avoid false positives.',
  },
];

export default function Settings() {
  const [settings, setSettings] = useState({
    auth_enabled: false,
    admin_user: '',
    admin_password: '',
    has_password: false,
    qbit_url: '',
    qbit_user: '',
    qbit_password: '',
    has_qbit_pass: false,
    match_mode: 'hybrid',
    cross_seed_url: '',
    cross_seed_api_key: '',
    upload_command: '',
    cross_seed_delay: 30,
  });

  const [instances, setInstances] = useState([]);
  const [newInstance, setNewInstance] = useState({ type: 'radarr', name: '', url_internal: '', url_external: '', api_key: '' });

  const [saveStatus, setSaveStatus]           = useState(null);
  const [qbitTestStatus, setQbitTestStatus]   = useState(null);
  const [crossSeedTestStatus, setCrossSeedTestStatus] = useState(null);
  const [arrTestStatus, setArrTestStatus]     = useState(null);
  const [deleteConfirm, setDeleteConfirm]     = useState(null);
  const [editingInstance, setEditingInstance] = useState(null);
  const [instanceTests, setInstanceTests]     = useState({});

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    try {
      const [settingsRes, instancesRes] = await Promise.all([
        axios.get('/settings'),
        axios.get('/instances')
      ]);
      setSettings(prev => ({ ...prev, ...settingsRes.data }));
      setInstances(instancesRes.data);
    } catch (err) { console.error('Failed to fetch settings', err); }
  };

  // Unified save — saves ALL settings fields at once
  const handleSettingsSave = async (e) => {
    if (e) e.preventDefault();
    setSaveStatus(null);
    try {
      await axios.post('/settings', settings);
      setSaveStatus('success');
      fetchData();
      setTimeout(() => setSaveStatus(null), 3000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 3000);
    }
  };

  const testQbitConnection = async () => {
    setQbitTestStatus('loading');
    try {
      await axios.post('/test/qbit', { url: settings.qbit_url, username: settings.qbit_user, password: settings.qbit_password || '' });
      setQbitTestStatus('success');
    } catch { setQbitTestStatus('error'); }
    setTimeout(() => setQbitTestStatus(null), 5000);
  };

  const testCrossSeedConnection = async () => {
    setCrossSeedTestStatus('loading');
    try {
      await axios.post('/test/cross-seed', { url: settings.cross_seed_url, apiKey: settings.cross_seed_api_key });
      setCrossSeedTestStatus('success');
    } catch { setCrossSeedTestStatus('error'); }
    setTimeout(() => setCrossSeedTestStatus(null), 5000);
  };

  const testArrConnection = async () => {
    setArrTestStatus('loading');
    try {
      await axios.post('/test/arr', { type: newInstance.type, url: newInstance.url_internal, apiKey: newInstance.api_key });
      setArrTestStatus('success');
    } catch { setArrTestStatus('error'); }
    setTimeout(() => setArrTestStatus(null), 5000);
  };

  const testSavedInstance = async (inst) => {
    setInstanceTests(prev => ({ ...prev, [inst.id]: 'loading' }));
    try {
      await axios.post('/test/arr', { type: inst.type, url: inst.url_internal, apiKey: inst.api_key });
      setInstanceTests(prev => ({ ...prev, [inst.id]: 'success' }));
    } catch { setInstanceTests(prev => ({ ...prev, [inst.id]: 'error' })); }
    setTimeout(() => setInstanceTests(prev => { const n = { ...prev }; delete n[inst.id]; return n; }), 5000);
  };

  const handleAddInstance = async (e) => {
    e.preventDefault();
    try {
      await axios.post('/instances', newInstance);
      setNewInstance({ type: 'radarr', name: '', url_internal: '', url_external: '', api_key: '' });
      fetchData();
    } catch { setSaveStatus('error'); }
  };

  const handleUpdateInstance = async (e) => {
    e.preventDefault();
    try {
      await axios.put(`/instances/${editingInstance.id}`, editingInstance);
      setEditingInstance(null);
      fetchData();
    } catch { alert('Failed to update instance'); }
  };

  const currentMode = MATCH_MODES.find(m => m.value === settings.match_mode) || MATCH_MODES[0];

  const statusBtn = (status) => ({
    className: `btn btn-secondary ${status === 'success' ? 'status-success' : ''} ${status === 'error' ? 'status-error' : ''}`,
    disabled: status === 'loading',
  });

  const statusIcon = (status, IdleIcon) => (
    status === 'loading' ? <RefreshCw size={18} className="animate-spin" /> :
    status === 'success' ? <CheckCircle size={18} /> :
    status === 'error'   ? <XCircle size={18} /> :
    <IdleIcon size={18} />
  );

  return (
    <div className="grid-3">

      {/* ── Global & Matching Settings ── */}
      <div className="glass-panel">
        <h2 className="flex items-center gap-2"><Save size={24} /> Global Settings</h2>

        <form onSubmit={handleSettingsSave}>

          {/* Auth */}
          <div className="mb-6">
            <h3>Authentication</h3>
            <p className="mb-4" style={{ fontSize: '0.875rem' }}>If enabled, a login is required.</p>
            <div className="form-group flex items-center gap-2">
              <input type="checkbox" id="auth_enabled" checked={!!settings.auth_enabled}
                onChange={(e) => setSettings({ ...settings, auth_enabled: e.target.checked })}
                style={{ width: 'auto' }} />
              <label htmlFor="auth_enabled" style={{ margin: 0 }}>Enable Authentication</label>
            </div>
            {settings.auth_enabled && (
              <>
                <div className="form-group">
                  <label>Admin Username</label>
                  <input type="text" value={settings.admin_user || ''} onChange={e => setSettings({ ...settings, admin_user: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Admin Password {settings.has_password && '(Leave empty to keep current)'}</label>
                  <input type="password" placeholder={settings.has_password ? '••••••••' : ''} onChange={e => setSettings({ ...settings, admin_password: e.target.value })} />
                </div>
              </>
            )}
          </div>

          {/* Matching Mode */}
          <div className="mb-6" style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '1.5rem' }}>
            <h3>Matching Mode</h3>
            <p className="mb-4" style={{ fontSize: '0.875rem' }}>Controls how *Arr media is matched against qBittorrent torrents.</p>
            <div className="form-group">
              <label htmlFor="match_mode">Strategy</label>
              <select id="match_mode" value={settings.match_mode || 'hybrid'} onChange={e => setSettings({ ...settings, match_mode: e.target.value })}>
                {MATCH_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid var(--glass-border)', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
              {currentMode.description}
            </div>
          </div>

          {/* Single Save Button */}
          <button
            type="submit"
            className={`btn btn-primary ${saveStatus === 'success' ? 'btn-success-animate' : ''}`}
            style={{ width: '100%' }}
          >
            {saveStatus === 'success' ? <CheckCircle size={18} /> : saveStatus === 'error' ? <XCircle size={18} /> : <Save size={18} />}
            {saveStatus === 'success' ? 'Saved!' : saveStatus === 'error' ? 'Save Failed' : 'Save Settings'}
          </button>
        </form>
      </div>

      {/* ── Torrent Settings ── */}
      <div className="glass-panel">
        <h2 className="flex items-center gap-2">🚀 Torrent Settings</h2>

        <form onSubmit={handleSettingsSave}>
          {/* qBittorrent */}
          <div className="mb-6">
            <h3>qBittorrent</h3>
            <div className="form-group">
              <label>URL (Internal)</label>
              <input type="url" required value={settings.qbit_url || ''} onChange={e => setSettings({ ...settings, qbit_url: e.target.value })} placeholder="http://qbittorrent:8080" />
            </div>
            <div className="form-group">
              <label>Username</label>
              <input type="text" required value={settings.qbit_user || ''} onChange={e => setSettings({ ...settings, qbit_user: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Password {settings.has_qbit_pass && '(Leave empty to keep current)'}</label>
              <input type="password" placeholder={settings.has_qbit_pass ? '••••••••' : ''} onChange={e => setSettings({ ...settings, qbit_password: e.target.value })} />
            </div>
            <button type="button" onClick={testQbitConnection} {...statusBtn(qbitTestStatus)} style={{ width: '100%' }}>
              {statusIcon(qbitTestStatus, Activity)} Test qBittorrent
            </button>
          </div>

          {/* cross-seed */}
          <div className="mb-6" style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '1.5rem' }}>
            <h3>cross-seed</h3>
            <div className="form-group">
              <label>URL</label>
              <input type="url" value={settings.cross_seed_url || ''} onChange={e => setSettings({ ...settings, cross_seed_url: e.target.value })} placeholder="http://192.168.1.100:2468" />
            </div>
            <div className="form-group">
              <label>API Key</label>
              <input type="password" value={settings.cross_seed_api_key || ''} onChange={e => setSettings({ ...settings, cross_seed_api_key: e.target.value })} placeholder="cross-seed api-key" />
            </div>
            <div className="form-group">
              <label>Upload Command Template</label>
              <input type="text" value={settings.upload_command || ''} onChange={e => setSettings({ ...settings, upload_command: e.target.value })} placeholder='docker exec -it upp upPollo upload --category cross-seed-link --tags manual "{path}"' />
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                Variables: <code>{`{path}`}</code>, <code>{`{title}`}</code>, <code>{`{type}`}</code>, <code>{`{instance}`}</code>, <code>{`{releaseName}`}</code>, <code>{`{fileName}`}</code>
              </p>
            </div>
            <div className="form-group">
              <label>Search All – Delay between requests (seconds)</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={settings.cross_seed_delay ?? 30}
                onChange={e => setSettings({ ...settings, cross_seed_delay: parseFloat(e.target.value) || 0 })}
              />
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                Wartezeit zwischen zwei cross-seed Suchen beim "Search All". Änderungen greifen sofort — auch während ein Search All läuft. Standard: 30 s
              </p>
            </div>
            <button type="button" onClick={testCrossSeedConnection} {...statusBtn(crossSeedTestStatus)} style={{ width: '100%' }}>
              {statusIcon(crossSeedTestStatus, Activity)} Test cross-seed
            </button>
          </div>

          {/* Save */}
          <button
            type="submit"
            className={`btn btn-primary ${saveStatus === 'success' ? 'btn-success-animate' : ''}`}
            style={{ width: '100%' }}
          >
            {saveStatus === 'success' ? <CheckCircle size={18} /> : saveStatus === 'error' ? <XCircle size={18} /> : <Save size={18} />}
            {saveStatus === 'success' ? 'Saved!' : saveStatus === 'error' ? 'Save Failed' : 'Save Torrent Settings'}
          </button>
        </form>
      </div>

      {/* ── Instances ── */}
      <div className="flex flex-col gap-4">
        <div className="glass-panel">
          <h2 className="flex items-center gap-2"><Plus size={24} /> Add Instance</h2>
          <form onSubmit={handleAddInstance}>
            <div className="form-group">
              <label>Type</label>
              <select value={newInstance.type} onChange={e => setNewInstance({ ...newInstance, type: e.target.value })}>
                <option value="radarr">Radarr</option>
                <option value="sonarr">Sonarr</option>
              </select>
            </div>
            <div className="form-group">
              <label>Name</label>
              <input type="text" required value={newInstance.name} onChange={e => setNewInstance({ ...newInstance, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>URL (Internal)</label>
              <input type="url" required value={newInstance.url_internal} onChange={e => setNewInstance({ ...newInstance, url_internal: e.target.value })} placeholder="http://radarr:7878" />
            </div>
            <div className="form-group">
              <label>URL (External/Display)</label>
              <input type="url" required value={newInstance.url_external} onChange={e => setNewInstance({ ...newInstance, url_external: e.target.value })} placeholder="https://radarr.yourdomain.com" />
            </div>
            <div className="form-group">
              <label>API Key</label>
              <input type="password" required value={newInstance.api_key} onChange={e => setNewInstance({ ...newInstance, api_key: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={testArrConnection} {...statusBtn(arrTestStatus)} style={{ flex: 1 }}>
                {statusIcon(arrTestStatus, Activity)} Test
              </button>
              <button type="submit" className="btn btn-primary" style={{ flex: 2 }}>
                <Plus size={18} /> Add
              </button>
            </div>
          </form>
        </div>

        <div className="glass-panel">
          <h3>Saved Instances</h3>
          <div className="flex flex-col gap-2 mt-4">
            {instances.length === 0 ? (
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>No instances added yet.</p>
            ) : instances.map(inst => (
              <div key={inst.id} className="glass-card flex justify-between items-center" style={{ padding: '0.75rem' }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: '1rem' }}>{inst.name}</h4>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{inst.type.toUpperCase()}</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => testSavedInstance(inst)}
                    className={`btn btn-secondary btn-sm ${instanceTests[inst.id] === 'success' ? 'status-success' : ''} ${instanceTests[inst.id] === 'error' ? 'status-error' : ''}`}
                    disabled={instanceTests[inst.id] === 'loading'} title="Test Connection">
                    {instanceTests[inst.id] === 'loading' ? <RefreshCw size={14} className="animate-spin" /> : <Activity size={14} />}
                  </button>
                  <button onClick={() => setEditingInstance(inst)} className="btn btn-secondary btn-sm" title="Edit"><Edit2 size={14} /></button>
                  <button onClick={() => setDeleteConfirm(inst.id)} className="btn btn-danger btn-sm" title="Delete"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Edit Instance Modal */}
      {editingInstance && (
        <div className="modal-overlay">
          <div className="glass-panel modal-content">
            <h2 className="mb-4">Edit Instance: {editingInstance.name}</h2>
            <form onSubmit={handleUpdateInstance}>
              <div className="form-group">
                <label>Type</label>
                <select value={editingInstance.type} onChange={e => setEditingInstance({ ...editingInstance, type: e.target.value })}>
                  <option value="radarr">Radarr</option>
                  <option value="sonarr">Sonarr</option>
                </select>
              </div>
              <div className="form-group"><label>Name</label><input type="text" required value={editingInstance.name} onChange={e => setEditingInstance({ ...editingInstance, name: e.target.value })} /></div>
              <div className="form-group"><label>URL (Internal)</label><input type="url" required value={editingInstance.url_internal} onChange={e => setEditingInstance({ ...editingInstance, url_internal: e.target.value })} /></div>
              <div className="form-group"><label>URL (External/Display)</label><input type="url" required value={editingInstance.url_external} onChange={e => setEditingInstance({ ...editingInstance, url_external: e.target.value })} /></div>
              <div className="form-group"><label>API Key</label><input type="password" required value={editingInstance.api_key} onChange={e => setEditingInstance({ ...editingInstance, api_key: e.target.value })} /></div>
              <div className="flex gap-4 mt-6">
                <button type="button" onClick={() => setEditingInstance(null)} className="btn btn-secondary" style={{ flex: 1 }}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteConfirm && (
        <div className="modal-overlay">
          <div className="glass-panel" style={{ width: '100%', maxWidth: '400px', textAlign: 'center' }}>
            <h2 className="mb-4">Are you sure?</h2>
            <p className="mb-6">Do you really want to delete this instance?</p>
            <div className="flex gap-4">
              <button onClick={() => setDeleteConfirm(null)} className="btn btn-secondary" style={{ flex: 1 }}>Cancel</button>
              <button onClick={async () => { await axios.delete(`/instances/${deleteConfirm}`); setDeleteConfirm(null); fetchData(); }}
                className="btn btn-danger" style={{ flex: 1 }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
