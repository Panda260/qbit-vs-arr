const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const { getSetting } = require('./services/db');
const apiRoutes = require('./routes/api');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Auth Middleware
const authMiddleware = (req, res, next) => {
  const authEnabled = getSetting('auth_enabled', false) || !!process.env.ADMIN_PASSWORD;
  
  const adminUser = process.env.ADMIN_USER || getSetting('admin_user', 'admin');
  const adminPass = process.env.ADMIN_PASSWORD || getSetting('admin_password', '');

  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  const isAuthenticated = login && password && login === adminUser && password === adminPass;
  req.authenticated = isAuthenticated;
  req.authEnabled = authEnabled;

  if (req.path === '/auth-check') return next();

  if (!authEnabled || isAuthenticated) {
    return next();
  }

  // res.set('WWW-Authenticate', 'Basic realm="401"'); // REMOVED to prevent browser popup
  res.status(401).json({ error: 'Authentication required.' });
};

// API Routes
app.use('/api', authMiddleware, apiRoutes);

// Serve Frontend
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDistPath));

app.use((req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
