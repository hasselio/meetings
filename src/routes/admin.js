const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Rooms, Bookings, AdminUsers, AdminRequests } = require('../models');
const {
  sendBookingCancellation,
  notifyNewAccessRequest,
  notifyAccessDecision,
  notifyPasswordReset,
} = require('../services/mailer');
const { requireAdmin } = require('../middleware/auth');
const { createLimiter } = require('../middleware/rate-limit');
const { challengeHandler, verifyCaptcha } = require('../captcha');
const { parseRange } = require('../availability');
const Facilities = require('../facilities');
const config = require('../config');

const router = express.Router();

const MIN_PASSWORD_LENGTH = 10;
const MAX_PENDING_REQUESTS = 50;
// Brukes når brukernavnet ikke finnes, så svartiden ikke avslører hvilke brukernavn som eksisterer.
const DUMMY_HASH = bcrypt.hashSync('ikke-et-ekte-passord', 12);

const loginLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const requestLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

// --- Innlogging ---
router.get('/login', (req, res) => {
  res.render('admin/login', { error: null, hasAdmins: AdminUsers.count() > 0, username: '' });
});

router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const key = `${req.ip}:${username.toLowerCase()}`;
  const fail = (status, error) =>
    res.status(status).render('admin/login', { error, hasAdmins: AdminUsers.count() > 0, username });

  if (loginLimiter.isLimited(key)) {
    return fail(429, 'For mange mislykkede forsøk. Vent et kvarter og prøv igjen.');
  }

  const user = AdminUsers.findByUsername(username);
  const valid = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid) {
    loginLimiter.hit(key);
    return fail(401, 'Feil brukernavn eller passord.');
  }

  loginLimiter.reset(key);
  startSession(req, res, user, user.must_change_password ? '/admin/nytt-passord' : '/admin');
});

// Ny økt-ID ved innlogging (mot session fixation), knyttet til kontoens nåværende session_version.
function startSession(req, res, user, redirectTo) {
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Kunne ikke opprette sesjon');
    req.session.adminId = user.id;
    req.session.sessionVersion = user.session_version;
    res.redirect(redirectTo);
  });
}

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// --- Be om tilgang (offentlig, beskyttet med ALTCHA og grense per IP) ---
router.get('/altcha', challengeHandler);

const emptyRequest = { name: '', email: '', username: '', reason: '' };

router.get('/be-om-tilgang', (req, res) => {
  if (AdminUsers.count() === 0) return res.redirect('/admin/login');
  res.render('admin/request-access', { error: null, values: emptyRequest });
});

