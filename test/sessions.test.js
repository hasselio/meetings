const { test } = require('node:test');
const assert = require('node:assert/strict');
const { app, db, models, request, createAdmin, login } = require('./helpers');
const { deleteExpiredSessions } = require('../src/session-store');
const bcrypt = require('bcryptjs');

test('innlogging lagres i databasen og overlever en ny app-instans', async () => {
  createAdmin('kari');
  const agent = await login('kari');
  const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  assert.equal(count, 1);

  // Simulerer omstart: en ny store-instans leser samme tabell.
  const { SqliteStore } = require('../src/session-store');
  const sid = db.prepare('SELECT sid FROM sessions').get().sid;
  const sess = await new Promise((resolve, reject) =>
    new SqliteStore().get(sid, (err, s) => (err ? reject(err) : resolve(s)))
  );
  assert.ok(sess.adminId);

  const res = await agent.get('/admin/rom');
  assert.equal(res.status, 200);
});

test('utløpte økter ryddes bort', () => {
  db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)').run('gammel', '{}', Date.now() - 1000);
  assert.ok(deleteExpiredSessions() >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('gammel').n, 0);
});

test('passordbytte logger ut andre økter for samme konto', async () => {
  const user = createAdmin('ola');
  const first = await login('ola');
  const second = await login('ola');
  models.AdminUsers.setPassword(user.id, bcrypt.hashSync('helt-nytt-passord', 4));
  for (const agent of [first, second]) {
    const res = await agent.get('/admin/rom');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/login');
  }
});

test('uinnlogget får ikke admin-sider', async () => {
  const res = await request(app).get('/admin/rom');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/login');
});

test('sikkerhetshoder settes', async () => {
  const res = await request(app).get('/');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal(res.headers['referrer-policy'], 'same-origin');
});
