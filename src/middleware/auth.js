const { AdminUsers } = require('../models');

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId && AdminUsers.findById(req.session.adminId)) {
    return next();
  }
  return res.redirect('/admin/login');
}

module.exports = { requireAdmin };
