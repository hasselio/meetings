// Rollene gjelder innenfor én bedrift. Plattformadministratorer (admin_users.is_platform_admin)
// står over bedriftene og har rollen administrator i alle.
const ROLES = {
  admin: {
    label: 'Administrator',
    description: 'Alt i bedriften, inkludert brukere, revisjonslogg og sletting av personopplysninger.',
  },
  manager: {
    label: 'Romansvarlig',
    description: 'Bookinger, rom, sperrede perioder og rapporter. Ikke tilgangsstyring.',
  },
  viewer: {
    label: 'Lesetilgang',
    description: 'Kan se bookinger, rom og rapporter, men ikke endre noe.',
  },
};

const PERMISSIONS = {
  'bookings.view': ['admin', 'manager', 'viewer'],
  'bookings.manage': ['admin', 'manager'],
  'rooms.manage': ['admin', 'manager'],
  'reports.view': ['admin', 'manager', 'viewer'],
  'reports.export': ['admin', 'manager'],
  'access.manage': ['admin'],
  'audit.view': ['admin'],
  'privacy.manage': ['admin'],
};

const isRole = (role) => Object.prototype.hasOwnProperty.call(ROLES, role);

// user.role er rollen i den aktive bedriften (settes av requireAdmin).
function can(user, permission) {
  if (!user) return false;
  if (permission === 'platform.manage') return Boolean(user.is_platform_admin);
  return (PERMISSIONS[permission] || []).includes(user.role);
}
const roleLabel = (role) => (ROLES[role] ? ROLES[role].label : role);

function requirePermission(permission) {
  return (req, res, next) => {
    if (can(req.admin, permission)) return next();
    if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
      return res.status(403).json({ error: 'Du har ikke tilgang til dette.' });
    }
    return res.status(403).render('admin/forbidden');
  };
}

module.exports = { ROLES, PERMISSIONS, isRole, can, roleLabel, requirePermission };
