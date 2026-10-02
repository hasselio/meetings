const crypto = require('crypto');
const db = require('./db');
const Facilities = require('./facilities');

const withFacilities = (row) => row && { ...row, facilities: Facilities.parse(row.facilities) };

const Rooms = {
  all() {
    return db.prepare('SELECT * FROM rooms ORDER BY name COLLATE NOCASE').all().map(withFacilities);
  },
  allWithUpcoming(nowIso) {
    return db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM bookings b
                      WHERE b.room_id = r.id AND b.status = 'confirmed' AND b.end_time > ?) AS upcoming
         FROM rooms r ORDER BY r.name COLLATE NOCASE`
      )
      .all(nowIso)
      .map(withFacilities);
  },
  get(id) {
    return withFacilities(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id));
  },
  create({ name, location, capacity, description, color, facilities }) {
    const info = db
      .prepare(
        'INSERT INTO rooms (name, location, capacity, description, color, facilities) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        name,
        location || null,
        capacity || null,
        description || null,
        color || '#2563eb',
        JSON.stringify(Facilities.normalize(facilities))
      );
    return this.get(info.lastInsertRowid);
  },
  update(id, { name, location, capacity, description, color, facilities }) {
    db.prepare(
      'UPDATE rooms SET name = ?, location = ?, capacity = ?, description = ?, color = ?, facilities = ? WHERE id = ?'
    ).run(
      name,
      location || null,
      capacity || null,
      description || null,
      color || '#2563eb',
      JSON.stringify(Facilities.normalize(facilities)),
      id
    );
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
  upcomingForRoom(roomId, nowIso) {
    return db
      .prepare(`SELECT * FROM bookings WHERE room_id = ? AND status = 'confirmed' AND end_time > ? ORDER BY start_time`)
      .all(roomId, nowIso);
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
  create({ username, passwordHash, name, email }) {
    const info = db
      .prepare('INSERT INTO admin_users (username, password_hash, name, email) VALUES (?, ?, ?, ?)')
      .run(username, passwordHash, name || null, email || null);
    return this.findById(info.lastInsertRowid);
  },
  update(id, { username, name, email }) {
    db.prepare('UPDATE admin_users SET username = ?, name = ?, email = ? WHERE id = ?').run(
      username,
      name || null,
      email || null,
      id
    );
    return this.findById(id);
  },
  // Nytt passord gjør alle eksisterende økter for kontoen ugyldige (session_version økes).
  setPassword(id, passwordHash, { mustChange = false } = {}) {
    db.prepare(
      'UPDATE admin_users SET password_hash = ?, must_change_password = ?, session_version = session_version + 1 WHERE id = ?'
    ).run(passwordHash, mustChange ? 1 : 0, id);
    return this.findById(id);
  },
  usernameTakenByOther(username, exceptId) {
    const row = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM admin_users WHERE lower(username) = lower(?) AND id != ?) +
           (SELECT COUNT(*) FROM admin_requests WHERE status = 'pending' AND lower(username) = lower(?)) AS n`
      )
      .get(username, exceptId, username);
    return row.n > 0;
  },
  all() {
    return db
      .prepare(
        'SELECT id, username, name, email, must_change_password, created_at FROM admin_users ORDER BY username COLLATE NOCASE'
      )
      .all();
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
    AdminUsers.create({
      username: request.username,
      passwordHash: request.password_hash,
      name: request.name,
      email: request.email,
    });
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
