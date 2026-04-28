import React, { useState } from 'react';
import axios from 'axios';
import { Lock } from 'lucide-react';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    const token = btoa(`${username}:${password}`);
    
    try {
      await axios.get('/auth-check', {
        headers: {
          Authorization: `Basic ${token}`
        }
      });
      onLogin(token);
    } catch (err) {
      setError('Invalid credentials');
    }
  };

  return (
    <div className="login-wrapper">
      <div className="glass-panel" style={{ width: '100%', maxWidth: '400px' }}>
        <div className="flex flex-col items-center mb-6">
          <Lock size={48} className="mb-4" style={{ color: 'var(--accent)' }} />
          <h2>Authentication Required</h2>
        </div>
        
        {error && (
          <div className="mb-4" style={{ color: 'var(--danger)', background: 'rgba(239, 68, 68, 0.1)', padding: '0.75rem', borderRadius: '8px' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username</label>
            <input 
              type="text" 
              value={username} 
              onChange={(e) => setUsername(e.target.value)} 
              required 
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input 
              type="password" 
              value={password} 
              onChange={(e) => setPassword(e.target.value)} 
              required 
            />
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
            Login
          </button>
        </form>
      </div>
    </div>
  );
}
