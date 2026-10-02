// Gjentakende møter: regner ut forekomstene i lokal tid, slik at «hver mandag kl. 10» holder seg
// på 10:00 også etter overgang mellom sommertid og vintertid.
const time = require('./time');

const MAX_OCCURRENCES = 26;
const MAX_DAYS = 366;

const PATTERNS = {
  weekdays: { label: 'Hver ukedag (man–fre)', step: 1, interval: 1 },
  weekly: { label: 'Hver uke', step: 7, interval: 1 },
  biweekly: { label: 'Annenhver uke', step: 14, interval: 2 },
};

const isPattern = (p) => Object.prototype.hasOwnProperty.call(PATTERNS, p);

/**
 * start/end: første møte (Date). until: siste dato, «YYYY-MM-DD» i lokal tid (tas med).
 * Returnerer { occurrences, rule } eller { error }.
 */
function expand({ start, end, pattern, until }) {
  if (!isPattern(pattern)) return { error: 'Velg hvor ofte møtet skal gjentas.' };
  const p = PATTERNS[pattern];
  const first = time.localParts(start);
  const durationMinutes = Math.round((end - start) / 60000);

  const untilMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until || '');
  if (!untilMatch) return { error: 'Velg hvilken dato serien skal slutte.' };
  const [uy, um, ud] = untilMatch.slice(1).map(Number);
  const untilEnd = time.zonedTimeToUtc(uy, um, ud, 23, 59);
  if (untilEnd <= start) return { error: 'Sluttdatoen for serien må være etter første møte.' };
  if (untilEnd - start > MAX_DAYS * 24 * 3600 * 1000) return { error: 'En serie kan vare i maks ett år.' };
  if (pattern === 'weekdays' && (first.weekday === 0 || first.weekday === 6)) {
    return { error: 'Første møte i en serie på ukedager må være en ukedag.' };
  }

  const occurrences = [];
  for (let offset = 0; ; offset += p.step) {
    const day = time.addDays(first.year, first.month, first.day, offset);
    const s = time.zonedTimeToUtc(day.year, day.month, day.day, first.hour, first.minute);
    if (s > untilEnd) break;
    if (pattern === 'weekdays') {
      const wd = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
      if (wd === 0 || wd === 6) continue;
    }
    occurrences.push({ start: s, end: new Date(s.getTime() + durationMinutes * 60000) });
    if (occurrences.length > MAX_OCCURRENCES) {
      return { error: `En serie kan ha maks ${MAX_OCCURRENCES} møter. Velg en tidligere sluttdato.` };
    }
  }

  return {
    occurrences,
    rule: {
      pattern,
      freq: 'WEEKLY',
      interval: p.interval,
      byDay: pattern === 'weekdays' ? [1, 2, 3, 4, 5] : [first.weekday],
      until: new Date(untilEnd.getTime() + 59999).toISOString(),
      durationMinutes,
    },
  };
}

function describe(rule) {
  if (!rule) return null;
  const parsed = typeof rule === 'string' ? JSON.parse(rule) : rule;
  return PATTERNS[parsed.pattern] ? PATTERNS[parsed.pattern].label : null;
}

module.exports = { expand, describe, isPattern, PATTERNS, MAX_OCCURRENCES };
