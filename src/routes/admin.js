const express = require('express');
const bcrypt = require('bcryptjs');
const { Rooms, Bookings, AdminUsers } = require('../models');
const { sendBookingCancellation } = require('../services/mailer');
const { requireAdmin } = require('../middleware/auth');
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

router.get('/', (req, res) => {
  const rooms = Rooms.all();
  // Hindrer at </script> i rom-felt (navn, beskrivelse osv.) bryter ut av det
  // innebygde script-elementet i dashboard.ejs.
  const roomsJson = JSON.stringify(rooms).replace(/</g, '\\u003c');
  res.render('admin/dashboard', { rooms, roomsJson, timezone: config.timezone });
});

// Rom-administrasjon
router.get('/rooms/new', (req, res) => {
  res.render('admin/room-form', { room: null, error: null });
});

router.post('/rooms', (req, res) => {
  const { name, location, capacity, description, color } = req.body;
  if (!name) return res.render('admin/room-form', { room: req.body, error: 'Navn er påkrevd' });
  Rooms.create({ name, location, capacity: capacity ? parseInt(capacity, 10) : null, description, color });
  res.redirect('/admin');
});

router.get('/rooms/:id/edit', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).send('Rom ikke funnet');
  res.render('admin/room-form', { room, error: null });
});

router.post('/rooms/:id', (req, res) => {
  const { name, location, capacity, description, color } = req.body;
  if (!name) return res.render('admin/room-form', { room: { ...req.body, id: req.params.id }, error: 'Navn er påkrevd' });
  Rooms.update(req.params.id, { name, location, capacity: capacity ? parseInt(capacity, 10) : null, description, color });
  res.redirect('/admin');
});

router.post('/rooms/:id/delete', (req, res) => {
  Rooms.delete(req.params.id);
  res.redirect('/admin');
});

// Bookinger med fulle detaljer (kun admin)
router.get('/api/rooms/:id/events', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Rom ikke funnet' });

  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start og end er påkrevd' });

  const bookings = Bookings.forRoomBetween(room.id, start, end);
  const events = bookings.map((b) => ({
    id: b.id,
    start: b.start_time,
    end: b.end_time,
    title: `${b.title} — ${b.organizer_name}`,
    color: room.color || '#2563eb',
    extendedProps: {
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
