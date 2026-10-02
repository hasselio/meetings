// Plattformnivået: bedrifter, plattformadministratorer og samlet revisjonslogg.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const { AdminUsers, Memberships, Organizations } = require('../../models');
const mailer = require('../../services/mailer');
const { requirePermission } = require('../../roles');
const audit = require('../../audit');
const { slugify, isSlug } = require('../../slug');
const { notFound, flash, profileInput, profileError, temporaryPassword } = require('./helpers');
const { renderAudit } = require('./records');

const router = express.Router();
router.use('/plattform', requirePermission('platform.manage'));

// Bedriftshendelser føres i plattformloggen (orgId: null), men nevner bedriften.
const platformLog = (req, action, summary, target = {}) => audit.byAdmin(req, action, summary, { ...target, orgId: null });

function uniqueSlug(base, exceptId = 0) {
  let slug = base;
  for (let i = 2; Organizations.slugTaken(slug, exceptId); i++) slug = `${base.slice(0, 36)}-${i}`;
  return slug;
}

function renderPlatform(req, res, { values = {}, error = null, status = 200 } = {}) {
  res.status(status).render('admin/platform', {
    organizations: Organizations.all(),
    platformAdmins: AdminUsers.platformAdmins(),
    values,
    error,
    canEmail: mailer.canSend(),
  });
}

router.get('/plattform', (req, res) => renderPlatform(req, res));

// Ny bedrift, eventuelt med første administrator. Finnes brukernavnet, legges den kontoen til;
// ellers opprettes en ny konto med midlertidig passord.
router.post('/plattform/bedrifter', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const requestedSlug = String(req.body.slug || '').trim().toLowerCase();
  const admin = profileInput({ name: req.body.adminName, email: req.body.adminEmail, username: req.body.adminUsername });
  const values = { name, slug: requestedSlug, adminName: admin.name, adminEmail: admin.email, adminUsername: admin.username };
  const fail = (error) => renderPlatform(req, res, { values, error, status: 400 });

  if (!name) return fail('Gi bedriften et navn.');
  if (requestedSlug && !isSlug(requestedSlug)) return fail('Adressen kan bare inneholde små bokstaver, tall og bindestrek.');
  if (requestedSlug && Organizations.slugTaken(requestedSlug)) return fail(`Adressen /b/${requestedSlug} er allerede i bruk.`);

  const existing = admin.username ? AdminUsers.findByUsername(admin.username) : null;
  if (admin.username && !existing) {
    const error = profileError(admin);
    if (error) return fail(error);
  }

  const password = admin.username && !existing ? temporaryPassword() : null;
  const { org, user } = db.transaction(() => {
    const created = Organizations.create({ name, slug: requestedSlug || uniqueSlug(slugify(name)) });
    let member = existing;
    if (password) {
      member = AdminUsers.create({ ...admin, passwordHash: bcrypt.hashSync(password, 12), mustChangePassword: true });
    }
    if (member) Memberships.add(member.id, created.id, 'admin');
    return { org: created, user: member };
  })();

  platformLog(req, 'platform.org_created', `Opprettet bedriften ${org.name} (/b/${org.slug})${user ? ` med «${user.username}» som administrator` : ''}`, {
    type: 'organization',
    id: org.id,
  });

  if (password) {
    let mailed = false;
    if (req.body.sendEmail && user.email) {
      try {
        mailed = (await mailer.notifyAccountCreated(user, password, org)).sent;
      } catch (err) {
        console.error('Kunne ikke sende e-post om ny konto:', err);
      }
    }
    res.set('Cache-Control', 'no-store');
    return res.render('admin/password-reset', {
      target: user,
      password,
      mailed,
      triedMail: Boolean(req.body.sendEmail),
      created: true,
      doneHref: '/admin/plattform',
      orgName: org.name,
    });
  }
  flash(req, 'success', `${org.name} er opprettet.${user ? ` «${user.username}» er administrator.` : ' Legg til en administrator under «Administrer».'}`);
  res.redirect('/admin/plattform');
});

function loadOrg(req, res, next) {
  const org = Organizations.get(Number(req.params.id));
  if (!org) return notFound(res);
  req.target = org;
  next();
}

function renderOrg(req, res, { values = null, error = null, status = 200 } = {}) {
  const org = Organizations.all().find((o) => o.id === req.target.id);
  res.status(status).render('admin/platform-org', {
    target: org,
    values: values || org,
    error,
    members: Memberships.forOrg(org.id),
  });
}

router.get('/plattform/bedrifter/:id', loadOrg, (req, res) => renderOrg(req, res));

