// Brukergruppen i den aktive bedriften: søknader, medlemmer og roller.
const express = require('express');
const bcrypt = require('bcryptjs');
const { AdminUsers, AdminRequests, Memberships } = require('../../models');
const { ROLES, isRole, roleLabel, requirePermission } = require('../../roles');
const audit = require('../../audit');
const config = require('../../config');
const mailer = require('../../services/mailer');
const { notFound, flash, profileInput, profileError, temporaryPassword, canManageAccount } = require('./helpers');

const router = express.Router();

router.use(['/tilgang', '/brukere'], requirePermission('access.manage'));

function renderAccess(req, res, { createValues = {}, createError = null, status = 200 } = {}) {
  res.status(status).render('admin/access', {
    roles: ROLES,
    requests: AdminRequests.pending(req.org.id),
    members: Memberships.forOrg(req.org.id),
    decisions: AdminRequests.recentDecisions(req.org.id),
    timezone: config.timezone,
    canEmail: mailer.canSend(),
    createValues,
    createError,
  });
}

router.get('/tilgang', (req, res) => renderAccess(req, res));

function decide(approve) {
  return (req, res) => {
    const role = isRole(req.body.role) ? req.body.role : 'viewer';
    // Modellen sjekker at søknaden tilhører denne bedriften.
    const result = approve
      ? AdminRequests.approve(Number(req.params.id), req.org.id, req.admin.id, role)
      : AdminRequests.decline(Number(req.params.id), req.org.id, req.admin.id);

    if (result.error) {
      flash(req, 'error', result.error);
      return res.redirect('/admin/tilgang');
    }

    const { request } = result;
    audit.byAdmin(
      req,
      approve ? 'access.approved' : 'access.declined',
      approve
        ? `Godkjente ${request.name} («${request.username}») som ${roleLabel(role).toLowerCase()}`
        : `Avslo forespørselen fra ${request.name} («${request.username}»)`,
      { type: 'request', id: request.id }
    );
    flash(
      req,
      'success',
      approve
        ? `${request.name} har fått tilgang som «${request.username}» med rollen ${roleLabel(role).toLowerCase()}.`
        : `Forespørselen fra ${request.name} er avslått.`
    );
    mailer.notifyAccessDecision(request, approve, req.org).catch((err) => console.error('Kunne ikke sende svar på tilgangsforespørsel:', err));
    res.redirect('/admin/tilgang');
  };
}

router.post('/tilgang/:id/godkjenn', decide(true));
router.post('/tilgang/:id/avsla', decide(false));

// Ny bruker direkte i bedriften, med midlertidig passord som må byttes ved første innlogging.
router.post('/brukere', async (req, res) => {
  const input = profileInput(req.body);
  const role = isRole(req.body.role) ? req.body.role : 'viewer';
  const fail = (error) => renderAccess(req, res, { createValues: { ...input, role }, createError: error, status: 400 });
  const error = profileError(input);
  if (error) return fail(error);

  const password = temporaryPassword();
  const user = AdminUsers.create({ ...input, passwordHash: bcrypt.hashSync(password, 12), mustChangePassword: true });
  Memberships.add(user.id, req.org.id, role);
  audit.byAdmin(req, 'access.user_created', `Opprettet brukeren «${user.username}» som ${roleLabel(role).toLowerCase()}`, {
    type: 'admin',
    id: user.id,
  });

  let mailed = false;
  if (req.body.sendEmail && user.email) {
    try {
      mailed = (await mailer.notifyAccountCreated(user, password, req.org)).sent;
    } catch (err) {
      console.error('Kunne ikke sende e-post om ny konto:', err);
    }
  }
  res.set('Cache-Control', 'no-store');
  res.render('admin/password-reset', { target: user, password, mailed, triedMail: Boolean(req.body.sendEmail), created: true });
});

// Plattformadministratorer kan legge en eksisterende bruker til i bedriften (f.eks. en konsulent).
router.post('/brukere/eksisterende', requirePermission('platform.manage'), (req, res) => {
  const user = AdminUsers.findByUsername(String(req.body.username || '').trim());
  const role = isRole(req.body.role) ? req.body.role : 'viewer';
  if (!user) {
    flash(req, 'error', 'Fant ingen bruker med det brukernavnet.');
  } else if (Memberships.get(user.id, req.org.id)) {
    flash(req, 'error', `«${user.username}» er allerede med i ${req.org.name}.`);
  } else {
    Memberships.add(user.id, req.org.id, role);
    audit.byAdmin(req, 'access.member_added', `La til «${user.username}» som ${roleLabel(role).toLowerCase()}`, {
      type: 'admin',
      id: user.id,
    });
    flash(req, 'success', `«${user.username}» er lagt til i ${req.org.name} som ${roleLabel(role).toLowerCase()}.`);
  }
  res.redirect('/admin/tilgang');
});

