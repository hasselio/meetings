const nodemailer = require('nodemailer');
const { createEvent } = require('ics');
const config = require('../config');

let transporter = null;
function getTransporter() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

function toDateArray(isoString) {
  const d = new Date(isoString);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
}

function buildIcs(booking, room, { method = 'REQUEST', sequence = 0 } = {}) {
  const { error, value } = createEvent({
    uid: booking.ics_uid,
    sequence,
    start: toDateArray(booking.start_time),
    startInputType: 'utc',
    end: toDateArray(booking.end_time),
    endInputType: 'utc',
    title: booking.title,
    description: booking.notes || '',
    location: room.location || room.name,
    status: method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED',
    organizer: { name: config.mailFromName, email: config.mailFromEmail },
    attendees: [{ name: booking.organizer_name, email: booking.organizer_email, rsvp: true, partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT' }],
  });
  if (error) throw error;
  return value;
}

async function sendBookingConfirmation(booking, room) {
  const t = getTransporter();
  if (!t) {
    console.warn('[mailer] SMTP er ikke konfigurert – bekreftelse ble ikke sendt for booking #%s', booking.id);
    return { sent: false, reason: 'smtp-not-configured' };
  }

  const icsContent = buildIcs(booking, room, { method: 'REQUEST', sequence: booking.ics_sequence || 0 });

  await t.sendMail({
    from: `"${config.mailFromName}" <${config.mailFromEmail}>`,
    to: booking.organizer_email,
    cc: config.adminNotifyEmail || undefined,
    subject: `Møtebekreftelse: ${booking.title} (${room.name})`,
    text:
      `Hei ${booking.organizer_name},\n\n` +
      `Møtet ditt er bekreftet:\n\n` +
      `Rom: ${room.name}\n` +
      `Tittel: ${booking.title}\n` +
      `Start: ${new Date(booking.start_time).toLocaleString('nb-NO', { timeZone: config.timezone })}\n` +
      `Slutt: ${new Date(booking.end_time).toLocaleString('nb-NO', { timeZone: config.timezone })}\n\n` +
      `Kalenderinvitasjon er lagt ved denne e-posten.\n`,
    icalEvent: {
      filename: 'mote.ics',
      method: 'REQUEST',
      content: icsContent,
    },
  });

  return { sent: true };
}

async function sendBookingCancellation(booking, room) {
  const t = getTransporter();
  if (!t) {
    console.warn('[mailer] SMTP er ikke konfigurert – avlysning ble ikke sendt for booking #%s', booking.id);
    return { sent: false, reason: 'smtp-not-configured' };
  }

  const nextSequence = (booking.ics_sequence || 0) + 1;
  const icsContent = buildIcs(booking, room, { method: 'CANCEL', sequence: nextSequence });

  await t.sendMail({
    from: `"${config.mailFromName}" <${config.mailFromEmail}>`,
    to: booking.organizer_email,
    cc: config.adminNotifyEmail || undefined,
    subject: `Møte avlyst: ${booking.title} (${room.name})`,
    text:
      `Hei ${booking.organizer_name},\n\n` +
      `Møtet ditt er avlyst:\n\n` +
      `Rom: ${room.name}\n` +
      `Tittel: ${booking.title}\n` +
      `Start: ${new Date(booking.start_time).toLocaleString('nb-NO', { timeZone: config.timezone })}\n` +
      `Slutt: ${new Date(booking.end_time).toLocaleString('nb-NO', { timeZone: config.timezone })}\n`,
    icalEvent: {
      filename: 'avlyst.ics',
      method: 'CANCEL',
      content: icsContent,
    },
  });

  return { sent: true, sequence: nextSequence };
}

module.exports = { sendBookingConfirmation, sendBookingCancellation };
