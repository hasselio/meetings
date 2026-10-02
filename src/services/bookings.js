// All logikk for å opprette, bekrefte, endre og avlyse bookinger, felles for det offentlige
// skjemaet, lenken i e-posten og adminkalenderen. Sjekk og lagring skjer synkront i samme
// databasetransaksjon, så to som booker samtidig ikke kan få samme tid.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const audit = require('../audit');
const Rules = require('../rules');
const time = require('../time');
const { Rooms, Bookings, RoomBlocks } = require('../models');
const mailer = require('./mailer');
const { manageUrl } = require('../tokens');

const MINUTE = 60000;

const fail = (status, code, error) => ({ ok: false, status, code, error });

// Sjekker ett tidsrom. Administratorer kan overstyre rommets regler, men aldri sperringer eller
// andre bookinger.
function slotProblem(room, start, end, { excludeIds = [], bypassRules = false, now = new Date() } = {}) {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) {
    return fail(400, 'invalid', 'Sluttid må være etter starttid.');
  }
  if (s < new Date(now.getTime() - MINUTE)) return fail(400, 'past', 'Tidspunktet har allerede passert.');
  if (e - s > 24 * 60 * MINUTE) return fail(400, 'too-long', 'En booking kan vare maks ett døgn.');

  if (!bypassRules) {
    const message = Rules.violation(room, s, e, now);
    if (message) return fail(400, 'rule', message);
  }

  const startIso = s.toISOString();
  const endIso = e.toISOString();
  const block = RoomBlocks.overlapping(room.id, startIso, endIso)[0];
  if (block) {
    const why = block.reason ? ` (${block.reason})` : '';
    return fail(
      409,
      'blocked',
      `${room.name} er sperret ${time.formatRange(block.start_time, block.end_time)}${why}.`
    );
  }

  if (Bookings.overlapping(room.id, startIso, endIso, excludeIds).length) {
    return fail(409, 'taken', `${room.name} er allerede booket i dette tidsrommet.`);
  }
  const buffer = bypassRules ? 0 : Rules.rulesOf(room).bufferMinutes;
  if (buffer) {
    const padded = Bookings.overlapping(
      room.id,
      new Date(s.getTime() - buffer * MINUTE).toISOString(),
      new Date(e.getTime() + buffer * MINUTE).toISOString(),
      excludeIds
    );
    if (padded.length) {
      return fail(409, 'buffer', `${room.name} krever ${buffer} minutter mellom møter. Velg en litt annen tid.`);
    }
  }
  return null;
}

const needsConfirmation = (actor) => actor.type === 'visitor' && config.bookingConfirmation && mailer.canSend();

function logFor(actor, action, summary, booking) {
  const target = { type: 'booking', id: booking.id };
  if (actor.type === 'admin') audit.byAdmin(actor.req, action, summary, target);
  else audit.byVisitor(actor.req, action, summary, target, booking.organizer_name);
}

