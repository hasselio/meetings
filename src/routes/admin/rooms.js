// Rom og sperrede perioder i den aktive bedriften.
const express = require('express');
const { Rooms, Bookings, RoomBlocks } = require('../../models');
const { sendCancellation } = require('../../services/mailer');
const BookingService = require('../../services/bookings');
const { requirePermission } = require('../../roles');
const audit = require('../../audit');
const Facilities = require('../../facilities');
const Rules = require('../../rules');
const time = require('../../time');
const { notFound, flash } = require('./helpers');

const router = express.Router();
const manageRooms = requirePermission('rooms.manage');

const ROOM_COLORS = ['#3f5bd9', '#2f7d6d', '#c2562b', '#a1428a', '#7a6a2c', '#5b6b80', '#c23b53', '#4f7a2f'];

function roomInput(body) {
  const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : ROOM_COLORS[0];
  const capacity = parseInt(body.capacity, 10);
  const rules = Rules.fromForm(body);
  return {
    input: {
      name: (body.name || '').trim().slice(0, 80),
      location: (body.location || '').trim().slice(0, 80),
      description: (body.description || '').trim().slice(0, 400),
      capacity: capacity > 0 ? Math.min(capacity, 500) : null,
      color,
      facilities: Facilities.normalize(body.facilities),
      ...rules.values,
    },
    error: !(body.name || '').trim() ? 'Gi rommet et navn.' : rules.error,
  };
}

function renderRoomForm(res, room, error) {
  res.status(error ? 400 : 200).render('admin/room-form', {
    room,
    error,
    colors: ROOM_COLORS,
    facilityOptions: Facilities.FACILITIES,
    rules: Rules.rulesOf(room || {}),
    durationOptions: Rules.DURATION_OPTIONS,
    bufferOptions: Rules.BUFFER_OPTIONS,
    dayNames: Rules.DAY_NAMES,
    weekOrder: Rules.WEEK_ORDER,
    formatDuration: Rules.formatDuration,
  });
}

router.get('/rom', (req, res) => {
  const rooms = Rooms.allWithUpcoming(new Date().toISOString(), req.org.id).map((r) => ({
    ...r,
    facilityList: Facilities.describe(r.facilities),
    rules: Rules.describe(r),
  }));
  res.render('admin/rooms', { rooms });
});

router.get('/rom/ny', manageRooms, (req, res) => {
  const used = new Set(Rooms.all(req.org.id).map((r) => r.color));
  const color = ROOM_COLORS.find((c) => !used.has(c)) || ROOM_COLORS[0];
  renderRoomForm(res, { color }, null);
});

router.post('/rom', manageRooms, (req, res) => {
  const { input, error } = roomInput(req.body);
  if (error) return renderRoomForm(res, input, error);
  // Nye rom havner alltid i den aktive bedriften, uansett hva skjemaet sender.
  const room = Rooms.create({ ...input, organization_id: req.org.id });
  audit.byAdmin(req, 'room.created', `La til rommet «${room.name}»`, { type: 'room', id: room.id });
  flash(req, 'success', `«${room.name}» er lagt til og kan bookes.`);
  res.redirect('/admin/rom');
});

router.get('/rom/:id/rediger', manageRooms, (req, res) => {
  const room = Rooms.getInOrg(req.params.id, req.org.id);
  if (!room) return notFound(res);
  renderRoomForm(res, room, null);
});

router.post('/rom/:id', manageRooms, (req, res) => {
  const room = Rooms.getInOrg(req.params.id, req.org.id);
  if (!room) return notFound(res);
  const { input, error } = roomInput(req.body);
  if (error) return renderRoomForm(res, { ...input, id: room.id }, error);
  Rooms.update(room.id, input);
  audit.byAdmin(req, 'room.updated', `Endret rommet «${input.name}»`, { type: 'room', id: room.id });
  flash(req, 'success', `Endringene i «${input.name}» er lagret.`);
  res.redirect('/admin/rom');
});

router.post('/rom/:id/slett', manageRooms, async (req, res) => {
  const room = Rooms.getInOrg(req.params.id, req.org.id);
  if (!room) return notFound(res);

  // Bookingene slettes sammen med rommet, så de som har booket må få avlysning først.
  const upcoming = Bookings.upcomingForRoom(room.id, new Date().toISOString());
  Rooms.delete(room.id);
  audit.byAdmin(
    req,
    'room.deleted',
    `Slettet rommet «${room.name}»${upcoming.length ? ` og avlyste ${upcoming.length} kommende booking(er)` : ''}`,
    { type: 'room', id: room.id }
  );

  // Bare bekreftede bookinger har fått en invitasjon som må avlyses.
  const confirmed = upcoming.filter((b) => b.status === 'confirmed').map((b) => ({ ...b, ics_sequence: b.ics_sequence + 1 }));
  const results = await Promise.allSettled(
    confirmed.map((b) => sendCancellation([b], room, { wholeSeries: false, reason: 'Rommet er tatt ut av bruk.' }))
  );
  const notified = results.filter((r) => r.status === 'fulfilled' && r.value.sent).length + (upcoming.length - confirmed.length);

  let text = `«${room.name}» er slettet.`;
  if (upcoming.length) {
    text +=
      notified === upcoming.length
        ? ` ${upcoming.length} kommende booking(er) er avlyst, og de som booket har fått beskjed.`
        : ` ${upcoming.length} kommende booking(er) er avlyst, men ${upcoming.length - notified} fikk ikke e-post. Gi beskjed manuelt.`;
  }
  flash(req, 'success', text);
  res.redirect('/admin/rom');
});

