// Felles hjelpere for adminrutene.
const crypto = require('crypto');
const { AdminUsers, Memberships } = require('../../models');

const MIN_PASSWORD_LENGTH = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[\w.@-]{3,40}$/;
const USERNAME_HINT = 'Brukernavnet må være 3–40 tegn: bokstaver, tall, punktum, @, - eller _.';

const notFound = (res) => res.status(404).render('public/not-found');

const flash = (req, type, text) => {
  req.session.flash = { type, text };
};

function profileInput(body) {
  return {
    name: String(body.name || '').trim().slice(0, 80),
    email: String(body.email || '').trim().slice(0, 120),
    username: String(body.username || '').trim(),
  };
}

function profileError(input, userId = 0) {
  if (!USERNAME_RE.test(input.username)) return USERNAME_HINT;
  if (input.email && !EMAIL_RE.test(input.email)) return 'Sjekk at e-postadressen er riktig.';
  if (AdminUsers.usernameTakenByOther(input.username, userId)) return 'Brukernavnet er allerede i bruk.';
  return null;
}

function passwordError(password, confirm) {
  if ((password || '').length < MIN_PASSWORD_LENGTH) return `Passordet må være minst ${MIN_PASSWORD_LENGTH} tegn.`;
  if (password !== confirm) return 'Passordene er ikke like.';
  return null;
}

// Lett å lese opp eller skrive av: ingen tegn som kan forveksles (0/O, 1/l/I).
function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const chars = Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join('')).join('-');
}

// Kontoopplysninger og passord gjelder på tvers av bedrifter. En bedriftsadministrator får derfor bare
// endre dem for kontoer som utelukkende tilhører egen bedrift; ellers kunne én bedrift låse ute
// brukere i en annen. Plattformadministratorer kan endre alle.
function canManageAccount(req, target) {
  if (req.admin.is_platform_admin) return true;
  if (target.is_platform_admin) return false;
  return Memberships.forUser(target.id).every((m) => m.organization_id === req.org.id);
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  EMAIL_RE,
  USERNAME_RE,
  USERNAME_HINT,
  notFound,
  flash,
  profileInput,
  profileError,
  passwordError,
  temporaryPassword,
  canManageAccount,
};
