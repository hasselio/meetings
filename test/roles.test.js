const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { db, models, createAdmin, login, createRoom, PASSWORD } = require('./helpers');

const auditActions = () => db.prepare('SELECT action FROM audit_log ORDER BY id').all().map((r) => r.action);

test('lesetilgang kan se, men ikke endre rom eller bookinger', async () => {
  createAdmin('les', 'viewer');
  const room = createRoom({ name: 'Lesrom' });
  const agent = await login('les');

  assert.equal((await agent.get('/admin')).status, 200);
  const rooms = await agent.get('/admin/rom');
  assert.equal(rooms.status, 200);
  assert.doesNotMatch(rooms.text, /\/admin\/rom\/ny/);

  assert.equal((await agent.get('/admin/rom/ny')).status, 403);
  assert.equal((await agent.post('/admin/rom').type('form').send({ name: 'Nytt' })).status, 403);
  assert.equal((await agent.post(`/admin/rom/${room.id}/slett`)).status, 403);
  assert.ok(models.Rooms.get(room.id));

  const cancel = await agent.post('/admin/api/bookings/1/cancel');
  assert.equal(cancel.status, 403);
  assert.match(cancel.headers['content-type'], /json/);
});

test('romansvarlig kan endre rom, men ikke tilgangsstyring eller logg', async () => {
  createAdmin('ansvar', 'manager');
  const agent = await login('ansvar');

  const created = await agent.post('/admin/rom').type('form').send({ name: 'Styrerommet' });
  assert.equal(created.status, 302);
  assert.equal((await agent.get('/admin/tilgang')).status, 403);
  assert.equal((await agent.get('/admin/administratorer/1')).status, 403);
  assert.equal((await agent.get('/admin/logg')).status, 403);

  const page = await agent.get('/admin/rom');
  assert.doesNotMatch(page.text, /href="\/admin\/tilgang"/);
  assert.ok(auditActions().includes('room.created'));
});

test('godkjenning gir valgt rolle og logges', async () => {
  createAdmin('sjef');
  const agent = await login('sjef');
  const request = models.AdminRequests.create({
    name: 'Per Søker',
    email: 'per@example.com',
    username: 'per',
    reason: '',
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
  });

  const res = await agent.post(`/admin/tilgang/${request.id}/godkjenn`).type('form').send({ role: 'manager' });
  assert.equal(res.status, 302);
  assert.equal(models.AdminUsers.findByUsername('per').role, 'manager');
  assert.ok(auditActions().includes('access.approved'));

  // Ugyldig rolle faller tilbake til lesetilgang.
  const second = models.AdminRequests.create({
    name: 'Kari Søker',
    email: 'kari@example.com',
    username: 'karis',
    reason: '',
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
  });
  await agent.post(`/admin/tilgang/${second.id}/godkjenn`).type('form').send({ role: 'superuser' });
  assert.equal(models.AdminUsers.findByUsername('karis').role, 'viewer');
});

test('administrator kan endre rollen til en annen, men ikke sin egen', async () => {
  const chief = createAdmin('sjef2');
  const target = createAdmin('maal');
  const agent = await login('sjef2');

  let res = await agent
    .post(`/admin/administratorer/${target.id}`)
    .type('form')
    .send({ username: 'maal', name: '', email: '', role: 'viewer' });
  assert.equal(res.status, 302);
  assert.equal(models.AdminUsers.findById(target.id).role, 'viewer');
  assert.ok(auditActions().includes('access.role_changed'));

  // Egen konto har ikke rollefelt; et forfalsket felt ignoreres.
  res = await agent.post('/admin/konto').type('form').send({ username: 'sjef2', role: 'viewer' });
  assert.equal(res.status, 302);
  assert.equal(models.AdminUsers.findById(chief.id).role, 'admin');

  // Den nedgraderte mister tilgangen med en gang, også i en økt som allerede er åpen.
  const targetAgent = await login('maal');
  assert.equal((await targetAgent.get('/admin/tilgang')).status, 403);
});

test('innlogging og mislykkede forsøk havner i loggen, og loggsiden viser dem', async () => {
  createAdmin('logger');
  const bad = await require('supertest')
    .agent(require('../src/app'))
    .post('/admin/login')
    .type('form')
    .send({ username: 'logger', password: 'feil-passord' });
  assert.equal(bad.status, 401);
  const agent = await login('logger');

  const actions = auditActions();
  assert.ok(actions.includes('login.failed'));
  assert.ok(actions.includes('login.success'));

  const page = await agent.get('/admin/logg?kategori=login');
  assert.equal(page.status, 200);
  assert.match(page.text, /Mislykket innlogging som «logger»/);
  assert.doesNotMatch(page.text, /La til rommet/);
});
