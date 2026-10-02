const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// DB_PATH lar testene bruke en egen database (f.eks. ':memory:').
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mettings.db');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    location TEXT,
    capacity INTEGER,
    description TEXT,
    color TEXT DEFAULT '#2563eb',
    facilities TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    organizer_name TEXT NOT NULL,
    organizer_email TEXT NOT NULL,
    notes TEXT,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    ics_uid TEXT NOT NULL,
    ics_sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_room_time ON bookings(room_id, start_time, end_time);

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT,
    decided_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_admin_requests_status ON admin_requests(status, created_at);

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    actor_type TEXT NOT NULL,
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    summary TEXT NOT NULL,
    ip TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

  CREATE TABLE IF NOT EXISTS room_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    reason TEXT,
    created_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_room_blocks ON room_blocks(room_id, start_time, end_time);
`);

// Eldre databaser får nye kolonner lagt til ved oppstart.
function addMissingColumns(table, columns) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

addMissingColumns('rooms', {
  facilities: `TEXT NOT NULL DEFAULT '[]'`,
  // Regler for booking. Tider er lokal tid (HH:MM), dager er 0 = søndag … 6 = lørdag.
  open_from: `TEXT NOT NULL DEFAULT '07:00'`,
  open_to: `TEXT NOT NULL DEFAULT '20:00'`,
  open_days: `TEXT NOT NULL DEFAULT '1,2,3,4,5,6,0'`,
  max_duration_minutes: 'INTEGER',
  max_days_ahead: 'INTEGER',
  buffer_minutes: 'INTEGER NOT NULL DEFAULT 0',
});

addMissingColumns('admin_users', {
  name: 'TEXT',
  email: 'TEXT',
  must_change_password: 'INTEGER NOT NULL DEFAULT 0',
  // Økes ved passordbytte og tilbakestilling, slik at alle eksisterende økter for kontoen blir ugyldige.
  session_version: 'INTEGER NOT NULL DEFAULT 0',
  role: `TEXT NOT NULL DEFAULT 'admin'`,
});

addMissingColumns('admin_requests', { role: `TEXT NOT NULL DEFAULT 'viewer'` });

addMissingColumns('bookings', {
  // Hash av lenken i e-posten; selve lenken lagres aldri.
  manage_token_hash: 'TEXT',
  // Ubekreftede bookinger holder av tiden til dette tidspunktet.
  expires_at: 'TEXT',
  confirmed_at: 'TEXT',
  reminder_sent_at: 'TEXT',
  series_id: 'TEXT',
  series_rule: 'TEXT',
  // Opprinnelig start for en forekomst i en serie (RECURRENCE-ID i kalenderinvitasjonen).
  occurrence_start: 'TEXT',
  created_by_admin_id: 'INTEGER',
  anonymized_at: 'TEXT',
});

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_bookings_token ON bookings(manage_token_hash);
  CREATE INDEX IF NOT EXISTS idx_bookings_series ON bookings(series_id);
`);

module.exports = db;
