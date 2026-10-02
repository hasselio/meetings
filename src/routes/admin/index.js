const express = require('express');
const bcrypt = require('bcryptjs');
const { AdminUsers, AdminRequests, Memberships, Organizations } = require('../../models');
const mailer = require('../../services/mailer');
const { requireAdmin, requireOrg, availableOrgs } = require('../../middleware/auth');
const { createLimiter } = require('../../middleware/rate-limit');
const { challengeHandler, verifyCaptcha } = require('../../captcha');
const { can, roleLabel } = require('../../roles');
const audit = require('../../audit');
const { MIN_PASSWORD_LENGTH, EMAIL_RE, USERNAME_RE, USERNAME_HINT, flash } = require('./helpers');

const router = express.Router();

const MAX_PENDING_REQUESTS = 50;
// Brukes når brukernavnet ikke finnes, så svartiden ikke avslører hvilke brukernavn som eksisterer.
const DUMMY_HASH = bcrypt.hashSync('ikke-et-ekte-passord', 12);

const loginLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const requestLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

// --- Innlogging ---
const LOGIN_NOTICES = {
  'ingen-bedrift': 'Du har ikke lenger tilgang til noen aktiv bedrift, og er logget ut.',
};

function renderLogin(res, { error = null, notice = null, username = '', status = 200 } = {}) {
  res.status(status).render('admin/login', {
    error,
    notice,
    username,
    hasAdmins: AdminUsers.count() > 0,
    canRequest: Organizations.active().length > 0,
  });
}

router.get('/login', (req, res) => renderLogin(res, { notice: LOGIN_NOTICES[req.query.melding] || null }));

router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const key = `${req.ip}:${username.toLowerCase()}`;
  const fail = (status, error) => renderLogin(res, { error, username, status });

  if (loginLimiter.isLimited(key)) {
    return fail(429, 'For mange mislykkede forsøk. Vent et kvarter og prøv igjen.');
  }

  const user = AdminUsers.findByUsername(username);
  const valid = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid) {
    loginLimiter.hit(key);
    audit.log({
      actorType: 'visitor',
      actorName: username.slice(0, 40) || null,
      action: 'login.failed',
      summary: `Mislykket innlogging som «${username.slice(0, 40)}»`,
      ip: req.ip,
    });
    return fail(401, 'Feil brukernavn eller passord.');
  }
  loginLimiter.reset(key);

  // Riktig passord, men ingen aktiv bedrift å jobbe i (fjernet, eller bedriften er deaktivert).
  if (!user.is_platform_admin && availableOrgs(user).length === 0) {
    audit.log({ actorType: 'admin', actorId: user.id, actorName: user.username, action: 'login.refused', summary: `${user.username} har ingen aktiv bedrift`, ip: req.ip });
    return fail(403, 'Kontoen din er ikke knyttet til noen aktiv bedrift. Ta kontakt med bedriftens administrator.');
  }

  audit.log({
    actorType: 'admin',
    actorId: user.id,
    actorName: user.username,
    action: 'login.success',
    summary: `${user.username} logget inn`,
    ip: req.ip,
  });
  // Ny økt-ID ved innlogging (mot session fixation), knyttet til kontoens nåværende session_version.
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Kunne ikke opprette sesjon');
    req.session.adminId = user.id;
    req.session.sessionVersion = user.session_version;
    res.redirect(user.must_change_password ? '/admin/nytt-passord' : '/admin');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// --- Be om tilgang til en bedrift (offentlig, beskyttet med ALTCHA og grense per IP) ---
router.get('/altcha', challengeHandler);

function renderRequest(res, { values = {}, error = null, status = 200 } = {}) {
  res.status(status).render('admin/request-access', {
    error,
    values: { name: '', email: '', username: '', reason: '', organization: '', ...values },
    organizations: Organizations.active(),
  });
}

router.get('/be-om-tilgang', (req, res) => {
  const preselected = Organizations.bySlug(req.query.bedrift);
  renderRequest(res, { values: { organization: preselected && preselected.active ? String(preselected.id) : '' } });
});

