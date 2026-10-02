const crypto = require('crypto');
const db = require('./db');
const Facilities = require('./facilities');
const { manageToken, hashToken } = require('./tokens');

// En booking holder av tiden når den er bekreftet, eller ubekreftet men ikke utløpt ennå.
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const ACTIVE = `(status = 'confirmed' OR (status = 'pending' AND expires_at > ${NOW}))`;
const ACTIVE_B = ACTIVE.replace(/status|expires_at/g, (c) => `b.${c}`);

const withFacilities = (row) => row && { ...row, facilities: Facilities.parse(row.facilities) };

// Regler som ikke er oppgitt, får standardverdiene fra databasen.
const roomParams = (r) => ({
  name: r.name,
  location: r.location || null,
  capacity: r.capacity || null,
  description: r.description || null,
  color: r.color || '#2563eb',
  facilities: JSON.stringify(Facilities.normalize(r.facilities)),
  open_from: r.open_from || '07:00',
  open_to: r.open_to || '20:00',
  open_days: r.open_days ?? '1,2,3,4,5,6,0',
  max_duration_minutes: r.max_duration_minutes || null,
  max_days_ahead: r.max_days_ahead || null,
  buffer_minutes: r.buffer_minutes || 0,
});

const Rooms = {
  all() {
    return db.prepare('SELECT * FROM rooms ORDER BY name COLLATE NOCASE').all().map(withFacilities);
  },
  allWithUpcoming(nowIso) {
    return db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM bookings b
                      WHERE b.room_id = r.id AND ${ACTIVE_B} AND b.end_time > ?) AS upcoming
         FROM rooms r ORDER BY r.name COLLATE NOCASE`
      )
      .all(nowIso)
      .map(withFacilities);
  },
  get(id) {
    return withFacilities(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id));
  },
  create(input) {
    const info = db
      .prepare(
        `INSERT INTO rooms (name, location, capacity, description, color, facilities,
           open_from, open_to, open_days, max_duration_minutes, max_days_ahead, buffer_minutes)
         VALUES (@name, @location, @capacity, @description, @color, @facilities,
           @open_from, @open_to, @open_days, @max_duration_minutes, @max_days_ahead, @buffer_minutes)`
      )
      .run(roomParams(input));
    return this.get(info.lastInsertRowid);
  },
  update(id, input) {
    db.prepare(
      `UPDATE rooms SET name = @name, location = @location, capacity = @capacity, description = @description,
         color = @color, facilities = @facilities, open_from = @open_from, open_to = @open_to, open_days = @open_days,
         max_duration_minutes = @max_duration_minutes, max_days_ahead = @max_days_ahead, buffer_minutes = @buffer_minutes
       WHERE id = @id`
    ).run({ ...roomParams({ ...this.get(id), ...input }), id });
    return this.get(id);
  },
  delete(id) {
    db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  },
};

const Bookings = {
  ACTIVE,
  forRoomBetween(roomId, start, end) {
    return db
      .prepare(
        `SELECT * FROM bookings
         WHERE room_id = ? AND ${ACTIVE}
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
         WHERE ${ACTIVE_B} AND b.start_time < ? AND b.end_time > ?
         ORDER BY b.start_time`
      )
      .all(end, start);
  },
  get(id) {
    return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  },
  // Alle bookinger som hører til samme lenke (én booking eller en hel serie).
  byTokenHash(hash) {
    return db.prepare('SELECT * FROM bookings WHERE manage_token_hash = ? ORDER BY start_time').all(hash);
  },
  bySeries(seriesId) {
    return db.prepare('SELECT * FROM bookings WHERE series_id = ? ORDER BY start_time').all(seriesId);
  },
  upcomingForRoom(roomId, nowIso) {
    return db
      .prepare(`SELECT * FROM bookings WHERE room_id = ? AND ${ACTIVE} AND end_time > ? ORDER BY start_time`)
      .all(roomId, nowIso);
  },
  overlapping(roomId, start, end, excludeIds = []) {
    const exclude = excludeIds.length ? `AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
    return db
      .prepare(
        `SELECT * FROM bookings
         WHERE room_id = ? AND ${ACTIVE}
           AND start_time < ? AND end_time > ? ${exclude}
         ORDER BY start_time`
      )
      .all(roomId, end, start, ...excludeIds);
  },
  hasOverlap(roomId, start, end, excludeId = null) {
    return this.overlapping(roomId, start, end, excludeId ? [excludeId] : []).length > 0;
  },
  create({
    roomId,
    title,
    organizerName,
    organizerEmail,
    notes,
    start,
    end,
    status = 'confirmed',
    expiresAt = null,
    seriesId = null,
    seriesRule = null,
    occurrenceStart = null,
    createdByAdminId = null,
  }) {
    const uid = `booking-${crypto.randomUUID()}@moterom`;
    const tokenHash = hashToken(manageToken({ series_id: seriesId, ics_uid: uid }));
    const info = db
      .prepare(
        `INSERT INTO bookings (room_id, title, organizer_name, organizer_email, notes, start_time, end_time, ics_uid,
           status, expires_at, confirmed_at, manage_token_hash, series_id, series_rule, occurrence_start, created_by_admin_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        roomId,
        title,
        organizerName,
        organizerEmail,
        notes || null,
        start,
        end,
        uid,
        status,
        expiresAt,
        status === 'confirmed' ? new Date().toISOString() : null,
        tokenHash,
        seriesId,
        seriesRule ? JSON.stringify(seriesRule) : null,
        occurrenceStart,
        createdByAdminId
      );
    return this.get(info.lastInsertRowid);
  },
  confirm(id) {
    db.prepare(
      `UPDATE bookings SET status = 'confirmed', confirmed_at = ${NOW}, expires_at = NULL, updated_at = datetime('now')
       WHERE id = ? AND status = 'pending'`
    ).run(id);
    return this.get(id);
  },
  // Endringer i tid, tittel eller rom gir nytt sekvensnummer, så kalenderen oppdaterer avtalen.
  update(id, { roomId, title, organizerName, organizerEmail, notes, start, end }) {
    const current = this.get(id);
    db.prepare(
      `UPDATE bookings SET room_id = ?, title = ?, organizer_name = ?, organizer_email = ?, notes = ?, start_time = ?, end_time = ?,
         ics_sequence = ics_sequence + 1, reminder_sent_at = CASE WHEN start_time = ? THEN reminder_sent_at ELSE NULL END,
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      roomId ?? current.room_id,
      title ?? current.title,
      organizerName ?? current.organizer_name,
      organizerEmail ?? current.organizer_email,
      notes === undefined ? current.notes : notes || null,
      start ?? current.start_time,
      end ?? current.end_time,
      start ?? current.start_time,
      id
    );
    return this.get(id);
  },
  cancel(id) {
    db.prepare(
      `UPDATE bookings SET status = 'cancelled', ics_sequence = ics_sequence + 1, updated_at = datetime('now') WHERE id = ?`
    ).run(id);
    return this.get(id);
  },
  countActivePendingForEmail(email) {
    return db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(series_id, ics_uid)) AS n FROM bookings
         WHERE lower(organizer_email) = lower(?) AND status = 'pending' AND expires_at > ${NOW}`
      )
      .get(email).n;
  },
  // Bekreftede møter som starter innen et døgn, og som ble booket i god tid før.
  dueReminders(nowIso, untilIso) {
    return db
      .prepare(
        `SELECT * FROM bookings
         WHERE status = 'confirmed' AND reminder_sent_at IS NULL AND anonymized_at IS NULL
           AND start_time > ? AND start_time <= ?
           AND COALESCE(confirmed_at, created_at) <= datetime(start_time, '-12 hours')
         ORDER BY start_time`
      )
      .all(nowIso, untilIso);
  },
  markReminded(id) {
    db.prepare(`UPDATE bookings SET reminder_sent_at = ${NOW} WHERE id = ?`).run(id);
  },
  deleteExpiredPending(beforeIso) {
    return db.prepare(`DELETE FROM bookings WHERE status = 'pending' AND expires_at < ?`).run(beforeIso).changes;
  },
  // Fjerner personopplysninger, men beholder rom og tidspunkt for statistikk.
  anonymize(where, ...params) {
    return db
      .prepare(
        `UPDATE bookings SET title = 'Booking', organizer_name = 'Anonymisert', organizer_email = '', notes = NULL,
           manage_token_hash = NULL, anonymized_at = ${NOW}
         WHERE anonymized_at IS NULL AND ${where}`
      )
      .run(...params).changes;
  },
  anonymizeEndedBefore(iso) {
    return this.anonymize('end_time < ?', iso);
  },
  findByEmail(email) {
    return db
      .prepare(
        `SELECT b.*, r.name AS room_name FROM bookings b JOIN rooms r ON r.id = b.room_id
         WHERE lower(b.organizer_email) = lower(?) ORDER BY b.start_time DESC`
      )
      .all(email);
  },
  anonymizeByEmail(email) {
    return this.anonymize('lower(organizer_email) = lower(?)', email);
  },
};

const RoomBlocks = {
  get(id) {
    return db.prepare('SELECT * FROM room_blocks WHERE id = ?').get(id);
  },
  overlapping(roomId, start, end) {
    return db
      .prepare('SELECT * FROM room_blocks WHERE room_id = ? AND start_time < ? AND end_time > ? ORDER BY start_time')
      .all(roomId, end, start);
  },
  upcoming(nowIso) {
    return db
      .prepare(
        `SELECT k.*, r.name AS room_name, a.username AS created_by_username FROM room_blocks k
         JOIN rooms r ON r.id = k.room_id LEFT JOIN admin_users a ON a.id = k.created_by
         WHERE k.end_time > ? ORDER BY k.start_time`
      )
      .all(nowIso);
  },
  create({ roomId, start, end, reason, createdBy }) {
    const info = db
      .prepare('INSERT INTO room_blocks (room_id, start_time, end_time, reason, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(roomId, start, end, reason || null, createdBy || null);
    return this.get(info.lastInsertRowid);
  },
  delete(id) {
    db.prepare('DELETE FROM room_blocks WHERE id = ?').run(id);
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
  create({ username, passwordHash, name, email, role = 'admin' }) {
    const info = db
      .prepare('INSERT INTO admin_users (username, password_hash, name, email, role) VALUES (?, ?, ?, ?, ?)')
      .run(username, passwordHash, name || null, email || null, role);
    return this.findById(info.lastInsertRowid);
  },
  setRole(id, role) {
    db.prepare('UPDATE admin_users SET role = ? WHERE id = ?').run(role, id);
    return this.findById(id);
  },
  countWithRole(role) {
    return db.prepare('SELECT COUNT(*) AS n FROM admin_users WHERE role = ?').get(role).n;
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
        'SELECT id, username, name, email, role, must_change_password, created_at FROM admin_users ORDER BY username COLLATE NOCASE'
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
  approve: db.transaction((id, adminId, role = 'viewer') => {
    const request = AdminRequests.get(id);
    if (!request || request.status !== 'pending') return { error: 'Forespørselen er allerede behandlet.' };
    const clash = db.prepare('SELECT 1 FROM admin_users WHERE lower(username) = lower(?)').get(request.username);
    if (clash) return { error: `Brukernavnet «${request.username}» er allerede i bruk. Avslå og be personen søke på nytt.` };
    AdminUsers.create({
      username: request.username,
      passwordHash: request.password_hash,
      name: request.name,
      email: request.email,
      role,
    });
    db.prepare(
      `UPDATE admin_requests SET status = 'approved', role = ?, password_hash = '', decided_at = datetime('now'), decided_by = ? WHERE id = ?`
    ).run(role, adminId, id);
    return { request: { ...request, role } };
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

// Bookinger fra før lenkene i e-posten fantes, får lenke ved oppstart, så påminnelser og
// oppdateringer til dem også kan inneholde en lenke som virker.
for (const b of db.prepare('SELECT id, ics_uid, series_id FROM bookings WHERE manage_token_hash IS NULL AND anonymized_at IS NULL').all()) {
  db.prepare('UPDATE bookings SET manage_token_hash = ? WHERE id = ?').run(hashToken(manageToken(b)), b.id);
}

module.exports = { Rooms, Bookings, RoomBlocks, AdminUsers, AdminRequests };
