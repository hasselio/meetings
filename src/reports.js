// Utnyttelsesgrad per rom: bookede timer delt på timene rommet kunne vært booket
// (åpningstid på åpne dager, minus sperrede perioder).
const db = require('./db');
const time = require('./time');
const Rules = require('./rules');
const { Rooms, RoomBlocks } = require('./models');

const MINUTE = 60000;

const overlapMinutes = (aStart, aEnd, bStart, bEnd) =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / MINUTE;

function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return m ? { year: +m[1], month: +m[2], day: +m[3] } : null;
}

const dateKey = (d) => `${d.year}-${time.pad(d.month)}-${time.pad(d.day)}`;

// Faste perioder i lokal tid. «to» er siste dag som tas med.
function presetRange(preset, now = new Date()) {
  const today = time.localParts(now);
  const t = { year: today.year, month: today.month, day: today.day };
  switch (preset) {
    case 'denne-maned':
      return { from: { ...t, day: 1 }, to: time.addDays(t.year, t.month + 1, 1, -1) };
    case 'forrige-maned': {
      const first = time.addDays(t.year, t.month, 1, -1);
      return { from: { ...first, day: 1 }, to: first };
    }
    case '3-maneder':
      return { from: time.addDays(t.year, t.month, t.day, -90), to: time.addDays(t.year, t.month, t.day, -1) };
    default:
      return { from: time.addDays(t.year, t.month, t.day, -28), to: time.addDays(t.year, t.month, t.day, -1) };
  }
}

function resolveRange({ preset, from, to }, now = new Date()) {
  const f = parseDate(from);
  const t = parseDate(to);
  if (f && t && dateKey(f) <= dateKey(t)) {
    const days = (Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(f.year, f.month - 1, f.day)) / 864e5;
    if (days <= 400) return { from: f, to: t, preset: 'egen' };
  }
  const p = ['siste-4-uker', 'denne-maned', 'forrige-maned', '3-maneder'].includes(preset) ? preset : 'siste-4-uker';
  return { ...presetRange(p, now), preset: p };
}

// Alltid for én bedrift: rom og bookinger fra andre bedrifter tas aldri med.
function utilization(range, orgId) {
  const start = time.zonedTimeToUtc(range.from.year, range.from.month, range.from.day, 0, 0);
  const endDay = time.addDays(range.to.year, range.to.month, range.to.day, 1);
  const end = time.zonedTimeToUtc(endDay.year, endDay.month, endDay.day, 0, 0);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const bookings = db
    .prepare(
      `SELECT b.room_id, b.start_time, b.end_time, b.status FROM bookings b JOIN rooms r ON r.id = b.room_id
       WHERE b.start_time < ? AND b.end_time > ? AND b.status IN ('confirmed', 'cancelled') AND r.organization_id = ?`
    )
    .all(endIso, startIso, orgId);

  const weekdayMinutes = [0, 0, 0, 0, 0, 0, 0];
  const rooms = Rooms.all(orgId).map((room) => {
    const rules = Rules.rulesOf(room);
    const openFrom = time.parseHHMM(rules.openFrom);
    const openTo = time.parseHHMM(rules.openTo);
    const blocks = RoomBlocks.overlapping(room.id, startIso, endIso);

    // Tilgjengelige minutter: åpningstiden hver åpne dag, minus sperringer.
    let available = 0;
    for (let d = { ...range.from }; dateKey(d) <= dateKey(range.to); d = time.addDays(d.year, d.month, d.day, 1)) {
      const weekday = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
      if (!rules.openDays.includes(weekday)) continue;
      const open = time.zonedTimeToUtc(d.year, d.month, d.day, Math.floor(openFrom / 60), openFrom % 60).getTime();
      const close = time.zonedTimeToUtc(d.year, d.month, d.day, Math.floor(openTo / 60), openTo % 60).getTime();
      const blocked = blocks.reduce(
        (sum, b) => sum + overlapMinutes(open, close, new Date(b.start_time).getTime(), new Date(b.end_time).getTime()),
        0
      );
      available += Math.max(0, (close - open) / MINUTE - blocked);
    }

    const own = bookings.filter((b) => b.room_id === room.id);
    const confirmed = own.filter((b) => b.status === 'confirmed');
    let booked = 0;
    for (const b of confirmed) {
      const minutes = overlapMinutes(start.getTime(), end.getTime(), new Date(b.start_time).getTime(), new Date(b.end_time).getTime());
      booked += minutes;
      weekdayMinutes[time.localParts(b.start_time).weekday] += minutes;
    }
    return {
      id: room.id,
      name: room.name,
      color: room.color,
      bookings: confirmed.length,
      cancelled: own.length - confirmed.length,
      bookedHours: booked / 60,
      availableHours: available / 60,
      utilization: available ? booked / available : 0,
      avgMinutes: confirmed.length ? booked / confirmed.length : 0,
    };
  });

  const totals = rooms.reduce(
    (t, r) => ({
      bookings: t.bookings + r.bookings,
      cancelled: t.cancelled + r.cancelled,
      bookedHours: t.bookedHours + r.bookedHours,
      availableHours: t.availableHours + r.availableHours,
    }),
    { bookings: 0, cancelled: 0, bookedHours: 0, availableHours: 0 }
  );
  totals.utilization = totals.availableHours ? totals.bookedHours / totals.availableHours : 0;

  const weekdayTotal = weekdayMinutes.reduce((a, b) => a + b, 0);
  const weekdays = Rules.WEEK_ORDER.map((d) => ({
    day: d,
    label: Rules.DAY_SHORT[d],
    hours: weekdayMinutes[d] / 60,
    share: weekdayTotal ? weekdayMinutes[d] / weekdayTotal : 0,
  }));

  return { rooms, totals, weekdays, start: startIso, end: endIso };
}

// Alle bookinger i perioden, til eksport.
function bookingsBetween(startIso, endIso, orgId) {
  return db
    .prepare(
      `SELECT b.*, r.name AS room_name, a.username AS admin_username FROM bookings b
       JOIN rooms r ON r.id = b.room_id LEFT JOIN admin_users a ON a.id = b.created_by_admin_id
       WHERE b.start_time < ? AND b.end_time > ? AND b.status IN ('confirmed', 'cancelled') AND r.organization_id = ?
       ORDER BY b.start_time`
    )
    .all(endIso, startIso, orgId);
}

// CSV for norsk Excel: semikolon, BOM, og vern mot formler i celler (CSV-injeksjon).
function toCsv(header, rows) {
  const cell = (value) => {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [header, ...rows].map((row) => row.map(cell).join(';')).join('\r\n') + '\r\n';
}

const decimal = (n, digits = 1) => n.toFixed(digits).replace('.', ',');

module.exports = { resolveRange, utilization, bookingsBetween, toCsv, decimal, dateKey };
