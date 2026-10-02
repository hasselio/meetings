// Revisjonslogg, rapporter og innsyn/sletting – alltid for den aktive bedriften.
const express = require('express');
const { Bookings } = require('../../models');
const BookingService = require('../../services/bookings');
const { requirePermission } = require('../../roles');
const audit = require('../../audit');
const time = require('../../time');
const Recurrence = require('../../recurrence');
const Reports = require('../../reports');
const config = require('../../config');
const { EMAIL_RE } = require('./helpers');

const router = express.Router();

// --- Revisjonslogg ---
const AUDIT_PAGE_SIZE = 50;
// Innlogginger og bedriftsadministrasjon føres på plattformnivå, ikke i bedriftens logg.
const ORG_CATEGORIES = Object.fromEntries(
  Object.entries(audit.CATEGORIES).filter(([key]) => key !== 'login' && key !== 'platform')
);

function renderAudit(req, res, { orgId, categories, basePath, platform }) {
  const category = categories[req.query.kategori] ? req.query.kategori : null;
  const page = Math.max(1, parseInt(req.query.side, 10) || 1);
  const { rows, total } = audit.list({ category, orgId, limit: AUDIT_PAGE_SIZE, offset: (page - 1) * AUDIT_PAGE_SIZE });
  res.render('admin/audit', {
    entries: rows,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)),
    category,
    categories,
    basePath,
    platform,
    retentionMonths: config.auditRetentionMonths,
    timezone: config.timezone,
  });
}

router.get('/logg', requirePermission('audit.view'), (req, res) =>
  renderAudit(req, res, { orgId: req.org.id, categories: ORG_CATEGORIES, basePath: '/admin/logg', platform: false })
);

// --- Rapporter ---
const PRESETS = [
  ['siste-4-uker', 'Siste 4 uker'],
  ['denne-maned', 'Denne måneden'],
  ['forrige-maned', 'Forrige måned'],
  ['3-maneder', 'Siste 3 måneder'],
];

const reportRange = (req) => Reports.resolveRange({ preset: req.query.preset, from: req.query.fra, to: req.query.til });

router.get('/rapporter', requirePermission('reports.view'), (req, res) => {
  const range = reportRange(req);
  const report = Reports.utilization(range, req.org.id);
  const from = Reports.dateKey(range.from);
  const to = Reports.dateKey(range.to);
  res.render('admin/reports', {
    report,
    presets: PRESETS,
    preset: range.preset,
    from,
    to,
    query: `fra=${from}&til=${to}`,
    periodLabel: `${time.formatDate(report.start)} – ${time.formatDate(new Date(new Date(report.end).getTime() - 1))}`,
    decimal: Reports.decimal,
  });
});

function sendCsv(res, filename, csv) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Cache-Control', 'no-store');
  res.send(csv);
}

router.get('/rapporter/utnyttelse.csv', requirePermission('reports.export'), (req, res) => {
  const range = reportRange(req);
  const { rooms, totals } = Reports.utilization(range, req.org.id);
  const pct = (n) => Reports.decimal(n * 100);
  const rows = rooms.map((r) => [
    r.name,
    r.bookings,
    r.cancelled,
    Reports.decimal(r.bookedHours),
    Reports.decimal(r.availableHours),
    pct(r.utilization),
    Math.round(r.avgMinutes),
  ]);
  rows.push(['Totalt', totals.bookings, totals.cancelled, Reports.decimal(totals.bookedHours), Reports.decimal(totals.availableHours), pct(totals.utilization), '']);
  const period = `${Reports.dateKey(range.from)}_${Reports.dateKey(range.to)}`;
  audit.byAdmin(req, 'report.exported', `Eksporterte utnyttelse per rom for ${period.replace('_', '–')}`);
  sendCsv(
    res,
    `utnyttelse_${req.org.slug}_${period}.csv`,
    Reports.toCsv(['Rom', 'Bookinger', 'Avlyst', 'Bookede timer', 'Tilgjengelige timer', 'Utnyttelse (%)', 'Snittlengde (min)'], rows)
  );
});