async function safely(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[booking] ${label}:`, err);
    return { sent: false, error: true };
  }
}

const roomById = (id) => Rooms.get(id);

/**
 * Oppretter én booking eller en serie.
 * occurrences: [{ start, end }] i UTC. series: { rule, skipConflicts } for gjentakende møter.
 * actor: { type: 'visitor' | 'admin', req }.
 */
async function create({ room, input, occurrences, series = null, actor, bypassRules = false, notify = true }) {
  const now = new Date();
  const pending = needsConfirmation(actor);
  const seriesId = series ? crypto.randomUUID() : null;
  const skipped = [];

  const result = db.transaction(() => {
    const accepted = [];
    for (const occ of occurrences) {
      const problem = slotProblem(room, occ.start, occ.end, { bypassRules, now });
      if (!problem) {
        accepted.push(occ);
        continue;
      }
      if (series && series.skipConflicts && problem.code !== 'invalid') {
        skipped.push({ ...occ, reason: problem.error });
        continue;
      }
      const prefix = occurrences.length > 1 ? `${time.formatRange(occ.start, occ.end)}: ` : '';
      return { ...problem, error: prefix + problem.error, conflict: occ };
    }
    if (!accepted.length) return fail(409, 'none-free', 'Ingen av datoene i serien er ledige.');

    const rule = series
      ? { ...series.rule, title: input.title, skipped: skipped.map((o) => new Date(o.start).toISOString()) }
      : null;
    const created = accepted.map((occ) =>
      Bookings.create({
        roomId: room.id,
        title: input.title,
        organizerName: input.organizerName,
        organizerEmail: input.organizerEmail,
        notes: input.notes,
        start: new Date(occ.start).toISOString(),
        end: new Date(occ.end).toISOString(),
        status: pending ? 'pending' : 'confirmed',
        expiresAt: pending ? new Date(now.getTime() + config.pendingHoldMinutes * MINUTE).toISOString() : null,
        seriesId,
        seriesRule: rule,
        occurrenceStart: series ? new Date(occ.start).toISOString() : null,
        createdByAdminId: actor.type === 'admin' ? actor.req.admin.id : null,
      })
    );
    return { ok: true, bookings: created };
  })();

  if (!result.ok) return result;
  const { bookings } = result;
  const first = bookings[0];

  const what = series ? `serien «${first.title}» (${bookings.length} møter)` : `«${first.title}»`;
  logFor(
    actor,
    'booking.created',
    actor.type === 'admin'
      ? `Booket ${what} i ${room.name} for ${first.organizer_name}, ${time.formatRange(first.start_time, first.end_time)}`
      : `${first.organizer_name} booket ${what} i ${room.name}, ${time.formatRange(first.start_time, first.end_time)}${
          pending ? ' (venter på bekreftelse)' : ''
        }`,
    first
  );

  const mail = notify
    ? await safely(`e-post for booking #${first.id}`, () =>
        pending ? mailer.sendConfirmRequest(bookings, room) : mailer.sendInvitation(bookings, room)
      )
    : { sent: false };

  return {
    ok: true,
    bookings,
    skipped,
    pending,
    mailSent: Boolean(mail.sent),
    // Uten e-post er lenken på kvitteringssiden den eneste måten å endre eller avbestille på.
    manageUrl: !pending && !mail.sent ? manageUrl(first) : null,
    notified: notify,
  };
}

// Bekrefter alle ubekreftede bookinger bak en lenke. Er holdetiden ute, bekreftes de som fortsatt er ledige.
async function confirm(bookings, actor) {
  const room = roomById(bookings[0].room_id);
  const now = new Date();
  const waiting = bookings.filter((b) => b.status === 'pending');
  if (!waiting.length) return { ok: true, already: true };

  const outcome = db.transaction(() => {
    const confirmed = [];
    const lost = [];
    for (const b of waiting) {
      const expired = !b.expires_at || b.expires_at <= now.toISOString();
      const problem =
        expired &&
        slotProblem(roomById(b.room_id), b.start_time, b.end_time, { excludeIds: [b.id], bypassRules: true, now });
      if (problem) {
        Bookings.cancel(b.id);
        lost.push(b);
      } else {
        confirmed.push(Bookings.confirm(b.id));
      }
    }
    return { confirmed, lost };
  })();

  if (!outcome.confirmed.length) {
    return fail(409, 'expired', 'Bookingen ble ikke bekreftet i tide, og tiden er nå tatt av noen andre.');
  }

  const first = outcome.confirmed[0];
  logFor(actor, 'booking.confirmed', `${first.organizer_name} bekreftet «${first.title}» i ${room.name}`, first);
  const all = first.series_id ? Bookings.bySeries(first.series_id) : [Bookings.get(first.id)];
  const mail = await safely(`invitasjon for booking #${first.id}`, () => mailer.sendInvitation(all, roomById));
  return { ok: true, confirmed: outcome.confirmed, lost: outcome.lost, mailSent: Boolean(mail.sent) };
}

