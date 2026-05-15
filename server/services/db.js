const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'app.db');
const db = new Database(dbPath);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, -- 'radarr' or 'sonarr'
    name TEXT NOT NULL,
    url_internal TEXT NOT NULL,
    url_external TEXT NOT NULL,
    api_key TEXT NOT NULL
  );
`);

// Helper functions for settings
const getSetting = (key, defaultValue = null) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : defaultValue;
};

const setSetting = (key, value) => {
  db.prepare(`
    INSERT INTO settings (key, value) 
    VALUES (?, ?) 
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
};

// Helper functions for instances
const getInstances = (type = null) => {
  if (type) {
    return db.prepare('SELECT * FROM instances WHERE type = ?').all(type);
  }
  return db.prepare('SELECT * FROM instances').all();
};

const addInstance = (instance) => {
  const info = db.prepare(`
    INSERT INTO instances (type, name, url_internal, url_external, api_key)
    VALUES (@type, @name, @url_internal, @url_external, @api_key)
  `).run(instance);
  return info.lastInsertRowid;
};

const updateInstance = (id, instance) => {
  db.prepare(`
    UPDATE instances 
    SET type = @type, name = @name, url_internal = @url_internal, url_external = @url_external, api_key = @api_key
    WHERE id = @id
  `).run({ ...instance, id });
};

const deleteInstance = (id) => {
  db.prepare('DELETE FROM instances WHERE id = ?').run(id);
};

module.exports = {
  db,
  getSetting,
  setSetting,
  getInstances,
  addInstance,
  updateInstance,
  deleteInstance
};
