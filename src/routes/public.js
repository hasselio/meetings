const express = require('express');
const { Rooms, Bookings, RoomBlocks } = require('../models');
const { currentAdmin } = require('../middleware/auth');
const { createLimiter } = require('../middleware/rate-limit');
const { bookingChallengeHandler, verifyBookingCaptcha } = require('../captcha');
const { roomStatus, formatToday, timelineHours, parseRange } = require('../availability');
const BookingService = require('../services/bookings');
const mailer = require('../services/mailer');
const { bookingFields } = require('../validation');
const { hashToken, isTokenShape } = require('../tokens');
const Rules = require('../rules');
const Facilities = require('../facilities');
const time = require('../time');
const config = require('../config');

const router = express.Router();

const bookingLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 20 });
const MAX_PENDING_PER_EMAIL = 3;

// Innloggede administratorer får en forhåndsvisningslinje; selve innholdet er det samme som for alle andre.
router.use((req, res, next) => {
  res.locals.adminPreview = Boolean(currentAdmin(req));
  next();
});

router.get('/', (req, res) => {
  const now = new Date();
  const rooms = Rooms.all().map((r) => ({
    ...r,
    status: roomStatus(r.id, now),
    facilityList: Facilities.describe(r.facilities),
  }));
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
  res.render('public/room', {
    room,
    facilityList: Facilities.describe(room.facilities),
    rules: Rules.describe(room),
    ruleConfig: Rules.rulesOf(room),
    status: roomStatus(room.id),
    timezone: config.timezone,
    confirmationRequired: config.bookingConfirmation && mailer.canSend(),
    mailEnabled: mailer.canSend(),
    holdMinutes: config.pendingHoldMinutes,
  });
});

router.get('/personvern', (req, res) => {
  res.render('public/privacy', {
    retentionMonths: config.retentionMonths,
    auditRetentionMonths: config.auditRetentionMonths,
    contact: config.privacyContact,
    holdMinutes: config.pendingHoldMinutes,
  });
});

router.get('/api/altcha', bookingChallengeHandler);

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
  // Årsaken til en sperring kan være intern, så besøkende ser bare at rommet ikke er tilgjengelig.
  const blocks = RoomBlocks.overlapping(room.id, range.start, range.end).map((k) => ({
    start: k.start_time,
    end: k.end_time,
    title: 'Ikke tilgjengelig',
    classNames: ['ev-busy', 'ev-blocked'],
  }));
  res.json(events.concat(blocks));
});

router.post('/api/rooms/:id/bookings', verifyBookingCaptcha, async (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Rom ikke funnet' });

  // Skjult felt som bare roboter fyller ut. Svaret ser vellykket ut, men ingenting lagres.
  if (req.body.website) return res.status(201).json({ status: 'pending', mailSent: true });
  if (res.locals.altcha.error) {
    return res.status(400).json({ error: 'Robot-sjekken ble ikke fullført. Vent et øyeblikk og prøv igjen.', code: 'captcha' });
  }
  if (bookingLimiter.isLimited(req.ip)) {
    return res.status(429).json({ error: 'Du har booket mange ganger på kort tid. Prøv igjen om en time.' });
  }

  const { values, error } = bookingFields(req.body);
  if (error) return res.status(400).json({ error });

  const start = new Date(req.body.start);
  const end = new Date(req.body.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return res.status(400).json({ error: 'Velg dato og tidspunkt.' });
  }

  if (BookingService.needsConfirmation({ type: 'visitor' }) && Bookings.countActivePendingForEmail(values.organizerEmail) >= MAX_PENDING_PER_EMAIL) {
    return res.status(429).json({
      error: 'Du har flere bookinger som venter på bekreftelse. Bekreft dem fra e-posten din før du booker mer.',
    });
  }

  const result = await BookingService.create({
    room,
    input: values,
    occurrences: [{ start, end }],
    actor: { type: 'visitor', req },
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });

  bookingLimiter.hit(req.ip);
  res.status(201).json({
    status: result.pending ? 'pending' : 'confirmed',
    mailSent: result.mailSent,
    manageUrl: result.manageUrl,
    holdMinutes: config.pendingHoldMinutes,
  });
});

// --- Lenken i e-posten: bekreft, endre eller avbestill ---
// GET viser bare siden; alle handlinger er POST, så lenkesjekkere i e-postprogrammer ikke utløser dem.

