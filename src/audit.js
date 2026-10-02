const db = require('./db');

// Kategorier for filteret på loggsiden; handlingene navngis «kategori.handling».
const CATEGORIES = {
  booking: 'Bookinger',
  room: 'Rom og sperringer',
  access: 'Tilgang og kontoer',
  login: 'Innlogging',
  platform: 'Bedrifter og plattform',
  report: 'Rapporter og eksport',
};

const insert = db.prepare(
  `INSERT INTO audit_log (organization_id, actor_type, actor_id, actor_name, action, target_type, target_id, summary, ip)
   VALUES (@organizationId, @actorType, @actorId, @actorName, @action, @targetType, @targetId, @summary, @ip)`
);

// organizationId = bedriften hendelsen gjelder; null for hendelser på plattformnivå (innlogging, bedrifter).
function log({
  organizationId = null,
  actorType = 'system',
  actorId = null,
  actorName = null,
  action,
  targetType = null,
  targetId = null,
  summary,
  ip = null,
}) {
  insert.run({ organizationId, actorType, actorId, actorName, action, targetType, targetId, summary, ip });
}

// Logger en handling gjort av innlogget bruker. Hendelsen knyttes til den aktive bedriften,
// med mindre target.orgId sier noe annet (null = plattformnivå).
function byAdmin(req, action, summary, target = {}) {
  log({
    organizationId: target.orgId !== undefined ? target.orgId : req.org ? req.org.id : null,
    actorType: 'admin',
    actorId: req.admin && req.admin.id,
    actorName: req.admin && req.admin.username,
    action,
    targetType: target.type || null,
    targetId: target.id || null,
    summary,
    ip: req.ip,
  });
}

// Logger en handling gjort av en besøkende (f.eks. den som booket, via lenken i e-posten).
function byVisitor(req, action, summary, target = {}, name = null) {
  log({
    organizationId: target.orgId || null,
    actorType: 'visitor',
    actorName: name,
    action,
    targetType: target.type || null,
    targetId: target.id || null,
    summary,
    ip: req && req.ip,
  });
}

// orgId = null gir hele loggen (plattformnivå), ellers bare bedriftens hendelser.
function list({ category = null, orgId = null, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (category && CATEGORIES[category]) {
    conditions.push('a.action LIKE ?');
    params.push(`${category}.%`);
  }
  if (orgId) {
    conditions.push('a.organization_id = ?');
    params.push(orgId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT a.*, o.name AS organization_name FROM audit_log a LEFT JOIN organizations o ON o.id = a.organization_id
       ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${where}`).get(...params).n;
  return { rows, total };
}

function deleteOlderThan(months) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff.toISOString()).changes;
}

module.exports = { CATEGORIES, log, byAdmin, byVisitor, list, deleteOlderThan };