// Medlemmet bare hvis det tilhører den aktive bedriften.
function loadMember(req, res, next) {
  const target = AdminUsers.findById(Number(req.params.id));
  const membership = target && Memberships.get(target.id, req.org.id);
  if (!membership) return notFound(res);
  if (target.id === req.admin.id) return res.redirect('/admin/konto');
  req.target = { ...target, role: membership.role };
  next();
}

function renderMember(req, res, { error = null, values = null, status = 200 } = {}) {
  const others = Memberships.forUser(req.target.id).filter((m) => m.organization_id !== req.org.id);
  res.status(status).render('admin/admin-edit', {
    target: req.target,
    values: values || req.target,
    error,
    roles: ROLES,
    editable: canManageAccount(req, req.target),
    otherOrgs: others,
    adminCount: Memberships.countAdmins(req.org.id),
    canEmail: mailer.canSend(),
  });
}

router.get('/brukere/:id', loadMember, (req, res) => renderMember(req, res));

router.post('/brukere/:id', loadMember, (req, res) => {
  const { target } = req;
  const role = isRole(req.body.role) ? req.body.role : target.role;
  const editable = canManageAccount(req, target);
  const input = editable ? profileInput(req.body) : null;

  let error = input ? profileError(input, target.id) : null;
  // En bedrift skal aldri stå uten administrator.
  if (!error && target.role === 'admin' && role !== 'admin' && Memberships.countAdmins(req.org.id) <= 1) {
    error = `${req.org.name} må ha minst én administrator.`;
  }
  if (error) return renderMember(req, res, { error, values: { ...(input || target), role }, status: 400 });

  if (input) {
    AdminUsers.update(target.id, input);
    audit.byAdmin(req, 'access.account_updated', `Endret kontoopplysningene til «${input.username}»`, { type: 'admin', id: target.id });
  }
  if (role !== target.role) {
    Memberships.setRole(target.id, req.org.id, role);
    audit.byAdmin(
      req,
      'access.role_changed',
      `Endret rollen til «${target.username}» fra ${roleLabel(target.role).toLowerCase()} til ${roleLabel(role).toLowerCase()}`,
      { type: 'admin', id: target.id }
    );
  }
  flash(req, 'success', `Endringene for «${input ? input.username : target.username}» er lagret.`);
  res.redirect('/admin/tilgang');
});

router.post('/brukere/:id/tilbakestill', loadMember, async (req, res) => {
  const { target } = req;
  if (!canManageAccount(req, target)) return res.status(403).render('admin/forbidden');

  const password = temporaryPassword();
  // Logger samtidig ut alle aktive økter for kontoen.
  AdminUsers.setPassword(target.id, bcrypt.hashSync(password, 12), { mustChange: true });
  audit.byAdmin(req, 'access.password_reset', `Tilbakestilte passordet til «${target.username}»`, { type: 'admin', id: target.id });

  let mailed = false;
  if (req.body.sendEmail && target.email) {
    try {
      mailed = (await mailer.notifyPasswordReset(target, password)).sent;
    } catch (err) {
      console.error('Kunne ikke sende midlertidig passord:', err);
    }
  }
  // Det midlertidige passordet skal ikke kunne hentes fra nettleserens hurtigbuffer senere.
  res.set('Cache-Control', 'no-store');
  res.render('admin/password-reset', { target, password, mailed, triedMail: Boolean(req.body.sendEmail), created: false });
});

// Fjerner brukeren fra bedriften. Er hen ikke med i noen andre bedrifter, slettes kontoen.
router.post('/brukere/:id/fjern', loadMember, (req, res) => {
  const { target } = req;
  if (target.role === 'admin' && Memberships.countAdmins(req.org.id) <= 1) {
    flash(req, 'error', `${req.org.name} må ha minst én administrator.`);
    return res.redirect(`/admin/brukere/${target.id}`);
  }
  Memberships.remove(target.id, req.org.id);
  const deleted = !target.is_platform_admin && Memberships.count(target.id) === 0;
  if (deleted) AdminUsers.delete(target.id);
  audit.byAdmin(
    req,
    'access.removed',
    `Fjernet «${target.username}» fra bedriften${deleted ? ' (kontoen ble slettet)' : ''}`,
    { type: 'admin', id: target.id }
  );
  flash(req, 'success', `«${target.username}» har ikke lenger tilgang til ${req.org.name}.`);
  res.redirect('/admin/tilgang');
});

module.exports = router;