router.post('/plattform/bedrifter/:id', loadOrg, (req, res) => {
  const org = req.target;
  const values = {
    name: String(req.body.name || '').trim().slice(0, 80),
    slug: String(req.body.slug || '').trim().toLowerCase(),
    active: Boolean(req.body.active),
  };
  const fail = (error) => renderOrg(req, res, { values, error, status: 400 });
  if (!values.name) return fail('Gi bedriften et navn.');
  if (!isSlug(values.slug)) return fail('Adressen kan bare inneholde små bokstaver, tall og bindestrek.');
  if (Organizations.slugTaken(values.slug, org.id)) return fail(`Adressen /b/${values.slug} er allerede i bruk.`);

  Organizations.update(org.id, values);
  const changes = [];
  if (values.name !== org.name) changes.push(`navn til ${values.name}`);
  if (values.slug !== org.slug) changes.push(`adresse til /b/${values.slug}`);
  if (values.active !== Boolean(org.active)) changes.push(values.active ? 'aktivert' : 'deaktivert');
  platformLog(req, 'platform.org_updated', `Endret ${org.name}: ${changes.join(', ') || 'ingen endringer'}`, {
    type: 'organization',
    id: org.id,
  });
  flash(
    req,
    'success',
    !values.active && org.active
      ? `${values.name} er deaktivert. Rommene er skjult, og brukerne kan ikke logge inn.`
      : `Endringene for ${values.name} er lagret.`
  );
  res.redirect('/admin/plattform');
});

// Bare tomme bedrifter kan slettes. Brukere som da står uten bedrift, slettes også.
router.post('/plattform/bedrifter/:id/slett', loadOrg, (req, res) => {
  const org = Organizations.all().find((o) => o.id === req.target.id);
  if (org.room_count > 0) {
    flash(req, 'error', `${org.name} har rom. Slett rommene eller deaktiver bedriften i stedet.`);
    return res.redirect(`/admin/plattform/bedrifter/${org.id}`);
  }
  const memberIds = Memberships.forOrg(org.id).map((m) => m.id);
  const removedUsers = db.transaction(() => {
    Organizations.delete(org.id);
    let n = 0;
    for (const id of memberIds) {
      const user = AdminUsers.findById(id);
      if (user && !user.is_platform_admin && Memberships.count(id) === 0) {
        AdminUsers.delete(id);
        n++;
      }
    }
    return n;
  })();
  platformLog(req, 'platform.org_deleted', `Slettet bedriften ${org.name}${removedUsers ? ` og ${removedUsers} konto(er) uten annen tilgang` : ''}`, {
    type: 'organization',
    id: org.id,
  });
  flash(req, 'success', `${org.name} er slettet.`);
  res.redirect('/admin/plattform');
});

// Gå inn i en bedrift for å administrere brukere, rom og bookinger der.
router.post('/plattform/bedrifter/:id/administrer', loadOrg, (req, res) => {
  req.session.activeOrgId = req.target.id;
  res.redirect('/admin/tilgang');
});

router.post('/plattform/administratorer', (req, res) => {
  const user = AdminUsers.findByUsername(String(req.body.username || '').trim());
  if (!user) {
    flash(req, 'error', 'Fant ingen bruker med det brukernavnet.');
  } else if (user.is_platform_admin) {
    flash(req, 'error', `«${user.username}» er allerede plattformadministrator.`);
  } else {
    AdminUsers.setPlatformAdmin(user.id, true);
    platformLog(req, 'platform.admin_granted', `Gjorde «${user.username}» til plattformadministrator`, { type: 'admin', id: user.id });
    flash(req, 'success', `«${user.username}» er nå plattformadministrator.`);
  }
  res.redirect('/admin/plattform');
});

router.post('/plattform/administratorer/:id/fjern', (req, res) => {
  const user = AdminUsers.findById(Number(req.params.id));
  if (!user || !user.is_platform_admin) return notFound(res);
  if (user.id === req.admin.id) {
    flash(req, 'error', 'Du kan ikke fjerne din egen plattformtilgang. Be en annen plattformadministrator om det.');
  } else if (AdminUsers.countPlatformAdmins() <= 1) {
    flash(req, 'error', 'Det må finnes minst én plattformadministrator.');
  } else {
    AdminUsers.setPlatformAdmin(user.id, false);
    platformLog(req, 'platform.admin_revoked', `Fjernet plattformtilgangen til «${user.username}»`, { type: 'admin', id: user.id });
    const left = Memberships.count(user.id);
    flash(
      req,
      'success',
      left
        ? `«${user.username}» er ikke lenger plattformadministrator, men har fortsatt tilgang til ${left} bedrift(er).`
        : `«${user.username}» er ikke lenger plattformadministrator og er ikke med i noen bedrift, så hen kan ikke logge inn.`
    );
  }
  res.redirect('/admin/plattform');
});

router.get('/plattform/logg', (req, res) =>
  renderAudit(req, res, { orgId: null, categories: audit.CATEGORIES, basePath: '/admin/plattform/logg', platform: true })
);

module.exports = router;
