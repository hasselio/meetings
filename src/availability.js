const { Bookings } = require('./models');
const config = require('./config');

const TZ = config.timezone;
const DAY_START_HOUR = 7;
const DAY_END_HOUR = 19;
const HOUR_MS = 60 * 60 * 1000;

const dateKey = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: TZ });

const formatTime = (d) =>
  new Intl.DateTimeFormat('nb-NO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(d)
  );

const formatToday = (d) =>
  new Intl.DateTimeFormat('nb-NO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d);

function minutesOfDay(d) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(d));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get('hour') * 60 + get('minute');
}

const toPercent = (minutes) => {
  const span = (DAY_END_HOUR - DAY_START_HOUR) * 60;
  const clamped = Math.min(Math.max(minutes - DAY_START_HOUR * 60, 0), span);
  return (clamped / span) * 100;
};

function roomStatus(roomId, now = new Date()) {
  const nowIso = now.toISOString();
  const today = dateKey(now);
  const bookings = Bookings.forRoomBetween(
    roomId,
    new Date(now.getTime() - 24 * HOUR_MS).toISOString(),
    new Date(now.getTime() + 36 * HOUR_MS).toISOString()
  );

  const current = bookings.find((b) => b.start_time <= nowIso && b.end_time > nowIso);
  let free;
  let detail;

  if (current) {
    let until = current.end_time;
    for (const b of bookings) {
      if (b.start_time <= until && b.end_time > until) until = b.end_time;
    }
    free = false;
    detail = dateKey(until) === today ? `Opptatt til ${formatTime(until)}` : 'Opptatt resten av dagen';
  } else {
    const next = bookings.find((b) => b.start_time > nowIso);
    free = true;
    detail =
      next && dateKey(next.start_time) === today ? `Ledig til ${formatTime(next.start_time)}` : 'Ledig resten av dagen';
  }

  const segments = bookings
    .filter((b) => dateKey(b.start_time) <= today && dateKey(b.end_time) >= today && b.end_time > b.start_time)
    .map((b) => {
      const startMin = dateKey(b.start_time) < today ? 0 : minutesOfDay(b.start_time);
      const endMin = dateKey(b.end_time) > today ? 24 * 60 : minutesOfDay(b.end_time);
      const left = toPercent(startMin);
      return { left, width: toPercent(endMin) - left };
    })
    .filter((s) => s.width > 0);

  const todayCount = bookings.filter((b) => dateKey(b.start_time) === today).length;

  return {
    free,
    detail,
    segments,
    todayCount,
    nowPercent: toPercent(minutesOfDay(now)),
  };
}

const timelineHours = () => {
  const hours = [];
  for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h += 2) hours.push(String(h).padStart(2, '0'));
  return hours;
};

// Kalenderen sender tider med offset (+02:00); databasen lagrer UTC-ISO, så sammenlign i samme format.
function parseRange({ start, end }) {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  return { start: s.toISOString(), end: e.toISOString() };
}

module.exports = { roomStatus, formatToday, timelineHours, parseRange };
