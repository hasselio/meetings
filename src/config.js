require('dotenv').config();

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
  throw new Error(
    'SESSION_SECRET må settes til en lang, tilfeldig streng (minst 16 tegn) i .env før tjenesten kan starte.'
  );
}

const isTruthy = (value) => (value || '').trim().toLowerCase() === 'true';
const positiveInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return n > 0 ? n : fallback;
};

const smtpConfigured = Boolean(process.env.SMTP_HOST);

module.exports = {
  appName: process.env.APP_NAME || 'Møterom',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '127.0.0.1',
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  timezone: process.env.TIMEZONE || 'Europe/Oslo',
  sessionSecret: process.env.SESSION_SECRET,
  cookieSecure: isTruthy(process.env.COOKIE_SECURE),
  isTest: process.env.NODE_ENV === 'test',
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: isTruthy(process.env.SMTP_SECURE),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  mailFromName: process.env.MAIL_FROM_NAME || 'Møteromsbooking',
  mailFromEmail: process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER,
  adminNotifyEmail: process.env.ADMIN_NOTIFY_EMAIL || null,
  // Bekreftelse på e-post krever at e-post kan sendes; uten SMTP blir bookinger gyldige med en gang.
  bookingConfirmation: smtpConfigured && process.env.BOOKING_CONFIRMATION !== 'false',
  pendingHoldMinutes: positiveInt(process.env.PENDING_HOLD_MINUTES, 30),
  retentionMonths: positiveInt(process.env.RETENTION_MONTHS, 6),
  auditRetentionMonths: positiveInt(process.env.AUDIT_RETENTION_MONTHS, 12),
  privacyContact: process.env.PRIVACY_CONTACT || process.env.ADMIN_NOTIFY_EMAIL || process.env.MAIL_FROM_EMAIL || null,
};