// Inneholder personopplysninger, så eksporten logges.
router.get('/rapporter/bookinger.csv', requirePermission('reports.export'), (req, res) => {
  const range = reportRange(req);
  const { start, end } = Reports.utilization(range, req.org.id);
  const bookings = Reports.bookingsBetween(start, end, req.org.id);
  const rows = bookings.map((b) => [
    time.localDateKey(b.start_time),
    time.formatTime(b.start_time),
    time.formatTime(b.end_time),
    b.room_name,
    b.title,
    b.organizer_name,
    b.organizer_email,
    b.status === 'cancelled' ? 'Avlyst' : 'Bekreftet',
    b.series_id ? Recurrence.describe(b.series_rule) || 'Ja' : '',
    b.admin_username || '',
  ]);
  const period = `${Reports.dateKey(range.from)}_${Reports.dateKey(range.to)}`;
  audit.byAdmin(req, 'report.exported', `Eksporterte ${bookings.length} bookinger med personopplysninger for ${period.replace('_', '–')}`);
  sendCsv(
    res,
    `bookinger_${req.org.slug}_${period}.csv`,
    Reports.toCsv(['Dato', 'Fra', 'Til', 'Rom', 'Tittel', 'Navn', 'E-post', 'Status', 'Gjentas', 'Booket av admin'], rows)
  );
});

// --- Innsyn og sletting av personopplysninger (én e-postadresse, i denne bedriftens rom) ---

function renderPrivacy(res, { email = '', bookings = null, done = null, error = null, status = 200 } = {}) {
  const nowIso = new Date().toISOString();
  res.status(status).render('admin/privacy', {
    email,
    done,
    error,
    retentionMonths: config.retentionMonths,
    bookings:
      bookings &&
      bookings.map((b) => ({
        ...b,
        when: time.formatRange(b.start_time, b.end_time),
        upcoming: b.end_time > nowIso && b.status !== 'cancelled',
      })),
  });
}

const cleanEmail = (value) => String(value || '').trim().toLowerCase().slice(0, 120);

router.get('/personvern', requirePermission('privacy.manage'), (req, res) => renderPrivacy(res));

// Søket sendes som POST, så e-postadressen ikke havner i adresselinjen eller serverlogger.
router.post('/personvern', requirePermission('privacy.manage'), (req, res) => {
  const email = cleanEmail(req.body.email);
  if (!EMAIL_RE.test(email)) return renderPrivacy(res, { email, error: 'Skriv inn en gyldig e-postadresse.', status: 400 });
  renderPrivacy(res, { email, bookings: Bookings.findByEmail(email, req.org.id).filter((b) => !b.anonymized_at) });
});

router.post('/personvern/slett', requirePermission('privacy.manage'), async (req, res) => {
  const email = cleanEmail(req.body.email);
  if (!EMAIL_RE.test(email)) return renderPrivacy(res, { error: 'Skriv inn en gyldig e-postadresse.', status: 400 });

  const all = Bookings.findByEmail(email, req.org.id).filter((b) => !b.anonymized_at);
  const nowIso = new Date().toISOString();
  const upcoming = all.filter((b) => b.end_time > nowIso && b.status !== 'cancelled');
  // Kommende møter avlyses først, så personen får beskjed og tiden blir ledig.
  const groups = new Map();
  for (const b of upcoming) {
    const key = b.series_id || `b${b.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  for (const group of groups.values()) {
    await BookingService.cancel(group, {
      actor: { type: 'admin', req },
      wholeSeries: false,
      reason: 'Opplysningene dine er slettet etter ønske.',
    });
  }
  const count = Bookings.anonymizeByEmail(email, req.org.id);
  // Selve e-postadressen logges ikke, ellers ville loggen fortsatt inneholde den.
  audit.byAdmin(req, 'access.privacy_erased', `Slettet personopplysninger fra ${count} booking(er) etter forespørsel`);
  renderPrivacy(res, { done: { count, cancelled: upcoming.length } });
});

module.exports = { router, renderAudit };
