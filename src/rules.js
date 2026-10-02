// Regler per rom: åpningstid, ukedager, maks varighet, hvor langt frem i tid, og pause mellom møter.
const time = require('./time');

const DAY_NAMES = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
const DAY_SHORT = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function rulesOf(room) {
  const days = String(room.open_days ?? '1,2,3,4,5,6,0')
    .split(',')
    .filter((d) => d !== '')
    .map(Number)
    .filter((d) => d >= 0 && d <= 6);
  return {
    openFrom: room.open_from || '07:00',
    openTo: room.open_to || '20:00',
    openDays: days,
    maxDurationMinutes: room.max_duration_minutes || null,
    maxDaysAhead: room.max_days_ahead || null,
    bufferMinutes: room.buffer_minutes || 0,
  };
}

const formatDuration = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} t ${m} min` : `${h} ${h === 1 ? 'time' : 'timer'}`;
};

// «man–fre», «man, ons, fre» eller «alle dager».
function describeDays(days) {
  const ordered = WEEK_ORDER.filter((d) => days.includes(d));
  if (ordered.length === 7) return 'alle dager';
  if (ordered.length === 0) return 'ingen dager';
  const idx = ordered.map((d) => WEEK_ORDER.indexOf(d));
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (contiguous && ordered.length > 2) return `${DAY_SHORT[ordered[0]]}–${DAY_SHORT[ordered[ordered.length - 1]]}`;
  return ordered.map((d) => DAY_SHORT[d]).join(', ');
}

function describe(room) {
  const r = rulesOf(room);
  const lines = [`Kan bookes ${describeDays(r.openDays)}, ${r.openFrom}–${r.openTo}`];
  if (r.maxDurationMinutes) lines.push(`Maks ${formatDuration(r.maxDurationMinutes)} per booking`);
  if (r.maxDaysAhead) lines.push(`Inntil ${r.maxDaysAhead} dager frem i tid`);
  if (r.bufferMinutes) lines.push(`${r.bufferMinutes} min pause mellom møter`);
  return lines;
}

// Returnerer en feilmelding hvis tidsrommet bryter rommets regler, ellers null.
function violation(room, start, end, now = new Date()) {
  const r = rulesOf(room);
  const s = new Date(start);
  const e = new Date(end);
  if (time.localDateKey(s) !== time.localDateKey(new Date(e.getTime() - 1))) {
    return 'En booking må starte og slutte samme dag.';
  }
  const weekday = time.localParts(s).weekday;
  if (!r.openDays.includes(weekday)) {
    return `${room.name} kan ikke bookes på ${DAY_NAMES[weekday]}er.`;
  }
  const startMin = time.localMinutes(s);
  const endMin = time.localMinutes(e) || 24 * 60;
  if (startMin < time.parseHHMM(r.openFrom) || endMin > time.parseHHMM(r.openTo)) {
    return `${room.name} kan bookes mellom ${r.openFrom} og ${r.openTo}.`;
  }
  if (r.maxDurationMinutes && (e - s) / 60000 > r.maxDurationMinutes) {
    return `${room.name} kan bookes i maks ${formatDuration(r.maxDurationMinutes)} om gangen.`;
  }
  if (r.maxDaysAhead && s - now > r.maxDaysAhead * 24 * 3600 * 1000) {
    return `${room.name} kan bookes inntil ${r.maxDaysAhead} dager frem i tid.`;
  }
  return null;
}

module.exports = { rulesOf, describe, describeDays, violation, formatDuration, DAY_NAMES, DAY_SHORT, WEEK_ORDER };
