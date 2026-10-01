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
};

module.exports = { Rooms, Bookings, AdminUsers };
