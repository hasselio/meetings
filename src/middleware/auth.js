const { AdminUsers } = require('../models');

// Sider en admin med midlertidig passord fortsatt kan nå.
const ALLOWED_WHILE_MUST_CHANGE = new Set(['/nytt-passord']);

// Gyldig innlogget admin for denne økten, eller null. Økten er ugyldig hvis kontoen er slettet,
// eller passordet er byttet/tilbakestilt etter at økten ble opprettet.
function currentAdmin(req) {
  const user = req.session && req.session.adminId && AdminUsers.findById(req.session.adminId);
  if (!user || user.session_version !== (req.session.sessionVersion || 0)) return null;
  return user;
}

function requireAdmin(req, res, next) {
  const user = currentAdmin(req);
  if (!user) {
    if (!req.session || !req.session.adminId) return res.redirect('/admin/login');
    return req.session.destroy(() => res.redirect('/admin/login'));
  }

  if (user.must_change_password && !ALLOWED_WHILE_MUST_CHANGE.has(req.path)) {
    return res.redirect('/admin/nytt-passord');
  }

  req.admin = user;
  next();
}

module.exports = { requireAdmin, currentAdmin };
