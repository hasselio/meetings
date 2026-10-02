// Adminkalenderen og API-et for bookinger i den aktive bedriften.
const express = require('express');
const { Rooms, Bookings, RoomBlocks } = require('../../models');
const BookingService = require('../../services/bookings');
const { parseRange } = require('../../availability');
const { requirePermission } = require('../../roles');
const Rules = require('../../rules');
const time = require('../../time');
const Recurrence = require('../../recurrence');
const { bookingFields } = require('../../validation');
const config = require('../../config');

const router = express.Router();
const manageBookings = requirePermission('bookings.manage');

router.get('/', (req, res) => {
  const rooms = Rooms.all(req.org.id);
  const activeRoom = rooms.find((r) => String(r.id) === req.query.rom) || rooms[0] || null;
  res.render('admin/dashboard', {
    rooms,
    activeRoom,
    timezone: config.timezone,
    ruleConfig: activeRoom ? Rules.rulesOf(activeRoom) : null,
    repeatPatterns: Recurrence.PATTERNS,
    maxOccurrences: Recurrence.MAX_OCCURRENCES,
  });
});

// Bookinger med fulle detaljer, bare for rom i egen bedrift.
router.get('/api/rooms/:id/events', (req, res) => {
  const room = Rooms.getInOrg(req.params.id, req.org.id);
  if (!room) return res.status(404).json({ error: 'Rom ikke funnet' });

  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ error: 'Gyldig start og end er påkrevd' });

  const bookings = Bookings.forRoomBetween(room.id, range.start, range.end);
  const nowIso = new Date().toISOString();
  const events = bookings.map((b) => ({
    id: b.id,
    editable: b.end_time > nowIso,
    start: b.start_time,
    end: b.end_time,
    title: b.title,
    classNames: b.status === 'pending' ? ['ev-booking', 'ev-pending'] : ['ev-booking'],
    extendedProps: {
      status: b.status,
      seriesId: b.series_id,
      seriesLabel: Recurrence.describe(b.series_rule),
      createdByAdmin: Boolean(b.created_by_admin_id),
      roomId: room.id,
      color: room.color,
      roomName: room.name,
      organizerName: b.organizer_name,
      organizerEmail: b.organizer_email,
      notes: b.notes,
    },
  }));
  const blocks = RoomBlocks.overlapping(room.id, range.start, range.end).map((k) => ({
    id: `sperring-${k.id}`,
    start: k.start_time,
    end: k.end_time,
    title: k.reason ? `Sperret: ${k.reason}` : 'Sperret',
    classNames: ['ev-blocked'],
    editable: false,
    extendedProps: { blocked: true },
  }));
  res.json(events.concat(blocks));
});

router.get('/api/bookings/:id', (req, res) => {
  const booking = Bookings.getInOrg(req.params.id, req.org.id);
  if (!booking) return res.status(404).json({ error: 'Booking ikke funnet' });
  res.json(booking);
});

// Booke på vegne av andre. Romreglene gjelder ikke, men tiden må være ledig og ikke sperret.
router.post('/api/rooms/:id/bookings', manageBookings, async (req, res) => {
  const room = Rooms.getInOrg(req.params.id, req.org.id);
  if (!room) return res.status(404).json({ error: 'Rom ikke funnet' });
  const { values, error } = bookingFields(req.body);
  if (error) return res.status(400).json({ error });
  const start = new Date(req.body.start);
  const end = new Date(req.body.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return res.status(400).json({ error: 'Velg dato og tidspunkt.' });

  let occurrences = [{ start, end }];
  let series = null;
  if (req.body.repeat && req.body.repeat !== 'none') {
    const expanded = Recurrence.expand({ start, end, pattern: req.body.repeat, until: req.body.repeatUntil });
    if (expanded.error) return res.status(400).json({ error: expanded.error });
    occurrences = expanded.occurrences;
    series = { rule: expanded.rule, skipConflicts: Boolean(req.body.skipConflicts) };
  }

  const result = await BookingService.create({
    room,
    input: values,
    occurrences,
    series,
    actor: { type: 'admin', req },
    bypassRules: true,
    notify: req.body.notify !== false,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
  res.status(201).json({
    count: result.bookings.length,
    skipped: result.skipped.map((o) => ({ when: time.formatRange(o.start, o.end), reason: o.reason })),
    mailSent: result.mailSent,
    start: result.bookings[0].start_time,
  });
});

// Endre tid, rom eller detaljer. Et møte kan bare flyttes til et annet rom i samme bedrift.
router.patch('/api/bookings/:id', manageBookings, async (req, res) => {
  const booking = Bookings.getInOrg(req.params.id, req.org.id);
  if (!booking || booking.status === 'cancelled') return res.status(404).json({ error: 'Booking ikke funnet' });
  if (new Date(booking.end_time) <= new Date()) return res.status(400).json({ error: 'Møter som er over, kan ikke endres.' });

  const { values, error } = bookingFields({
    title: req.body.title ?? booking.title,
    organizerName: req.body.organizerName ?? booking.organizer_name,
    organizerEmail: req.body.organizerEmail ?? booking.organizer_email,
    notes: req.body.notes ?? booking.notes,
  });
  if (error) return res.status(400).json({ error });
  const changes = { ...values };
  if (req.body.roomId) {
    const target = Rooms.getInOrg(req.body.roomId, req.org.id);
    if (!target) return res.status(404).json({ error: 'Rom ikke funnet' });
    changes.roomId = target.id;
  }
  if (req.body.start) changes.start = new Date(req.body.start);
  if (req.body.end) changes.end = new Date(req.body.end);
  if ([changes.start, changes.end].some((d) => d && Number.isNaN(d.getTime()))) {
    return res.status(400).json({ error: 'Velg dato og tidspunkt.' });
  }

  const result = await BookingService.update(booking, changes, {
    actor: { type: 'admin', req },
    bypassRules: true,
    notify: req.body.notify !== false,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
  res.json({ booking: result.booking, mailSent: result.mailSent });
});

router.post('/api/bookings/:id/cancel', manageBookings, async (req, res) => {
  const booking = Bookings.getInOrg(req.params.id, req.org.id);
  if (!booking) return res.status(404).json({ error: 'Booking ikke funnet' });
  const scope = req.body && req.body.scope === 'series' && booking.series_id ? 'series' : 'one';
  const targets = scope === 'series' ? Bookings.bySeriesInOrg(booking.series_id, req.org.id) : [booking];
  const result = await BookingService.cancel(targets, {
    actor: { type: 'admin', req },
    wholeSeries: scope === 'series',
    reason: (req.body && String(req.body.reason || '').trim().slice(0, 300)) || null,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ cancelled: result.cancelled.length, mailSent: result.mailSent });
});

module.exports = router;
