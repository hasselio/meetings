require('dotenv').config();

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
  throw new Error(
    'SESSION_SECRET må settes til en lang, tilfeldig streng (minst 16 tegn) i .env før tjenesten kan starte.'
  );
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  timezone: process.env.TIMEZONE || 'Europe/Oslo',
  sessionSecret: process.env.SESSION_SECRET,
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  mailFromName: process.env.MAIL_FROM_NAME || 'Møteromsbooking',
  mailFromEmail: process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER,
  adminNotifyEmail: process.env.ADMIN_NOTIFY_EMAIL || null,
};
