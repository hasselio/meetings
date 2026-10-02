const crypto = require('crypto');
const config = require('./config');

// Lenken i e-posten (bekreft, endre, avbestille) avledes fra en hemmelig nøkkel og bookingens
// tilfeldige UID. Da kan påminnelser og oppdateringer inneholde samme lenke uten at den lagres:
// databasen har bare en hash, som brukes til oppslag.
const key = crypto.createHmac('sha256', config.sessionSecret).update('booking-manage-links').digest();

const keyFor = (booking) => booking.series_id || booking.ics_uid;

function manageToken(booking) {
  return crypto.createHmac('sha256', key).update(keyFor(booking)).digest('base64url').slice(0, 32);
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const manageUrl = (booking) => `${config.baseUrl}/booking/${manageToken(booking)}`;

const isTokenShape = (token) => /^[A-Za-z0-9_-]{32}$/.test(token || '');

module.exports = { manageToken, hashToken, manageUrl, isTokenShape, keyFor };
