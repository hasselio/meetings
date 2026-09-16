const express = require('express');
const { Rooms, Bookings } = require('../models');
const { sendBookingConfirmation } = require('../services/mailer');
const config = require('../config');

const router = express.Router();

function isRoomFreeNow(roomId) {
  const now = new Date().toISOString();
  return !Bookings.hasOverlap(roomId, now, now);
}

router.get('/', (req, res) => {
  const rooms = Rooms.all().map((r) => ({ ...r, free: isRoomFreeNow(r.id) }));
  res.render('public/home', { rooms, timezone: config.timezone });
});

router.get('/rom/:id', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).render('public/not-found');
  res.render('public/room', { room, timezone: config.timezone });
});

// Offentlig API: kun ledig/opptatt, ingen detaljer om hvem som har booket
router.get('/api/rooms/:id/events', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Rom ikke funnet' });

  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start og end er påkrevd' });

  const bookings = Bookings.forRoomBetween(room.id, start, end);
  const events = bookings.map((b) => ({
    start: b.start_time,
    end: b.end_time,
    title: 'Opptatt',
    display: 'block',
    color: '#94a3b8',
  }));
  res.json(events);
});

router.post('/api/rooms/:id/bookings', async (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Rom ikke funnet' });

  const { title, organizerName, organizerEmail, notes, start, end } = req.body;

  if (!title || !organizerName || !organizerEmail || !start || !end) {
    return res.status(400).json({ error: 'Alle felt (tittel, navn, e-post, start, slutt) er påkrevd' });
  }

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
    return res.status(400).json({ error: 'Ugyldig tidsrom' });
  }
  if (startDate < new Date()) {
    return res.status(400).json({ error: 'Kan ikke booke et tidspunkt som allerede har passert' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(organizerEmail)) {
    return res.status(400).json({ error: 'Ugyldig e-postadresse' });
  }

  const startIso = startDate.toISOString();
  const endIso = endDate.toISOString();

  if (Bookings.hasOverlap(room.id, startIso, endIso)) {
    return res.status(409).json({ error: 'Rommet er allerede booket i dette tidsrommet' });
  }

  const booking = Bookings.create({
    roomId: room.id,
    title,
    organizerName,
    organizerEmail,
    notes,
    start: startIso,
    end: endIso,
  });

  let mailResult = { sent: false };
  try {
    mailResult = await sendBookingConfirmation(booking, room);
  } catch (err) {
    console.error('Kunne ikke sende bekreftelse for booking #%s:', booking.id, err);
  }

  res.status(201).json({ booking, mailSent: mailResult.sent });
});

module.exports = router;
