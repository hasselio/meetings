const ROLES = {
  admin: {
    label: 'Administrator',
    description: 'Alt, inkludert tilgangsstyring, kontoer og revisjonslogg.',
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
const can = (user, permission) => Boolean(user && (PERMISSIONS[permission] || []).includes(user.role));
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
