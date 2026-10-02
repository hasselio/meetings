const { AdminUsers, Memberships, Organizations } = require('../models');

// Sider en bruker med midlertidig passord fortsatt kan nå.
const ALLOWED_WHILE_MUST_CHANGE = new Set(['/nytt-passord']);

// Gyldig innlogget bruker for denne økten, eller null. Økten er ugyldig hvis kontoen er slettet,
// eller passordet er byttet/tilbakestilt etter at økten ble opprettet.
function currentAdmin(req) {
  const user = req.session && req.session.adminId && AdminUsers.findById(req.session.adminId);
  if (!user || user.session_version !== (req.session.sessionVersion || 0)) return null;
  return user;
}

// Bedriftene brukeren kan jobbe i, med rollen i hver. Plattformadministratorer kan gå inn i alle
// bedrifter (også deaktiverte) som administrator; andre bare i aktive bedrifter de er medlem av.
function availableOrgs(user) {
  if (user.is_platform_admin) return Organizations.all().map((o) => ({ ...o, role: 'admin' }));
  return Memberships.forUser(user.id)
    .filter((m) => m.active)
    .map((m) => ({ id: m.organization_id, name: m.name, slug: m.slug, active: m.active, role: m.role }));
}

function requireAdmin(req, res, next) {
  const user = currentAdmin(req);
  if (!user) {
    if (!req.session || !req.session.adminId) return res.redirect('/admin/login');
    return req.session.destroy(() => res.redirect('/admin/login'));
  }

  const orgs = availableOrgs(user);
  // Fjernet fra sin siste bedrift, eller bedriften er deaktivert: logg ut.
  if (!user.is_platform_admin && orgs.length === 0) {
    return req.session.destroy(() => res.redirect('/admin/login?melding=ingen-bedrift'));
  }

  // Den aktive bedriften huskes i økten. Rollen gjelder bare i den bedriften.
  const org = orgs.find((o) => o.id === req.session.activeOrgId) || orgs[0] || null;
  if (org && req.session.activeOrgId !== org.id) req.session.activeOrgId = org.id;
  req.orgs = orgs;
  req.org = org;
  req.admin = { ...user, role: org ? org.role : null };

  if (user.must_change_password && !ALLOWED_WHILE_MUST_CHANGE.has(req.path)) {
    return res.redirect('/admin/nytt-passord');
  }
  next();
}

// For sider som jobber i en bedrift. En plattformadministrator uten bedrifter sendes til plattformsiden.
function requireOrg(req, res, next) {
  if (req.org) return next();
  return res.redirect('/admin/plattform');
}

module.exports = { requireAdmin, requireOrg, currentAdmin, availableOrgs };