router.post('/be-om-tilgang', verifyCaptcha, (req, res) => {
  const values = {
    name: (req.body.name || '').trim(),
    email: (req.body.email || '').trim(),
    username: (req.body.username || '').trim(),
    reason: (req.body.reason || '').trim(),
  };
  const fail = (status, error) => res.status(status).render('admin/request-access', { error, values });

  // Feltet er skjult for mennesker; fylles det ut, er det nesten alltid en bot.
  if (req.body.website) return res.render('admin/request-sent');
  if (res.locals.altcha.error) return fail(400, 'Bekreft at du ikke er en robot, og send på nytt.');
  if (requestLimiter.isLimited(req.ip)) return fail(429, 'Du har sendt mange forespørsler. Prøv igjen om en time.');

  if (!values.name || values.name.length > 80) return fail(400, 'Skriv inn navnet ditt.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return fail(400, 'Sjekk at e-postadressen er riktig.');
  if (!/^[\w.@-]{3,40}$/.test(values.username)) {
    return fail(400, 'Brukernavnet må være 3–40 tegn: bokstaver, tall, punktum, @, - eller _.');
  }
  if ((req.body.password || '').length < MIN_PASSWORD_LENGTH) {
    return fail(400, `Passordet må være minst ${MIN_PASSWORD_LENGTH} tegn.`);
  }
  if (req.body.password !== req.body.passwordConfirm) return fail(400, 'Passordene er ikke like.');
  if (values.reason.length > 500) return fail(400, 'Begrunnelsen kan være maks 500 tegn.');
  if (AdminRequests.usernameTaken(values.username)) return fail(409, 'Brukernavnet er opptatt. Velg et annet.');
  if (AdminRequests.countPending() >= MAX_PENDING_REQUESTS) {
    return fail(503, 'Det ligger mange ubehandlede forespørsler i køen. Prøv igjen senere.');
  }

  requestLimiter.hit(req.ip);
  const request = AdminRequests.create({
    ...values,
    passwordHash: bcrypt.hashSync(req.body.password, 12),
  });
  notifyNewAccessRequest(request).catch((err) => console.error('Kunne ikke varsle om ny tilgangsforespørsel:', err));
  res.render('admin/request-sent');
});

// --- Alt under her krever innlogging ---
router.use(requireAdmin);

router.use((req, res, next) => {
  res.locals.adminId = req.session.adminId;
  res.locals.pendingCount = AdminRequests.countPending();
  res.locals.section = /^\/(tilgang|administratorer)/.test(req.path)
    ? 'access'
    : /^\/(konto|nytt-passord)/.test(req.path)
      ? 'account'
      : req.path.startsWith('/rom')
        ? 'rooms'
        : 'bookings';
  res.locals.me = req.admin;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

const ROOM_COLORS = ['#3f5bd9', '#2f7d6d', '#c2562b', '#a1428a', '#7a6a2c', '#5b6b80', '#c23b53', '#4f7a2f'];

function roomInput(body) {
  const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : ROOM_COLORS[0];
  const capacity = parseInt(body.capacity, 10);
  return {
    name: (body.name || '').trim(),
    location: (body.location || '').trim(),
    description: (body.description || '').trim(),
    capacity: capacity > 0 ? capacity : null,
    color,
    facilities: Facilities.normalize(body.facilities),
  };
}

function renderRoomForm(res, room, error) {
  res
    .status(error ? 400 : 200)
    .render('admin/room-form', { room, error, colors: ROOM_COLORS, facilityOptions: Facilities.FACILITIES });
}

router.get('/', (req, res) => {
  const rooms = Rooms.all();
  const activeRoom = rooms.find((r) => String(r.id) === req.query.rom) || rooms[0] || null;
  res.render('admin/dashboard', { rooms, activeRoom, timezone: config.timezone });
});

// --- Rom ---
router.get('/rom', (req, res) => {
  const rooms = Rooms.allWithUpcoming(new Date().toISOString()).map((r) => ({
    ...r,
    facilityList: Facilities.describe(r.facilities),
  }));
  res.render('admin/rooms', { rooms });
});

router.get('/rom/ny', (req, res) => {
  const used = new Set(Rooms.all().map((r) => r.color));
  const color = ROOM_COLORS.find((c) => !used.has(c)) || ROOM_COLORS[0];
  renderRoomForm(res, { color }, null);
});

router.post('/rom', (req, res) => {
  const input = roomInput(req.body);
  if (!input.name) return renderRoomForm(res, input, 'Gi rommet et navn.');
  const room = Rooms.create(input);
  req.session.flash = { type: 'success', text: `«${room.name}» er lagt til og kan bookes.` };
  res.redirect('/admin/rom');
});

router.get('/rom/:id/rediger', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).render('public/not-found');
  renderRoomForm(res, room, null);
});

router.post('/rom/:id', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).render('public/not-found');
  const input = roomInput(req.body);
  if (!input.name) return renderRoomForm(res, { ...input, id: room.id }, 'Gi rommet et navn.');
  Rooms.update(room.id, input);
  req.session.flash = { type: 'success', text: `Endringene i «${input.name}» er lagret.` };
  res.redirect('/admin/rom');
});

router.post('/rom/:id/slett', async (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).render('public/not-found');

  // Bookingene slettes sammen med rommet, så de som har booket må få avlysning først.
  const upcoming = Bookings.upcomingForRoom(room.id, new Date().toISOString());
  Rooms.delete(room.id);

  const results = await Promise.allSettled(upcoming.map((b) => sendBookingCancellation(b, room)));
  const notified = results.filter((r) => r.status === 'fulfilled' && r.value.sent).length;

  let text = `«${room.name}» er slettet.`;
  if (upcoming.length) {
    text +=
      notified === upcoming.length
        ? ` ${upcoming.length} kommende booking(er) er avlyst, og de som booket har fått beskjed.`
        : ` ${upcoming.length} kommende booking(er) er avlyst, men ${upcoming.length - notified} fikk ikke e-post. Gi beskjed manuelt.`;
  }
  req.session.flash = { type: 'success', text };
  res.redirect('/admin/rom');
});