const MESSAGES = {
  bekreftet: 'Bookingen er bekreftet. Kalenderinvitasjonen er på vei til e-posten din.',
  'bekreftet-uten-epost': 'Bookingen er bekreftet.',
  endret: 'Endringen er lagret, og du får en oppdatert kalenderinvitasjon.',
  'endret-uten-epost': 'Endringen er lagret.',
  avbestilt: 'Avbestillingen er registrert. Takk for at du ga beskjed!',
};

function loadByToken(req, res, next) {
  const { token } = req.params;
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  const bookings = isTokenShape(token) ? Bookings.byTokenHash(hashToken(token)) : [];
  if (!bookings.length) return res.status(404).render('public/manage-missing');
  req.bookings = bookings;
  req.token = token;
  next();
}

function renderManage(req, res, { error = null, editId = null, values = null, status = 200 } = {}) {
  const now = new Date();
  const nowIso = now.toISOString();
  const bookings = req.bookings.map((b) => {
    const pendingExpired = b.status === 'pending' && b.expires_at <= nowIso;
    return {
      ...b,
      room: Rooms.get(b.room_id),
      when: time.formatRange(b.start_time, b.end_time),
      date: time.localDateKey(b.start_time),
      from: time.formatTime(b.start_time),
      to: time.formatTime(b.end_time),
      past: b.end_time <= nowIso,
      state: b.status === 'cancelled' ? 'cancelled' : pendingExpired ? 'expired' : b.status,
    };
  });
  const first = bookings[0];
  const upcoming = bookings.filter((b) => !b.past && (b.state === 'confirmed' || b.state === 'pending'));
  res.status(status).render('public/manage', {
    token: req.token,
    bookings,
    first,
    room: first.room,
    isSeries: Boolean(first.series_id),
    upcoming,
    needsConfirm: bookings.some((b) => !b.past && (b.state === 'pending' || b.state === 'expired')),
    message: MESSAGES[req.query.melding] || null,
    error,
    editId,
    values,
  });
}

router.get('/booking/:token', loadByToken, (req, res) => renderManage(req, res));

const visitor = (req) => ({ type: 'visitor', req });

router.post('/booking/:token/bekreft', loadByToken, async (req, res) => {
  const result = await BookingService.confirm(req.bookings, visitor(req));
  if (!result.ok) return renderManage(req, res, { error: result.error, status: result.status });
  res.redirect(303, `/booking/${req.token}?melding=${result.mailSent || result.already ? 'bekreftet' : 'bekreftet-uten-epost'}`);
});

router.post('/booking/:token/endre', loadByToken, async (req, res) => {
  const booking = req.bookings.find((b) => String(b.id) === String(req.body.id));
  const fail = (error, status = 400) => renderManage(req, res, { error, editId: booking && booking.id, values: req.body, status });
  if (!booking || booking.status !== 'confirmed' || new Date(booking.end_time) <= new Date()) {
    return fail('Denne bookingen kan ikke endres lenger.');
  }

  const { values, error } = bookingFields({ ...req.body, organizerName: booking.organizer_name, organizerEmail: booking.organizer_email });
  if (error) return fail(error);
  const start = time.fromLocal(req.body.date, req.body.startTime);
  const end = time.fromLocal(req.body.date, req.body.endTime);
  if (!start || !end) return fail('Velg dato og tidspunkt.');

  const result = await BookingService.update(
    booking,
    { title: values.title, notes: values.notes, start, end },
    { actor: visitor(req) }
  );
  if (!result.ok) return fail(result.error, result.status);
  res.redirect(303, `/booking/${req.token}?melding=${result.mailSent ? 'endret' : 'endret-uten-epost'}`);
});

router.post('/booking/:token/avbestill', loadByToken, async (req, res) => {
  const all = req.body.id === 'alle';
  const targets = all ? req.bookings : req.bookings.filter((b) => String(b.id) === String(req.body.id));
  const result = await BookingService.cancel(targets, { actor: visitor(req), wholeSeries: all });
  if (!result.ok) return renderManage(req, res, { error: result.error, status: result.status });
  res.redirect(303, `/booking/${req.token}?melding=avbestilt`);
});

module.exports = router;
