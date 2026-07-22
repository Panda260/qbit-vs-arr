import React, { useState } from 'react';
import axios from 'axios';
import { Search, Server, FileText, Database } from 'lucide-react';

function Debug() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    
    setLoading(true);
    setError('');
    setResults(null);
    
    try {
      const res = await axios.get(`/debug/item?title=${encodeURIComponent(query.trim())}`);
      setResults(res.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Error fetching debug data');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="settings-layout">
      <div className="glass-panel" style={{ padding: '2rem' }}>
        <h2 className="mb-4" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Search size={24} /> Debug Item Search
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          Search for a specific title from the last scan to see exactly why it matched (or didn't match) with qBittorrent candidates.
        </p>

        <form onSubmit={handleSearch} className="flex gap-4 mb-8">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title (e.g. 'Matrix')"
            className="form-input"
            style={{ flex: 1, padding: '0.75rem 1rem', fontSize: '1rem' }}
          />
          <button type="submit" className="btn btn-primary" disabled={loading} style={{ padding: '0 2rem' }}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>

        {error && (
          <div style={{ padding: '1rem', background: 'rgba(239,68,68,0.1)', color: '#f87171', borderRadius: '8px', marginBottom: '2rem' }}>
            {error}
          </div>
        )}

        {results && (
          <div className="debug-results flex flex-col gap-6">
            {results.length === 0 ? (
              <p>No matching items found in the last scan.</p>
            ) : (
              results.map((info, i) => (
                <div key={i} className="glass-card" style={{ border: '1px solid rgba(147,197,253,0.2)' }}>
                  <h3 style={{ color: '#93c5fd', borderBottom: '1px solid rgba(147,197,253,0.1)', paddingBottom: '0.5rem', marginBottom: '1rem' }}>
                    {info.arrItem.title} <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>({info.arrItem.instanceName})</span>
                  </h3>
                  
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                      <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textTransform: 'uppercase' }}>Arr Info</h4>
                      <p><strong>Path:</strong> {info.arrItem.path}</p>
                      <p><strong>Release:</strong> {info.arrItem.releaseName}</p>
                      <p><strong>File:</strong> {info.arrItem.fileName}</p>
                      <p><strong>Language:</strong> {info.arrItem.arrLanguage || (info.arrItem.isGerman ? 'German (Regex)' : 'Unknown')}</p>
                    </div>
                    <div>
                      <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textTransform: 'uppercase' }}>Match Info</h4>
                      <p><strong>Status:</strong> {info.arrItem.inQbit ? <span style={{ color: '#4ade80' }}>Matched</span> : <span style={{ color: '#f87171' }}>Missing</span>}</p>
                      <p><strong>Method:</strong> {info.arrItem.matchMethod}</p>
                      {info.arrItem.inQbit && (
                        <>
                          <p><strong>Tags:</strong> {(info.arrItem.qbitTags || []).join(', ')}</p>
                          <p><strong>Trackers:</strong> {(info.arrItem.qbitTrackerHosts || []).join(', ')}</p>
                        </>
                      )}
                    </div>
                  </div>

                  <h4 style={{ color: '#fde047', fontSize: '0.9rem', marginBottom: '0.5rem', borderBottom: '1px solid rgba(253,224,71,0.2)', paddingBottom: '0.25rem' }}>
                    qBittorrent Candidates ({info.qbitCandidates?.length || 0})
                  </h4>
                  {info.qbitCandidates && info.qbitCandidates.length > 0 ? (
                    <div className="flex flex-col gap-3 mt-3">
                      {info.qbitCandidates.map((c, j) => (
                        <div key={j} style={{ background: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: '6px' }}>
                          <p style={{ margin: '0 0 4px 0', color: '#60a5fa', wordBreak: 'break-all' }}><strong>Name:</strong> {c.name}</p>
                          <p style={{ margin: '0 0 4px 0', fontSize: '0.85rem' }}><strong>Path:</strong> {c.content_path}</p>
                          <p style={{ margin: '0 0 4px 0', fontSize: '0.85rem' }}><strong>Category/Tags:</strong> {c.category} / {c.tags}</p>
                          <p style={{ margin: '0', fontSize: '0.85rem' }}><strong>Trackers:</strong> {c.parsedTrackerHosts?.join(', ')}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>No torrents in qBittorrent shared a similar title or release name.</p>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default Debug;