// Bookinger med fulle detaljer (kun admin)
router.get('/api/rooms/:id/events', (req, res) => {
  const room = Rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Rom ikke funnet' });

  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ error: 'Gyldig start og end er påkrevd' });

  const bookings = Bookings.forRoomBetween(room.id, range.start, range.end);
  const events = bookings.map((b) => ({
    id: b.id,
    start: b.start_time,
    end: b.end_time,
    title: b.title,
    classNames: ['ev-booking'],
    extendedProps: {
      color: room.color,
      roomName: room.name,
      organizerName: b.organizer_name,
      organizerEmail: b.organizer_email,
      notes: b.notes,
    },
  }));
  res.json(events);
});

router.get('/api/bookings/:id', (req, res) => {
  const booking = Bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking ikke funnet' });
  res.json(booking);
});

router.post('/api/bookings/:id/cancel', async (req, res) => {
  const booking = Bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking ikke funnet' });
  const room = Rooms.get(booking.room_id);

  const cancelled = Bookings.cancel(booking.id);

  let mailResult = { sent: false };
  try {
    mailResult = await sendBookingCancellation(booking, room);
    if (mailResult.sent) Bookings.bumpSequence(booking.id);
  } catch (err) {
    console.error('Kunne ikke sende avlysning for booking #%s:', booking.id, err);
  }

  res.json({ booking: cancelled, mailSent: mailResult.sent });
});

// --- Tilgangsstyring ---
router.get('/tilgang', (req, res) => {
  res.render('admin/access', {
    requests: AdminRequests.pending(),
    admins: AdminUsers.all(),
    decisions: AdminRequests.recentDecisions(),
    timezone: config.timezone,
  });
});

function decide(approve) {
  return (req, res) => {
    const result = approve
      ? AdminRequests.approve(Number(req.params.id), req.session.adminId)
      : AdminRequests.decline(Number(req.params.id), req.session.adminId);

    if (result.error) {
      req.session.flash = { type: 'error', text: result.error };
      return res.redirect('/admin/tilgang');
    }

    const { request } = result;
    req.session.flash = {
      type: 'success',
      text: approve
        ? `${request.name} har fått admintilgang som «${request.username}».`
        : `Forespørselen fra ${request.name} er avslått.`,
    };
    notifyAccessDecision(request, approve).catch((err) => console.error('Kunne ikke sende svar på tilgangsforespørsel:', err));
    res.redirect('/admin/tilgang');
  };
}

router.post('/tilgang/:id/godkjenn', decide(true));
router.post('/tilgang/:id/avsla', decide(false));

// --- Administratorkontoer ---
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[\w.@-]{3,40}$/;

function profileInput(body) {
  return {
    name: (body.name || '').trim().slice(0, 80),
    email: (body.email || '').trim().slice(0, 120),
    username: (body.username || '').trim(),
  };
}

function profileError(input, userId) {
  if (!USERNAME_RE.test(input.username)) {
    return 'Brukernavnet må være 3–40 tegn: bokstaver, tall, punktum, @, - eller _.';
  }
  if (input.email && !EMAIL_RE.test(input.email)) return 'Sjekk at e-postadressen er riktig.';
  if (AdminUsers.usernameTakenByOther(input.username, userId)) return 'Brukernavnet er allerede i bruk.';
  return null;
}

// Lett å lese opp eller skrive av: ingen tegn som kan forveksles (0/O, 1/l/I).
function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join('')).join('-');
}

function renderAdminEdit(res, target, { error = null, values = null, status = 200 } = {}) {
  res.status(status).render('admin/admin-edit', {
    target,
    values: values || target,
    error,
    adminCount: AdminUsers.count(),
    canEmail: Boolean(config.smtp.host),
  });
}

router.get('/administratorer/:id', (req, res) => {
  const target = AdminUsers.findById(Number(req.params.id));
  if (!target) return res.status(404).render('public/not-found');
  if (target.id === req.admin.id) return res.redirect('/admin/konto');
  renderAdminEdit(res, target);
});

router.post('/administratorer/:id', (req, res) => {
  const target = AdminUsers.findById(Number(req.params.id));
  if (!target) return res.status(404).render('public/not-found');
  if (target.id === req.admin.id) return res.redirect('/admin/konto');

  const input = profileInput(req.body);
  const error = profileError(input, target.id);
  if (error) return renderAdminEdit(res, target, { error, values: input, status: 400 });

  AdminUsers.update(target.id, input);
  req.session.flash = { type: 'success', text: `Endringene for «${input.username}» er lagret.` };
  res.redirect('/admin/tilgang');
});

