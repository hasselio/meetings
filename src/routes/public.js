const express = require('express');
const { Rooms, Bookings } = require('../models');
const { sendBookingConfirmation } = require('../services/mailer');
const { roomStatus, formatToday, timelineHours, parseRange } = require('../availability');
const config = require('../config');

const router = express.Router();

router.get('/', (req, res) => {
  const now = new Date();
  const rooms = Rooms.all().map((r) => ({ ...r, status: roomStatus(r.id, now) }));
  res.render('public/home', {
    rooms,
    freeCount: rooms.filter((r) => r.status.free).length,
    today: formatToday(now),
    hours: timelineHours(),
  });
});

router.get('/rom/:id', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).render('public/not-found');
  res.render('public/room', { room, status: roomStatus(room.id), timezone: config.timezone });
});

// Offentlig API: kun ledig/opptatt, ingen detaljer om hvem som har booket
router.get('/api/rooms/:id/events', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Rom ikke funnet' });

  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ error: 'Gyldig start og end er påkrevd' });

  const bookings = Bookings.forRoomBetween(room.id, range.start, range.end);
  const events = bookings.map((b) => ({
    start: b.start_time,
    end: b.end_time,
    title: 'Opptatt',
    classNames: ['ev-busy'],
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
