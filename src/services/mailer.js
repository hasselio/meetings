const nodemailer = require('nodemailer');
const config = require('../config');
const { buildCalendar } = require('../ics');
const { manageUrl } = require('../tokens');
const time = require('../time');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!config.smtp.host) return null;
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

// Testene setter inn en egen transport som bare samler opp e-postene.
function setTransport(t) {
  transporter = t;
}

const canSend = () => Boolean(getTransporter());

async function send(message) {
  const t = getTransporter();
  if (!t || !message.to) return { sent: false, reason: 'smtp-not-configured' };
  await t.sendMail({ from: `"${config.mailFromName}" <${config.mailFromEmail}>`, ...message });
  return { sent: true };
}

// --- Kalenderinvitasjoner ---
// `rooms` er enten ett rom eller en funksjon (roomId) => rom, for serier der forekomster er flyttet.

const roomLookup = (rooms) => (typeof rooms === 'function' ? rooms : () => rooms);
const locationOf = (room) => (room.location ? `${room.name}, ${room.location}` : room.name);
const seriesUid = (seriesId) => `serie-${seriesId}@moterom`;
const seriesSequence = (bookings) => bookings.reduce((sum, b) => sum + (b.ics_sequence || 0), 0);

function baseEvent(booking, room) {
  const link = manageUrl(booking);
  return {
    summary: booking.title,
    location: locationOf(room),
    description: [booking.notes, `Endre eller avbestill: ${link}`].filter(Boolean).join('\n\n'),
    url: link,
    organizer: { name: config.mailFromName, email: config.mailFromEmail },
    attendee: { name: booking.organizer_name, email: booking.organizer_email },
  };
}

// Én booking blir én hendelse. En serie blir én hendelse med RRULE, unntak for avlyste eller
// hoppede datoer, og egne hendelser for forekomster som er flyttet eller endret.
function eventsFor(bookings, rooms) {
  const roomOf = roomLookup(rooms);
  const first = bookings[0];
  if (!first.series_id) {
    return [
      {
        ...baseEvent(first, roomOf(first.room_id)),
        uid: first.ics_uid,
        sequence: first.ics_sequence,
        start: first.start_time,
        end: first.end_time,
      },
    ];
  }

  const rule = JSON.parse(first.series_rule || '{}');
  const ordered = [...bookings].sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start));
  const master = ordered[0];
  const masterStart = new Date(master.occurrence_start);
  const duration = (rule.durationMinutes || 60) * 60000;
  const sequence = seriesSequence(bookings);
  const uid = seriesUid(first.series_id);

  const exdates = [
    ...(rule.skipped || []),
    ...ordered.filter((b) => b.status === 'cancelled').map((b) => b.occurrence_start),
  ];
  const changed = ordered.filter(
    (b) =>
      b.status !== 'cancelled' &&
      (b.start_time !== b.occurrence_start ||
        new Date(b.end_time) - new Date(b.start_time) !== duration ||
        b.room_id !== master.room_id ||
        b.title !== rule.title)
  );

  return [
    {
      ...baseEvent(master, roomOf(master.room_id)),
      summary: rule.title || master.title,
      uid,
      sequence,
      start: masterStart,
      end: new Date(masterStart.getTime() + duration),
      rrule: { freq: 'WEEKLY', interval: rule.interval || 1, byDay: rule.byDay, until: rule.until },
      exdates,
    },
    ...changed.map((b) => ({
      ...baseEvent(b, roomOf(b.room_id)),
      uid,
      sequence,
      recurrenceId: b.occurrence_start,
      start: b.start_time,
      end: b.end_time,
    })),
  ];
}

function whenLines(bookings) {
  const shown = bookings.slice(0, 12).map((b) => `  • ${time.formatRange(b.start_time, b.end_time)}`);
  if (bookings.length > shown.length) shown.push(`  … og ${bookings.length - shown.length} til`);
  return shown.join('\n');
}

const activeOnly = (bookings) => bookings.filter((b) => b.status !== 'cancelled');
const greeting = (booking) => `Hei ${booking.organizer_name},\n\n`;
const footer = `\n\nDenne e-posten er sendt automatisk fra møteromsbookingen. Personvern: ${config.baseUrl}/personvern\n`;

// Sendes når bookingen må bekreftes før den gjelder.
function sendConfirmRequest(bookings, room) {
  const b = bookings[0];
  return send({
    to: b.organizer_email,
    subject: `Bekreft bookingen: ${b.title} (${room.name})`,
    text:
      greeting(b) +
      `Du har booket ${room.name}:\n\n${whenLines(bookings)}\n\n` +
      `Bookingen gjelder først når du bekrefter den. Åpne lenken innen ${config.pendingHoldMinutes} minutter:\n\n` +
      `${manageUrl(b)}\n\n` +
      'Var det ikke du som booket? Da kan du se bort fra e-posten; tiden blir ledig igjen av seg selv.' +
      footer,
  });
}

