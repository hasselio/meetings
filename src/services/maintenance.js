// Jobber som kjøres jevnlig: påminnelser, opprydding og sletting av personopplysninger.
const db = require('../db');
const config = require('../config');
const audit = require('../audit');
const { Rooms, Bookings } = require('../models');
const mailer = require('./mailer');

const HOUR = 3600 * 1000;

const monthsAgo = (months, now = new Date()) => {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
};

// Påminnelse for bekreftede møter som starter innen et døgn.
async function sendReminders(now = new Date()) {
  if (!config.reminders || !mailer.canSend()) return 0;
  const due = Bookings.dueReminders(now.toISOString(), new Date(now.getTime() + 24 * HOUR).toISOString());
  let sent = 0;
  for (const booking of due) {
    const room = Rooms.get(booking.room_id);
    // Markeres før sending, så en feil ikke gir samme påminnelse hvert tiende minutt.
    Bookings.markReminded(booking.id);
    try {
      if ((await mailer.sendReminder(booking, room)).sent) sent++;
    } catch (err) {
      console.error('[jobs] påminnelse for booking #%s feilet:', booking.id, err);
    }
  }
  return sent;
}

// Ubekreftede bookinger som har vært utløpt et døgn, slettes helt.
function deleteStalePending(now = new Date()) {
  return Bookings.deleteExpiredPending(new Date(now.getTime() - 24 * HOUR).toISOString());
}

// Personopplysninger fjernes etter RETENTION_MONTHS; rom og tid beholdes for statistikk.
function applyRetention(now = new Date()) {
  const cutoff = monthsAgo(config.retentionMonths, now);
  const anonymized = Bookings.anonymizeEndedBefore(cutoff);
  const requests = db
    .prepare(`DELETE FROM admin_requests WHERE status != 'pending' AND decided_at < datetime(?)`)
    .run(cutoff).changes;
  if (anonymized || requests) {
    audit.log({
      action: 'booking.anonymized',
      summary: `Anonymiserte ${anonymized} booking(er) og slettet ${requests} behandlet(e) tilgangsforespørsel(er) eldre enn ${config.retentionMonths} måneder`,
    });
  }
  return { anonymized, requests };
}

module.exports = { sendReminders, deleteStalePending, applyRetention };
