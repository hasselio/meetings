// Tidssonehjelpere uten eksterne biblioteker. All lagring skjer i UTC; regler, visning og
// gjentakelser regnes i lokal tid (config.timezone), slik at f.eks. «hver mandag kl. 10» holder
// seg på 10:00 også over sommertid/vintertid.
const config = require('./config');

const TZ = config.timezone;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();

function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      })
    );
  }
  return formatters.get(tz);
}

function localParts(date, tz = TZ) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(date))) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS[p.weekday],
  };
}

// Hvor mange minutter tidssonen ligger foran UTC på et gitt tidspunkt.
function offsetMinutes(date, tz = TZ) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(new Date(date).getTime() / 1000) * 1000) / 60000);
}

// Lokal veggklokketid → UTC-tidspunkt.
function zonedTimeToUtc(year, month, day, hour, minute, tz = TZ) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMinutes(guess, tz);
  let t = guess - first * 60000;
  const second = offsetMinutes(t, tz);
  if (second !== first) t = guess - second * 60000;
  return new Date(t);
}

const pad = (n) => String(n).padStart(2, '0');

function localDateKey(date, tz = TZ) {
  const p = localParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function localMinutes(date, tz = TZ) {
  const p = localParts(date, tz);
  return p.hour * 60 + p.minute;
}

function parseHHMM(value) {
  const [h, m] = String(value || '').split(':').map(Number);
  return h * 60 + (m || 0);
}

function addDays(year, month, day, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const nbTime = new Intl.DateTimeFormat('nb-NO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nbDay = new Intl.DateTimeFormat('nb-NO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const nbDate = new Intl.DateTimeFormat('nb-NO', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });

const formatTime = (d) => nbTime.format(new Date(d));
const formatDay = (d) => nbDay.format(new Date(d));
const formatDate = (d) => nbDate.format(new Date(d));
const formatRange = (start, end) => `${formatDay(start)}, ${formatTime(start)}–${formatTime(end)}`;

module.exports = {
  TZ,
  localParts,
  offsetMinutes,
  zonedTimeToUtc,
  localDateKey,
  localMinutes,
  parseHHMM,
  addDays,
  formatTime,
  formatDay,
  formatDate,
  formatRange,
  pad,
};
