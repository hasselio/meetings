const express = require('express');
const bcrypt = require('bcryptjs');
const { Rooms, Bookings, AdminUsers } = require('../models');
const { sendBookingCancellation } = require('../services/mailer');
const { requireAdmin } = require('../middleware/auth');
const { parseRange } = require('../availability');
const config = require('../config');

const router = express.Router();

// --- Førstegangs oppsett av admin-bruker ---
router.get('/setup', (req, res) => {
  if (AdminUsers.count() > 0) return res.redirect('/admin/login');
  res.render('admin/setup', { error: null });
});

router.post('/setup', (req, res) => {
  if (AdminUsers.count() > 0) return res.redirect('/admin/login');
  const { username, password, passwordConfirm } = req.body;
  if (!username || !password) {
    return res.render('admin/setup', { error: 'Brukernavn og passord er påkrevd' });
  }
  if (password.length < 8) {
    return res.render('admin/setup', { error: 'Passordet må være minst 8 tegn' });
  }
  if (password !== passwordConfirm) {
    return res.render('admin/setup', { error: 'Passordene er ikke like' });
  }
  const passwordHash = bcrypt.hashSync(password, 12);
  const user = AdminUsers.create({ username, passwordHash });
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Kunne ikke opprette sesjon');
    req.session.adminId = user.id;
    res.redirect('/admin');
  });
});

// --- Innlogging ---
router.get('/login', (req, res) => {
  if (AdminUsers.count() === 0) return res.redirect('/admin/setup');
  res.render('admin/login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = AdminUsers.findByUsername(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('admin/login', { error: 'Feil brukernavn eller passord' });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Kunne ikke opprette sesjon');
    req.session.adminId = user.id;
    res.redirect('/admin');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// --- Alt under her krever innlogging ---
router.use(requireAdmin);

const ROOM_COLORS = ['#3f5bd9', '#2f7d6d', '#c2562b', '#a1428a', '#7a6a2c', '#5b6b80', '#c23b53', '#4f7a2f'];

function roomInput(body) {
  const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : ROOM_COLORS[0];
  const capacity = parseInt(body.capacity, 10);
  return {
    name: (body.name || '').trim(),
    location: (body.location || '').trim(),
    description: (body.description || '').trim(),
    capacity: capacity > 0 ? capacity : null,
    color,
  };
}

function renderRoomForm(res, room, error) {
  res.status(error ? 400 : 200).render('admin/room-form', { room, error, colors: ROOM_COLORS });
}

router.get('/', (req, res) => {
  const rooms = Rooms.all();
  const activeRoom = rooms.find((r) => String(r.id) === req.query.rom) || rooms[0] || null;
  res.render('admin/dashboard', { rooms, activeRoom, timezone: config.timezone });
});

// Rom-administrasjon
router.get('/rooms/new', (req, res) => renderRoomForm(res, null, null));

router.post('/rooms', (req, res) => {
  const input = roomInput(req.body);
  if (!input.name) return renderRoomForm(res, input, 'Gi rommet et navn.');
  const room = Rooms.create(input);
  res.redirect(`/admin?rom=${room.id}`);
});

router.get('/rooms/:id/edit', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).render('public/not-found');
  renderRoomForm(res, room, null);
});

router.post('/rooms/:id', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).render('public/not-found');
  const input = roomInput(req.body);
  if (!input.name) return renderRoomForm(res, { ...input, id: room.id }, 'Gi rommet et navn.');
  Rooms.update(room.id, input);
  res.redirect(`/admin?rom=${room.id}`);
});

router.post('/rooms/:id/delete', (req, res) => {
  Rooms.delete(req.params.id);
  res.redirect('/admin');
});

// Bookinger med fulle detaljer (kun admin)
router.get('/api/rooms/:id/events', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Rom ikke funnet' });

  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ error: 'Gyldig start og end er påkrevd' });

  const bookings = Bookings.forRoomBetween(room.id, range.start, range.end);
  const events = bookings.map((b) => ({
    id: b.id,
    start: b.start_time,
    end: b.end_time,
    title: b.title,
    classNames: ['ev-booking'],
    extendedProps: {
      color: room.color,
      roomName: room.name,
      organizerName: b.organizer_name,
      organizerEmail: b.organizer_email,
      notes: b.notes,
    },
  }));
  res.json(events);
});

router.get('/api/bookings/:id', (req, res) => {
  const booking = Bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking ikke funnet' });
  res.json(booking);
});

router.post('/api/bookings/:id/cancel', async (req, res) => {
  const booking = Bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking ikke funnet' });
  const room = Rooms.get(booking.room_id);

  const cancelled = Bookings.cancel(booking.id);

  let mailResult = { sent: false };
  try {
    mailResult = await sendBookingCancellation(booking, room);
    if (mailResult.sent) Bookings.bumpSequence(booking.id);
  } catch (err) {
    console.error('Kunne ikke sende avlysning for booking #%s:', booking.id, err);
  }

  res.json({ booking: cancelled, mailSent: mailResult.sent });
});

module.exports = router;
