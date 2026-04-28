import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate } from 'react-router-dom';
import { Settings as SettingsIcon, LayoutDashboard, LogOut } from 'lucide-react';
import Dashboard from './components/Dashboard';
import Settings from './components/Settings';
import Login from './components/Login';
import axios from 'axios';
import './styles/main.css';

// Set up axios defaults
axios.defaults.baseURL = '/api';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthEnabled, setIsAuthEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Basic ${token}`;
    }
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const res = await axios.get('/auth-check');
      setIsAuthEnabled(res.data.auth_enabled);
      
      if (!res.data.auth_enabled || res.data.authenticated) {
        setIsAuthenticated(true);
      } else {
        setIsAuthenticated(false);
        delete axios.defaults.headers.common['Authorization'];
      }
    } catch (err) {
      setIsAuthenticated(false);
      delete axios.defaults.headers.common['Authorization'];
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = (token) => {
    localStorage.setItem('auth_token', token);
    axios.defaults.headers.common['Authorization'] = `Basic ${token}`;
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    localStorage.removeItem('auth_token');
    delete axios.defaults.headers.common['Authorization'];
    setIsAuthenticated(false);
    // Reload to ensure all states are clean
    window.location.href = '/login';
  };

  if (loading) return <div className="app-container"><p>Loading...</p></div>;

  return (
    <Router>
      <div className="app-container">
        {isAuthenticated && (
          <header className="nav-header">
            <div className="flex items-center gap-4">
              <h1 style={{ margin: 0, fontSize: '1.5rem' }}>qbit-vs-arr</h1>
            </div>
            <nav className="nav-links">
              <Link to="/" className="nav-link flex items-center gap-2">
                <LayoutDashboard size={18} /> Dashboard
              </Link>
              <Link to="/settings" className="nav-link flex items-center gap-2">
                <SettingsIcon size={18} /> Settings
              </Link>
              {isAuthEnabled && (
                <button onClick={handleLogout} className="btn btn-secondary flex items-center gap-2" style={{ padding: '0.5rem 1rem' }}>
                  <LogOut size={18} /> Logout
                </button>
              )}
            </nav>
          </header>
        )}

        <main>
          <Routes>
            <Route path="/login" element={!isAuthenticated ? <Login onLogin={handleLogin} /> : <Navigate to="/" />} />
            <Route path="/" element={isAuthenticated ? <Dashboard /> : <Navigate to="/login" />} />
            <Route path="/settings" element={isAuthenticated ? <Settings /> : <Navigate to="/login" />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
