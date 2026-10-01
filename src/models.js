const crypto = require('crypto');
const db = require('./db');

const Rooms = {
  all() {
    return db.prepare('SELECT * FROM rooms ORDER BY name').all();
  },
  get(id) {
    return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
  },
  create({ name, location, capacity, description, color }) {
    const stmt = db.prepare(
      'INSERT INTO rooms (name, location, capacity, description, color) VALUES (?, ?, ?, ?, ?)'
    );
    const info = stmt.run(name, location || null, capacity || null, description || null, color || '#2563eb');
    return this.get(info.lastInsertRowid);
  },
  update(id, { name, location, capacity, description, color }) {
    db.prepare(
      'UPDATE rooms SET name = ?, location = ?, capacity = ?, description = ?, color = ? WHERE id = ?'
    ).run(name, location || null, capacity || null, description || null, color || '#2563eb', id);
    return this.get(id);
  },
  delete(id) {
    db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  },
};

const Bookings = {
  forRoomBetween(roomId, start, end) {
    return db
      .prepare(
        `SELECT * FROM bookings
         WHERE room_id = ? AND status = 'confirmed'
           AND start_time < ? AND end_time > ?
         ORDER BY start_time`
      )
      .all(roomId, end, start);
  },
  allBetween(start, end) {
    return db
      .prepare(
        `SELECT b.*, r.name AS room_name FROM bookings b
         JOIN rooms r ON r.id = b.room_id
         WHERE b.status = 'confirmed' AND b.start_time < ? AND b.end_time > ?
         ORDER BY b.start_time`
      )
      .all(end, start);
  },
  get(id) {
    return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  },
  hasOverlap(roomId, start, end, excludeId = null) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM bookings
         WHERE room_id = ? AND status = 'confirmed'
           AND start_time < ? AND end_time > ?
           AND id != ?`
      )
      .get(roomId, end, start, excludeId || -1);
    return row.n > 0;
  },
  create({ roomId, title, organizerName, organizerEmail, notes, start, end }) {
    const uid = `booking-${crypto.randomUUID()}@mettings.local`;
    const stmt = db.prepare(
      `INSERT INTO bookings (room_id, title, organizer_name, organizer_email, notes, start_time, end_time, ics_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(roomId, title, organizerName, organizerEmail, notes || null, start, end, uid);
    return this.get(info.lastInsertRowid);
  },
  update(id, { title, organizerName, organizerEmail, notes, start, end }) {
    db.prepare(
      `UPDATE bookings SET title = ?, organizer_name = ?, organizer_email = ?, notes = ?, start_time = ?, end_time = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(title, organizerName, organizerEmail, notes || null, start, end, id);
    return this.get(id);
  },
  cancel(id) {
    db.prepare(`UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(id);
    return this.get(id);
  },
  bumpSequence(id) {
    db.prepare('UPDATE bookings SET ics_sequence = ics_sequence + 1 WHERE id = ?').run(id);
    return this.get(id);
  },
};

const AdminUsers = {
  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
  },
  findByUsername(username) {
    return db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  },
  findById(id) {
    return db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
  },
  create({ username, passwordHash }) {
    const info = db
      .prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)')
      .run(username, passwordHash);
    return db.prepare('SELECT * FROM admin_users WHERE id = ?').get(info.lastInsertRowid);
  },
  setPassword(id, passwordHash) {
    db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  },
  all() {
    return db.prepare('SELECT id, username, created_at FROM admin_users ORDER BY username COLLATE NOCASE').all();
  },
  delete(id) {
    db.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
  },
};

const AdminRequests = {
  create({ name, email, username, passwordHash, reason }) {
    const info = db
      .prepare('INSERT INTO admin_requests (name, email, username, password_hash, reason) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, username, passwordHash, reason || null);
    return this.get(info.lastInsertRowid);
  },
  get(id) {
    return db.prepare('SELECT * FROM admin_requests WHERE id = ?').get(id);
  },
  pending() {
    return db.prepare(`SELECT * FROM admin_requests WHERE status = 'pending' ORDER BY created_at`).all();
  },
  countPending() {
    return db.prepare(`SELECT COUNT(*) AS n FROM admin_requests WHERE status = 'pending'`).get().n;
  },
  recentDecisions(limit = 10) {
    return db
      .prepare(
        `SELECT r.id, r.name, r.email, r.username, r.status, r.decided_at, a.username AS decided_by_username
         FROM admin_requests r LEFT JOIN admin_users a ON a.id = r.decided_by
         WHERE r.status != 'pending' ORDER BY r.decided_at DESC LIMIT ?`
      )
      .all(limit);
  },
  usernameTaken(username) {
    const row = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM admin_users WHERE lower(username) = lower(?)) +
           (SELECT COUNT(*) FROM admin_requests WHERE status = 'pending' AND lower(username) = lower(?)) AS n`
      )
      .get(username, username);
    return row.n > 0;
  },
  // Passord-hashen slettes fra forespørselen når den er behandlet; den trengs bare til å opprette kontoen.
  approve: db.transaction((id, adminId) => {
    const request = AdminRequests.get(id);
    if (!request || request.status !== 'pending') return { error: 'Forespørselen er allerede behandlet.' };
    const clash = db.prepare('SELECT 1 FROM admin_users WHERE lower(username) = lower(?)').get(request.username);
    if (clash) return { error: `Brukernavnet «${request.username}» er allerede i bruk. Avslå og be personen søke på nytt.` };
    AdminUsers.create({ username: request.username, passwordHash: request.password_hash });
    db.prepare(
      `UPDATE admin_requests SET status = 'approved', password_hash = '', decided_at = datetime('now'), decided_by = ? WHERE id = ?`
    ).run(adminId, id);
    return { request };
  }),
  decline: db.transaction((id, adminId) => {
    const request = AdminRequests.get(id);
    if (!request || request.status !== 'pending') return { error: 'Forespørselen er allerede behandlet.' };
    db.prepare(
      `UPDATE admin_requests SET status = 'declined', password_hash = '', decided_at = datetime('now'), decided_by = ? WHERE id = ?`
    ).run(adminId, id);
    return { request };
  }),
};

module.exports = { Rooms, Bookings, AdminUsers, AdminRequests };
