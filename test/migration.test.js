// Oppgradering fra versjonen uten bedrifter: alt flyttes inn i en første bedrift, og dagens
// administratorer blir plattformadministratorer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'moterom-')), 'gammel.db');
const old = new Database(file);
old.exec(`
  CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location TEXT, capacity INTEGER,
    description TEXT, color TEXT DEFAULT '#2563eb', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    title TEXT NOT NULL, organizer_name TEXT NOT NULL, organizer_email TEXT NOT NULL, notes TEXT, start_time TEXT NOT NULL,
    end_time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', ics_uid TEXT NOT NULL, ics_sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE admin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO rooms (name) VALUES ('Gammelt rom');
  INSERT INTO admin_users (username, password_hash, role) VALUES ('sjefen', 'x', 'admin'), ('leseren', 'x', 'viewer');
  INSERT INTO bookings (room_id, title, organizer_name, organizer_email, start_time, end_time, ics_uid)
    VALUES (1, 'Gammel booking', 'A', 'a@example.com', '2030-01-01T09:00:00.000Z', '2030-01-01T10:00:00.000Z', 'booking-abc@mettings.local');
`);
old.close();

process.env.TEST_DB_PATH = file;
process.env.FIRST_ORG_NAME = 'Hassel AS';
const { db, models } = require('./helpers');

test('eksisterende data flyttes inn i første bedrift', () => {
  const [org] = models.Organizations.all();
  assert.equal(org.name, 'Hassel AS');
  assert.equal(org.slug, 'hassel-as');
  assert.equal(models.Rooms.get(1).organization_id, org.id);

  const sjefen = models.AdminUsers.findByUsername('sjefen');
  const leseren = models.AdminUsers.findByUsername('leseren');
  assert.equal(sjefen.is_platform_admin, 1);
  assert.equal(leseren.is_platform_admin, 0);
  assert.equal(models.Memberships.get(sjefen.id, org.id).role, 'admin');
  assert.equal(models.Memberships.get(leseren.id, org.id).role, 'viewer');
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.ok(models.Bookings.get(1).manage_token_hash);
});

test('migreringen kjøres bare én gang', () => {
  delete require.cache[require.resolve('../src/db')];
  require('../src/db');
  assert.equal(models.Organizations.all().length, 1);
});