router.post('/administratorer/:id/tilbakestill', async (req, res) => {
  const target = AdminUsers.findById(Number(req.params.id));
  if (!target) return res.status(404).render('public/not-found');
  if (target.id === req.admin.id) return res.redirect('/admin/konto');

  const password = temporaryPassword();
  // Logger samtidig ut alle aktive økter for kontoen.
  AdminUsers.setPassword(target.id, bcrypt.hashSync(password, 12), { mustChange: true });

  let mailed = false;
  if (req.body.sendEmail && target.email) {
    try {
      mailed = (await notifyPasswordReset(target, password)).sent;
    } catch (err) {
      console.error('Kunne ikke sende midlertidig passord:', err);
    }
  }
  // Det midlertidige passordet skal ikke kunne hentes fra nettleserens hurtigbuffer senere.
  res.set('Cache-Control', 'no-store');
  res.render('admin/password-reset', { target, password, mailed, triedMail: Boolean(req.body.sendEmail) });
});

router.post('/administratorer/:id/fjern', (req, res) => {
  const id = Number(req.params.id);
  const target = AdminUsers.findById(id);
  if (!target) {
    req.session.flash = { type: 'error', text: 'Fant ikke administratoren.' };
  } else if (id === req.session.adminId) {
    req.session.flash = { type: 'error', text: 'Du kan ikke fjerne din egen tilgang.' };
  } else if (AdminUsers.count() <= 1) {
    req.session.flash = { type: 'error', text: 'Det må finnes minst én administrator.' };
  } else {
    AdminUsers.delete(id);
    req.session.flash = { type: 'success', text: `Tilgangen til «${target.username}» er fjernet.` };
  }
  res.redirect('/admin/tilgang');
});

// --- Eget passord og egen konto ---
function passwordError(password, confirm) {
  if ((password || '').length < MIN_PASSWORD_LENGTH) return `Passordet må være minst ${MIN_PASSWORD_LENGTH} tegn.`;
  if (password !== confirm) return 'Passordene er ikke like.';
  return null;
}

// Etter bytte får denne økten den nye versjonen, mens økter på andre enheter logges ut.
function changeOwnPassword(req, password) {
  const user = AdminUsers.setPassword(req.admin.id, bcrypt.hashSync(password, 12));
  req.session.sessionVersion = user.session_version;
}

router.get('/nytt-passord', (req, res) => {
  if (!req.admin.must_change_password) return res.redirect('/admin/konto');
  res.render('admin/change-password', { error: null });
});

router.post('/nytt-passord', (req, res) => {
  if (!req.admin.must_change_password) return res.redirect('/admin/konto');
  const { password, passwordConfirm } = req.body;
  let error = passwordError(password, passwordConfirm);
  if (!error && bcrypt.compareSync(password, req.admin.password_hash)) {
    error = 'Velg et annet passord enn det midlertidige.';
  }
  if (error) return res.status(400).render('admin/change-password', { error });

  changeOwnPassword(req, password);
  req.session.flash = { type: 'success', text: 'Nytt passord er lagret. Velkommen tilbake.' };
  res.redirect('/admin');
});

function renderAccount(res, req, { profileError: pErr = null, passwordError: pwErr = null, values = null, status = 200 } = {}) {
  res.status(status).render('admin/account', {
    values: values || req.admin,
    profileError: pErr,
    passwordError: pwErr,
  });
}

router.get('/konto', (req, res) => renderAccount(res, req));

router.post('/konto', (req, res) => {
  const input = profileInput(req.body);
  const error = profileError(input, req.admin.id);
  if (error) return renderAccount(res, req, { profileError: error, values: input, status: 400 });
  AdminUsers.update(req.admin.id, input);
  req.session.flash = { type: 'success', text: 'Kontoopplysningene er lagret.' };
  res.redirect('/admin/konto');
});

const passwordLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

router.post('/konto/passord', (req, res) => {
  const key = `pw:${req.admin.id}`;
  const fail = (status, message) => renderAccount(res, req, { passwordError: message, status });

  if (passwordLimiter.isLimited(key)) return fail(429, 'For mange feil forsøk. Vent et kvarter og prøv igjen.');
  if (!bcrypt.compareSync(req.body.currentPassword || '', req.admin.password_hash)) {
    passwordLimiter.hit(key);
    return fail(400, 'Nåværende passord er feil.');
  }
  const error = passwordError(req.body.password, req.body.passwordConfirm);
  if (error) return fail(400, error);

  passwordLimiter.reset(key);
  changeOwnPassword(req, req.body.password);
  req.session.flash = { type: 'success', text: 'Passordet er byttet. Andre enheter der du var innlogget, er logget ut.' };
  res.redirect('/admin/konto');
});

module.exports = router;
