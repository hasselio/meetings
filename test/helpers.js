// Felles oppsett for testene. Må lastes før appen, siden konfigurasjonen leses ved oppstart.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-som-er-lang-nok-1234';
process.env.DB_PATH = ':memory:';
process.env.TIMEZONE = 'Europe/Oslo';
process.env.BASE_URL = 'http://localhost:3000';
if (process.env.SMTP_HOST === undefined) process.env.SMTP_HOST = '';

const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const models = require('../src/models');

const PASSWORD = 'test-passord-123';

function createAdmin(username, role = 'admin', extra = {}) {
  const user = models.AdminUsers.create({ username, passwordHash: bcrypt.hashSync(PASSWORD, 4), ...extra });
  if (role !== 'admin') db.prepare('UPDATE admin_users SET role = ? WHERE id = ?').run(role, user.id);
  return models.AdminUsers.findById(user.id);
}

async function login(username, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').type('form').send({ username, password });
  if (res.status !== 302) throw new Error(`Innlogging feilet for ${username}: ${res.status}`);
  return agent;
}

function createRoom(extra = {}) {
  return models.Rooms.create({ name: 'Testrom', color: '#3f5bd9', facilities: [], ...extra });
}

// Tidspunkt i Oslo-tid som ISO-streng, f.eks. at('2030-03-04', '10:00').
function at(date, time) {
  const { zonedTimeToUtc } = require('../src/time');
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return zonedTimeToUtc(y, m, d, h, mi, 'Europe/Oslo').toISOString();
}

module.exports = { app, db, models, request, createAdmin, login, createRoom, at, PASSWORD };