router.post('/be-om-tilgang', verifyCaptcha, (req, res) => {
  const values = {
    name: (req.body.name || '').trim(),
    email: (req.body.email || '').trim(),
    username: (req.body.username || '').trim(),
    reason: (req.body.reason || '').trim(),
    organization: String(req.body.organization || ''),
  };
  const fail = (status, error) => renderRequest(res, { values, error, status });

  // Feltet er skjult for mennesker; fylles det ut, er det nesten alltid en bot.
  if (req.body.website) return res.render('admin/request-sent', { org: null });
  if (res.locals.altcha.error) return fail(400, 'Bekreft at du ikke er en robot, og send på nytt.');
  if (requestLimiter.isLimited(req.ip)) return fail(429, 'Du har sendt mange forespørsler. Prøv igjen om en time.');

  const org = Organizations.get(Number(values.organization));
  if (!org || !org.active) return fail(400, 'Velg hvilken bedrift du skal ha tilgang til.');
  if (!values.name || values.name.length > 80) return fail(400, 'Skriv inn navnet ditt.');
  if (!EMAIL_RE.test(values.email)) return fail(400, 'Sjekk at e-postadressen er riktig.');
  if (!USERNAME_RE.test(values.username)) return fail(400, USERNAME_HINT);
  if ((req.body.password || '').length < MIN_PASSWORD_LENGTH) {
    return fail(400, `Passordet må være minst ${MIN_PASSWORD_LENGTH} tegn.`);
  }
  if (req.body.password !== req.body.passwordConfirm) return fail(400, 'Passordene er ikke like.');
  if (values.reason.length > 500) return fail(400, 'Begrunnelsen kan være maks 500 tegn.');
  if (AdminRequests.usernameTaken(values.username)) {
    return fail(409, 'Brukernavnet er opptatt. Har du allerede en konto, logg inn og be om tilgang under «Min konto».');
  }
  if (AdminRequests.countPending(org.id) >= MAX_PENDING_REQUESTS) {
    return fail(503, 'Det ligger mange ubehandlede forespørsler i køen. Prøv igjen senere.');
  }

  requestLimiter.hit(req.ip);
  const request = AdminRequests.create({
    organizationId: org.id,
    name: values.name,
    email: values.email,
    username: values.username,
    reason: values.reason,
    passwordHash: bcrypt.hashSync(req.body.password, 12),
  });
  audit.byVisitor(req, 'access.requested', `${request.name} ba om tilgang som «${request.username}»`, {
    type: 'request',
    id: request.id,
    orgId: org.id,
  }, request.name);
  mailer
    .notifyNewAccessRequest(request, org, Memberships.adminEmails(org.id))
    .catch((err) => console.error('Kunne ikke varsle om ny tilgangsforespørsel:', err));
  res.render('admin/request-sent', { org });
});

// --- Alt under her krever innlogging ---
router.use(requireAdmin);

const SECTIONS = [
  [/^\/(tilgang|brukere)/, 'access', '/admin/tilgang'],
  [/^\/(konto|nytt-passord)/, 'account', '/admin/konto'],
  [/^\/(rom|sperringer)/, 'rooms', '/admin/rom'],
  [/^\/(logg|personvern)/, 'audit', '/admin/logg'],
  [/^\/rapporter/, 'reports', '/admin/rapporter'],
  [/^\/plattform/, 'platform', '/admin/plattform'],
];

router.use((req, res, next) => {
  const match = SECTIONS.find(([re]) => re.test(req.path));
  res.locals.section = match ? match[1] : 'bookings';
  res.locals.adminId = req.admin.id;
  res.locals.me = req.admin;
  res.locals.org = req.org;
  res.locals.orgs = req.orgs;
  res.locals.pendingCount = req.org && can(req.admin, 'access.manage') ? AdminRequests.countPending(req.org.id) : 0;
  res.locals.can = (permission) => can(req.admin, permission);
  res.locals.roleLabel = roleLabel;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// Bytt aktiv bedrift. Man havner på samme type side i den nye bedriften (ikke på et rom i den gamle).
router.post('/bedrift', (req, res) => {
  const org = req.orgs.find((o) => String(o.id) === String(req.body.org));
  if (!org) return res.status(404).render('public/not-found');
  req.session.activeOrgId = org.id;
  const section = SECTIONS.find(([, name]) => name === req.body.section);
  res.redirect(section && section[1] !== 'platform' ? section[2] : '/admin');
});

// Konto og plattform trenger ingen aktiv bedrift.
router.use(require('./account'));
router.use(require('./platform'));

// Resten jobber alltid i den aktive bedriften.
router.use(requireOrg);
router.use(require('./bookings'));
router.use(require('./rooms'));
router.use(require('./access'));
router.use(require('./records').router);

module.exports = router;
