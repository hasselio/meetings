const db = require('./db');

// Kategorier for filteret på loggsiden; handlingene navngis «kategori.handling».
const CATEGORIES = {
  booking: 'Bookinger',
  room: 'Rom og sperringer',
  access: 'Tilgang og kontoer',
  login: 'Innlogging',
  report: 'Rapporter og eksport',
};

const insert = db.prepare(
  `INSERT INTO audit_log (actor_type, actor_id, actor_name, action, target_type, target_id, summary, ip)
   VALUES (@actorType, @actorId, @actorName, @action, @targetType, @targetId, @summary, @ip)`
);

function log({ actorType = 'system', actorId = null, actorName = null, action, targetType = null, targetId = null, summary, ip = null }) {
  insert.run({ actorType, actorId, actorName, action, targetType, targetId, summary, ip });
}

// Logger en handling gjort av innlogget admin i denne forespørselen.
function byAdmin(req, action, summary, target = {}) {
  log({
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
    actorType: 'visitor',
    actorName: name,
    action,
    targetType: target.type || null,
    targetId: target.id || null,
    summary,
    ip: req && req.ip,
  });
}

function list({ category = null, limit = 100, offset = 0 } = {}) {
  const where = category && CATEGORIES[category] ? `WHERE action LIKE ?` : '';
  const params = where ? [`${category}.%`] : [];
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...params).n;
  return { rows, total };
}

function deleteOlderThan(months) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff.toISOString()).changes;
}

module.exports = { CATEGORIES, log, byAdmin, byVisitor, list, deleteOlderThan };