function sendInvitation(bookings, rooms, { updated = false } = {}) {
  const b = bookings[0];
  const room = roomLookup(rooms)(b.room_id);
  const content = buildCalendar({ method: 'REQUEST', events: eventsFor(bookings, rooms) });
  return send({
    to: b.organizer_email,
    cc: config.adminNotifyEmail || undefined,
    subject: `${updated ? 'Endret' : 'Bekreftet'}: ${b.title} (${room.name})`,
    text:
      greeting(b) +
      (updated ? 'Møtet ditt er endret. Slik ser det ut nå:\n\n' : 'Møtet ditt er bekreftet:\n\n') +
      `Rom: ${locationOf(room)}\n` +
      `Tittel: ${b.title}\n` +
      `Tid:\n${whenLines(activeOnly(bookings))}\n\n` +
      'Kalenderinvitasjonen er lagt ved.\n\n' +
      `Endre eller avbestille: ${manageUrl(b)}` +
      footer,
    icalEvent: { filename: 'mote.ics', method: 'REQUEST', content },
  });
}

// `cancelled` er bookingene som avlyses nå. Er det hele serien (eller en enkeltbooking), avlyses
// hele avtalen; ellers bare de enkelte forekomstene. `series` er alle bookingene i serien.
function sendCancellation(cancelled, rooms, { wholeSeries = true, series = null, reason = null } = {}) {
  const b = cancelled[0];
  const roomOf = roomLookup(rooms);
  const room = roomOf(b.room_id);
  let events;
  if (!b.series_id) {
    events = [{ ...baseEvent(b, room), uid: b.ics_uid, sequence: b.ics_sequence, start: b.start_time, end: b.end_time }];
  } else if (wholeSeries) {
    events = eventsFor(series || cancelled, rooms).slice(0, 1);
  } else {
    const sequence = seriesSequence(series || cancelled);
    events = cancelled.map((c) => ({
      ...baseEvent(c, roomOf(c.room_id)),
      uid: seriesUid(c.series_id),
      sequence,
      recurrenceId: c.occurrence_start,
      start: c.start_time,
      end: c.end_time,
    }));
  }
  const content = buildCalendar({ method: 'CANCEL', events: events.map((e) => ({ ...e, status: 'CANCELLED' })) });
  return send({
    to: b.organizer_email,
    cc: config.adminNotifyEmail || undefined,
    subject: `Avlyst: ${b.title} (${room.name})`,
    text:
      greeting(b) +
      `Dette er avlyst:\n\nRom: ${locationOf(room)}\nTittel: ${b.title}\nTid:\n${whenLines(cancelled)}\n` +
      (reason ? `\nÅrsak: ${reason}\n` : '') +
      footer,
    icalEvent: { filename: 'avlyst.ics', method: 'CANCEL', content },
  });
}

function sendReminder(booking, room) {
  return send({
    to: booking.organizer_email,
    subject: `Påminnelse: ${booking.title} i morgen (${room.name})`,
    text:
      greeting(booking) +
      'Dette er en påminnelse om møtet ditt:\n\n' +
      `Rom: ${locationOf(room)}\n` +
      `Tittel: ${booking.title}\n` +
      `Tid: ${time.formatRange(booking.start_time, booking.end_time)}\n\n` +
      `Trenger du ikke rommet likevel? Avbestill, så andre kan bruke det:\n${manageUrl(booking)}` +
      footer,
  });
}

// --- Tilgang og kontoer ---

const sendText = (to, subject, text) => send({ to, subject, text });
const adminUrl = (path) => `${config.baseUrl}/admin${path}`;

function notifyNewAccessRequest(request) {
  return sendText(
    config.adminNotifyEmail,
    `Ny forespørsel om tilgang: ${request.name}`,
    `${request.name} (${request.email}) ber om tilgang med brukernavnet «${request.username}».\n\n` +
      (request.reason ? `Begrunnelse:\n${request.reason}\n\n` : '') +
      `Godkjenn eller avslå her: ${adminUrl('/tilgang')}\n`
  );
}

function notifyAccessDecision(request, approved) {
  return sendText(
    request.email,
    approved ? 'Du har fått tilgang' : 'Forespørselen om tilgang ble avslått',
    approved
      ? `Hei ${request.name},\n\nForespørselen din er godkjent. Logg inn med brukernavnet «${request.username}» og passordet du valgte:\n${adminUrl('/login')}\n`
      : `Hei ${request.name},\n\nForespørselen din om tilgang ble avslått. Ta kontakt med en administrator hvis du mener dette er feil.\n`
  );
}

function notifyPasswordReset(admin, temporaryPassword) {
  return sendText(
    admin.email,
    'Passordet ditt er tilbakestilt',
    `Hei ${admin.name || admin.username},\n\n` +
      `En administrator har tilbakestilt passordet ditt. Logg inn med brukernavnet «${admin.username}» og dette midlertidige passordet:\n\n` +
      `${temporaryPassword}\n\n` +
      `Du blir bedt om å velge et nytt passord med en gang du logger inn:\n${adminUrl('/login')}\n\n` +
      'Ba du ikke om dette? Ta kontakt med en administrator.\n'
  );
}

module.exports = {
  canSend,
  setTransport,
  eventsFor,
  sendConfirmRequest,
  sendInvitation,
  sendCancellation,
  sendReminder,
  notifyNewAccessRequest,
  notifyAccessDecision,
  notifyPasswordReset,
};