// Endrer tid, rom eller tekst for én booking (også én forekomst i en serie).
async function update(booking, changes, { actor, bypassRules = false, notify = true }) {
  const room = roomById(changes.roomId || booking.room_id);
  if (!room) return fail(404, 'no-room', 'Fant ikke rommet.');
  const start = changes.start ? new Date(changes.start).toISOString() : booking.start_time;
  const end = changes.end ? new Date(changes.end).toISOString() : booking.end_time;

  const result = db.transaction(() => {
    const timeChanged = start !== booking.start_time || end !== booking.end_time || room.id !== booking.room_id;
    if (timeChanged) {
      const problem = slotProblem(room, start, end, { excludeIds: [booking.id], bypassRules });
      if (problem) return problem;
    }
    return { ok: true, booking: Bookings.update(booking.id, { ...changes, roomId: room.id, start, end }) };
  })();
  if (!result.ok) return result;

  const updated = result.booking;
  const moved = updated.start_time !== booking.start_time || updated.room_id !== booking.room_id;
  logFor(
    actor,
    'booking.updated',
    `${actor.type === 'admin' ? 'Endret' : `${booking.organizer_name} endret`} «${updated.title}»` +
      (moved ? ` til ${room.name}, ${time.formatRange(updated.start_time, updated.end_time)}` : ''),
    updated
  );

  let mailSent = false;
  // Ny e-postadresse: den gamle mottakeren får avlysning, den nye får invitasjonen under.
  if (notify && booking.status === 'confirmed' && updated.organizer_email !== booking.organizer_email) {
    await safely(`avlysning til tidligere adresse for booking #${booking.id}`, () =>
      mailer.sendCancellation([{ ...booking, ics_sequence: updated.ics_sequence }], roomById, { wholeSeries: false })
    );
  }
  if (notify && updated.status === 'confirmed') {
    const all = updated.series_id ? Bookings.bySeries(updated.series_id) : [updated];
    mailSent = Boolean((await safely(`endring for booking #${updated.id}`, () => mailer.sendInvitation(all, roomById, { updated: true }))).sent);
  }
  return { ok: true, booking: updated, mailSent };
}

/**
 * Avlyser bookinger. wholeSeries betyr at hele serien (eller enkeltbookingen) avlyses.
 * notify: send avlysning på e-post (ikke for ubekreftede bookinger, de har ingen invitasjon).
 */
async function cancel(bookings, { actor, wholeSeries = true, reason = null, notify = true }) {
  const targets = bookings.filter((b) => b.status !== 'cancelled' && new Date(b.end_time) > new Date());
  if (!targets.length) return fail(400, 'nothing', 'Det er ingenting å avlyse.');
  const wasConfirmed = targets.some((b) => b.status === 'confirmed');
  const cancelled = db.transaction(() => targets.map((b) => Bookings.cancel(b.id)))();

  const first = cancelled[0];
  const room = roomById(first.room_id);
  const what = cancelled.length > 1 ? `${cancelled.length} møter i «${first.title}»` : `«${first.title}»`;
  logFor(
    actor,
    'booking.cancelled',
    actor.type === 'admin'
      ? `Avlyste ${what} i ${room.name} for ${first.organizer_name}`
      : `${first.organizer_name} avbestilte ${what} i ${room.name}`,
    first
  );

  let mailSent = false;
  if (notify && wasConfirmed) {
    const series = first.series_id ? Bookings.bySeries(first.series_id) : null;
    // Har serien møter som allerede er holdt, avlyses bare de kommende, så historikken blir stående i kalenderen.
    const hasPast = series && series.some((b) => b.status === 'confirmed' && new Date(b.end_time) <= new Date());
    mailSent = Boolean(
      (
        await safely(`avlysning for booking #${first.id}`, () =>
          mailer.sendCancellation(cancelled, roomById, { wholeSeries: wholeSeries && !hasPast, series, reason })
        )
      ).sent
    );
  }
  return { ok: true, cancelled, mailSent };
}

module.exports = { slotProblem, create, confirm, update, cancel, needsConfirmation };
