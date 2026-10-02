// Egen konto: opplysninger, passord, og hvilke bedrifter man tilhører.
const express = require('express');
const bcrypt = require('bcryptjs');
const { AdminUsers, AdminRequests, Memberships, Organizations } = require('../../models');
const mailer = require('../../services/mailer');
const { createLimiter } = require('../../middleware/rate-limit');
const audit = require('../../audit');
const { flash, profileInput, profileError, passwordError } = require('./helpers');

const router = express.Router();
const passwordLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

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
  audit.byAdmin(req, 'access.password_changed', `${req.admin.username} valgte nytt passord`, {
    type: 'admin',
    id: req.admin.id,
    orgId: null,
  });
  flash(req, 'success', 'Nytt passord er lagret. Velkommen.');
  res.redirect('/admin');
});

function renderAccount(req, res, { profileError: pErr = null, passwordError: pwErr = null, joinError = null, values = null, status = 200 } = {}) {
  const memberships = Memberships.forUser(req.admin.id);
  const memberOf = new Set(memberships.map((m) => m.organization_id));
  const joinable = req.admin.is_platform_admin
    ? []
    : Organizations.active().filter((o) => !memberOf.has(o.id) && !AdminRequests.pendingForUser(req.admin.id, o.id));
  res.status(status).render('admin/account', {
    values: values || req.admin,
    profileError: pErr,
    passwordError: pwErr,
    joinError,
    memberships,
    joinable,
  });
}

router.get('/konto', (req, res) => renderAccount(req, res));

router.post('/konto', (req, res) => {
  const input = profileInput(req.body);
  const error = profileError(input, req.admin.id);
  if (error) return renderAccount(req, res, { profileError: error, values: input, status: 400 });
  AdminUsers.update(req.admin.id, input);
  audit.byAdmin(req, 'access.account_updated', `${input.username} endret egne kontoopplysninger`, {
    type: 'admin',
    id: req.admin.id,
    orgId: null,
  });
  flash(req, 'success', 'Kontoopplysningene er lagret.');
  res.redirect('/admin/konto');
});

router.post('/konto/passord', (req, res) => {
  const key = `pw:${req.admin.id}`;
  const fail = (status, message) => renderAccount(req, res, { passwordError: message, status });

  if (passwordLimiter.isLimited(key)) return fail(429, 'For mange feil forsøk. Vent et kvarter og prøv igjen.');
  if (!bcrypt.compareSync(req.body.currentPassword || '', req.admin.password_hash)) {
    passwordLimiter.hit(key);
    return fail(400, 'Nåværende passord er feil.');
  }
  const error = passwordError(req.body.password, req.body.passwordConfirm);
  if (error) return fail(400, error);

  passwordLimiter.reset(key);
  changeOwnPassword(req, req.body.password);
  audit.byAdmin(req, 'access.password_changed', `${req.admin.username} byttet passord`, {
    type: 'admin',
    id: req.admin.id,
    orgId: null,
  });
  flash(req, 'success', 'Passordet er byttet. Andre enheter der du var innlogget, er logget ut.');
  res.redirect('/admin/konto');
});

// Be om tilgang til en bedrift til, med samme konto. Bedriftens administratorer godkjenner.
router.post('/konto/bedrifter', (req, res) => {
  const org = Organizations.get(Number(req.body.organization));
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (!org || !org.active || Memberships.get(req.admin.id, org.id) || AdminRequests.pendingForUser(req.admin.id, org.id)) {
    return renderAccount(req, res, { joinError: 'Velg en bedrift du ikke allerede er med i.', status: 400 });
  }
  const request = AdminRequests.create({
    organizationId: org.id,
    userId: req.admin.id,
    name: req.admin.name || req.admin.username,
    email: req.admin.email || '',
    username: req.admin.username,
    reason,
  });
  audit.byAdmin(req, 'access.requested', `${req.admin.username} ba om tilgang til ${org.name}`, {
    type: 'request',
    id: request.id,
    orgId: org.id,
  });
  mailer
    .notifyNewAccessRequest(request, org, Memberships.adminEmails(org.id))
    .catch((err) => console.error('Kunne ikke varsle om ny tilgangsforespørsel:', err));
  flash(req, 'success', `Forespørselen er sendt til administratorene i ${org.name}.`);
  res.redirect('/admin/konto');
});

module.exports = router;
