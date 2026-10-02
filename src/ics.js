// Enkel iCalendar-generator (RFC 5545) for invitasjoner, avlysninger og kalenderabonnement.
// Tider skrives i lokal tid med TZID og en VTIMEZONE-blokk, slik at gjentakende møter holder
// klokkeslettet over sommertid/vintertid i Outlook, Google og Apple Kalender.
const { localParts, offsetMinutes, pad, TZ } = require('./time');

const PRODID = '-//Moterom//Booking//NO';
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Parameterverdier (f.eks. CN) kan ikke inneholde anførselstegn; spesialtegn krever at verdien siteres.
function paramValue(value) {
  const clean = String(value ?? '').replace(/["\r\n]/g, '');
  return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

// Linjer over 75 oktetter brettes, uten å dele et UTF-8-tegn i to.
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.slice(start, end).toString('utf8'));
    start = end;
    limit = 74; // fortsettelseslinjer starter med et mellomrom
  }
  return parts.join('\r\n ');
}

const utcStamp = (date) => new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function localStamp(date, tz = TZ) {
  const p = localParts(date, tz);
  return `${p.year}${pad(p.month)}${pad(p.day)}T${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

// Finner tidspunktene i et år der tidssonen bytter offset (sommertid/vintertid).
function transitions(year, tz) {
  const found = [];
  const DAY = 24 * 3600 * 1000;
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += DAY) {
    const before = offsetMinutes(t, tz);
    const after = offsetMinutes(t + DAY, tz);
    if (before === after) continue;
    let lo = t;
    let hi = t + DAY;
    while (hi - lo > 60000) {
      const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
      if (offsetMinutes(mid, tz) === before) lo = mid;
      else hi = mid;
    }
    found.push({ at: hi, from: before, to: after });
  }
  return found;
}

function vtimezone(tz, referenceDate) {
  const year = new Date(referenceDate).getUTCFullYear() - 1;
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  const changes = transitions(year, tz);

  if (changes.length === 0) {
    const offset = formatOffset(offsetMinutes(referenceDate, tz));
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, 'END:STANDARD');
  }

  for (const change of changes) {
    // DTSTART er veggklokketiden like før byttet, uttrykt i den gamle offseten.
    const wall = new Date(change.at + change.from * 60000);
    const month = wall.getUTCMonth() + 1;
    const day = wall.getUTCDate();
    const daysInMonth = new Date(Date.UTC(wall.getUTCFullYear(), month, 0)).getUTCDate();
    const nth = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7);
    const kind = change.to > change.from ? 'DAYLIGHT' : 'STANDARD';
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${wall.getUTCFullYear()}${pad(month)}${pad(day)}T${pad(wall.getUTCHours())}${pad(wall.getUTCMinutes())}00`,
      `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${nth}${WEEKDAY_CODES[wall.getUTCDay()]}`,
      `TZOFFSETFROM:${formatOffset(change.from)}`,
      `TZOFFSETTO:${formatOffset(change.to)}`,
      `END:${kind}`
    );
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

function rruleText({ freq = 'WEEKLY', interval = 1, byDay, until }) {
  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (byDay && byDay.length) parts.push(`BYDAY=${byDay.map((d) => WEEKDAY_CODES[d]).join(',')}`);
  if (until) parts.push(`UNTIL=${utcStamp(until)}`);
  return parts.join(';');
}

function veventLines(event, tz) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `SEQUENCE:${event.sequence || 0}`,
    `DTSTAMP:${utcStamp(event.stamp || new Date())}`,
    `DTSTART;TZID=${tz}:${localStamp(event.start, tz)}`,
    `DTEND;TZID=${tz}:${localStamp(event.end, tz)}`,
  ];
  if (event.recurrenceId) lines.push(`RECURRENCE-ID;TZID=${tz}:${localStamp(event.recurrenceId, tz)}`);
  if (event.rrule) lines.push(`RRULE:${rruleText(event.rrule)}`);
  if (event.exdates && event.exdates.length) {
    lines.push(`EXDATE;TZID=${tz}:${event.exdates.map((d) => localStamp(d, tz)).join(',')}`);
  }
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  lines.push(`STATUS:${event.status || 'CONFIRMED'}`);
  lines.push(`TRANSP:${event.transparent ? 'TRANSPARENT' : 'OPAQUE'}`);
  if (event.organizer) {
    lines.push(`ORGANIZER;CN=${paramValue(event.organizer.name)}:mailto:${event.organizer.email}`);
  }
  if (event.attendee) {
    lines.push(
      `ATTENDEE;CN=${paramValue(event.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${event.attendee.email}`
    );
  }
  lines.push('END:VEVENT');
  return lines;
}

// method: REQUEST (invitasjon/endring), CANCEL (avlysning) eller null (abonnement/nedlasting).
function buildCalendar({ method = null, events, name = null, tz = TZ }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN'];
  if (method) lines.push(`METHOD:${method}`);
  if (name) lines.push(`X-WR-CALNAME:${escapeText(name)}`, `X-WR-TIMEZONE:${tz}`);
  const reference = events.length ? events[0].start : new Date();
  lines.push(...vtimezone(tz, reference));
  for (const event of events) lines.push(...veventLines(event, tz));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildCalendar, escapeText, fold, transitions, rruleText, localStamp, utcStamp };