// --- Sperrede perioder (oppussing, arrangementer o.l.) ---

// «mandag 6. april 08:00 – fredag 10. april 16:00», eller kortere når det er samme dag.
function blockRange(start, end) {
  const sameDay = time.localDateKey(start) === time.localDateKey(new Date(new Date(end).getTime() - 1));
  return sameDay
    ? time.formatRange(start, end)
    : `${time.formatDay(start)} ${time.formatTime(start)} – ${time.formatDay(end)} ${time.formatTime(end)}`;
}

function renderBlocks(req, res, { values = {}, error = null, conflicts = null, status = 200 } = {}) {
  const blocks = RoomBlocks.upcoming(new Date().toISOString(), req.org.id).map((b) => ({
    ...b,
    when: blockRange(b.start_time, b.end_time),
  }));
  res.status(status).render('admin/blocks', { blocks, rooms: Rooms.all(req.org.id), values, error, conflicts });
}

const parseLocalDateTime = (value) => {
  const [date, clock] = String(value || '').split('T');
  return time.fromLocal(date, (clock || '').slice(0, 5));
};

router.get('/sperringer', (req, res) => renderBlocks(req, res));

router.post('/sperringer', manageRooms, async (req, res) => {
  const values = {
    room: req.body.room,
    start: req.body.start,
    end: req.body.end,
    reason: String(req.body.reason || '').trim().slice(0, 120),
    cancelConflicts: Boolean(req.body.cancelConflicts),
  };
  const fail = (error, conflicts = null) => renderBlocks(req, res, { values, error, conflicts, status: 400 });

  // «Alle rom» betyr alle rommene i denne bedriften.
  const rooms = values.room === 'alle' ? Rooms.all(req.org.id) : [Rooms.getInOrg(values.room, req.org.id)].filter(Boolean);
  if (!rooms.length) return fail('Velg rom.');
  const start = parseLocalDateTime(values.start);
  const end = parseLocalDateTime(values.end);
  if (!start || !end) return fail('Velg når sperringen starter og slutter.');
  if (end <= start) return fail('Sperringen må slutte etter at den starter.');
  if (end <= new Date()) return fail('Perioden har allerede passert.');

  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const conflicts = rooms.flatMap((room) =>
    Bookings.overlapping(room.id, startIso, endIso).map((b) => ({
      ...b,
      room_name: room.name,
      when: time.formatRange(b.start_time, b.end_time),
    }))
  );
  if (conflicts.length && !values.cancelConflicts) {
    return fail(
      `${conflicts.length} booking(er) ligger i perioden. Kryss av for å avlyse dem, eller velg en annen periode.`,
      conflicts
    );
  }

  for (const room of rooms) {
    const block = RoomBlocks.create({ roomId: room.id, start: startIso, end: endIso, reason: values.reason, createdBy: req.admin.id });
    audit.byAdmin(
      req,
      'room.blocked',
      `Sperret ${room.name} ${blockRange(startIso, endIso)}${values.reason ? ` (${values.reason})` : ''}`,
      { type: 'block', id: block.id }
    );
  }

  let notified = 0;
  for (const booking of conflicts) {
    const result = await BookingService.cancel([booking], {
      actor: { type: 'admin', req },
      wholeSeries: false,
      reason: `Rommet er ikke tilgjengelig i perioden${values.reason ? `: ${values.reason}` : ''}.`,
    });
    if (result.mailSent || booking.status === 'pending') notified++;
  }

  let text = rooms.length > 1 ? `Alle ${rooms.length} rom er sperret.` : `${rooms[0].name} er sperret.`;
  if (conflicts.length) {
    text +=
      notified === conflicts.length
        ? ` ${conflicts.length} booking(er) er avlyst, og de som booket har fått beskjed.`
        : ` ${conflicts.length} booking(er) er avlyst, men ${conflicts.length - notified} fikk ikke e-post. Gi beskjed manuelt.`;
  }
  flash(req, 'success', text);
  res.redirect('/admin/sperringer');
});

router.post('/sperringer/:id/slett', manageRooms, (req, res) => {
  const block = RoomBlocks.getInOrg(Number(req.params.id), req.org.id);
  if (!block) return notFound(res);
  const room = Rooms.get(block.room_id);
  RoomBlocks.delete(block.id);
  audit.byAdmin(req, 'room.unblocked', `Fjernet sperringen av ${room.name} ${blockRange(block.start_time, block.end_time)}`, {
    type: 'block',
    id: block.id,
  });
  flash(req, 'success', `Sperringen er fjernet, og ${room.name} kan bookes igjen i perioden.`);
  res.redirect('/admin/sperringer');
});

module.exports = router;
