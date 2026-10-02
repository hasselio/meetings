// Bedriftene skal være helt adskilt: ingen kan se eller endre en annen bedrifts rom, bookinger,
// sperringer, brukere, søknader, rapporter eller logg. Hvert forsøk skal gi «finnes ikke».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { app, db, models, request, createAdmin, createOrg, login, createRoom, at, PASSWORD } = require('./helpers');

const acme = createOrg('Acme AS');
const beta = createOrg('Beta AS');
const acmeRoom = createRoom({ name: 'Acme-rommet', organization_id: acme.id });
const betaRoom = createRoom({ name: 'Beta-rommet', organization_id: beta.id });
const betaBooking = models.Bookings.create({
  roomId: betaRoom.id,
  title: 'Betas hemmelige møte',
  organizerName: 'Beta Person',
  organizerEmail: 'person@beta.no',
  start: at('2030-05-06', '10:00'),
  end: at('2030-05-06', '11:00'),
});
const betaBlock = models.RoomBlocks.create({ roomId: betaRoom.id, start: at('2030-05-07', '08:00'), end: at('2030-05-07', '16:00'), reason: 'Beta-intern' });
createAdmin('acme-admin', 'admin', { org: acme });
const betaAdmin = createAdmin('beta-admin', 'admin', { org: beta });
const betaRequest = models.AdminRequests.create({
  organizationId: beta.id,
  name: 'Søker Beta',
  email: 'soker@beta.no',
  username: 'soker-beta',
  passwordHash: bcrypt.hashSync(PASSWORD, 4),
});

test('admin i én bedrift når ingenting i en annen bedrift', async () => {
  const agent = await login('acme-admin');
  const notFound = async (method, path, body) => {
    const res = await agent[method](path).send(body || {});
    assert.equal(res.status, 404, `${method.toUpperCase()} ${path} skulle gitt 404, fikk ${res.status}`);
  };

  // Rom
  await notFound('get', `/admin/rom/${betaRoom.id}/rediger`);
  await notFound('post', `/admin/rom/${betaRoom.id}`, { name: 'Kapret', open_days: ['1'] });
  await notFound('post', `/admin/rom/${betaRoom.id}/slett`);
  // Bookinger
  await notFound('get', `/admin/api/rooms/${betaRoom.id}/events?start=2030-05-01T00:00:00Z&end=2030-05-10T00:00:00Z`);
  await notFound('get', `/admin/api/bookings/${betaBooking.id}`);
  await notFound('patch', `/admin/api/bookings/${betaBooking.id}`, { title: 'Kapret' });
  await notFound('post', `/admin/api/bookings/${betaBooking.id}/cancel`);
  await notFound('post', `/admin/api/rooms/${betaRoom.id}/bookings`, {
    title: 'x', organizerName: 'x', organizerEmail: 'x@acme.no', start: at('2030-05-08', '09:00'), end: at('2030-05-08', '10:00'),
  });
  // Flytte egen booking inn i en annen bedrifts rom
  const own = models.Bookings.create({ roomId: acmeRoom.id, title: 'Eget', organizerName: 'A', organizerEmail: 'a@acme.no', start: at('2030-05-08', '09:00'), end: at('2030-05-08', '10:00') });
  await notFound('patch', `/admin/api/bookings/${own.id}`, { roomId: betaRoom.id });
  assert.equal(models.Bookings.get(own.id).room_id, acmeRoom.id);
  // Sperringer
  await notFound('post', `/admin/sperringer/${betaBlock.id}/slett`);
  const block = await agent.post('/admin/sperringer').type('form').send({ room: betaRoom.id, start: '2030-06-01T08:00', end: '2030-06-01T10:00' });
  assert.equal(block.status, 400);
  // Brukere og søknader
  await notFound('get', `/admin/brukere/${betaAdmin.id}`);
  await notFound('post', `/admin/brukere/${betaAdmin.id}`, { role: 'viewer' });
  await notFound('post', `/admin/brukere/${betaAdmin.id}/tilbakestill`);
  await notFound('post', `/admin/brukere/${betaAdmin.id}/fjern`);
  const approve = await agent.post(`/admin/tilgang/${betaRequest.id}/godkjenn`).type('form').send({ role: 'admin' });
  assert.equal(approve.status, 302);
  assert.equal(models.AdminRequests.get(betaRequest.id).status, 'pending');
  // Bytte til en bedrift man ikke er med i
  await notFound('post', '/admin/bedrift', { org: beta.id });
  // Plattform
  assert.equal((await agent.get('/admin/plattform')).status, 403);

  // Ingenting av Beta er endret.
  assert.equal(models.Rooms.get(betaRoom.id).name, 'Beta-rommet');
  assert.equal(models.Bookings.get(betaBooking.id).status, 'confirmed');
  assert.ok(models.RoomBlocks.get(betaBlock.id));
  assert.equal(models.Memberships.get(betaAdmin.id, beta.id).role, 'admin');
});

test('lister, rapporter, logg og personvern viser bare egen bedrift', async () => {
  const agent = await login('acme-admin');
  const pages = await Promise.all(
    ['/admin', '/admin/rom', '/admin/sperringer', '/admin/tilgang', '/admin/rapporter?fra=2030-05-01&til=2030-05-31', '/admin/logg'].map((p) =>
      agent.get(p)
    )
  );
  for (const page of pages) {
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /Beta-rommet|beta-admin|Søker Beta|Beta-intern|Betas hemmelige/);
  }
  const csv = await agent.get('/admin/rapporter/bookinger.csv?fra=2030-05-01&til=2030-05-31');
  assert.doesNotMatch(csv.text, /Betas hemmelige|person@beta\.no/);
  const privacy = await agent.post('/admin/personvern').type('form').send({ email: 'person@beta.no' });
  assert.doesNotMatch(privacy.text, /Betas hemmelige/);
  await agent.post('/admin/personvern/slett').type('form').send({ email: 'person@beta.no' });
  assert.equal(models.Bookings.get(betaBooking.id).organizer_email, 'person@beta.no');

  // Nye rom havner i egen bedrift, selv om skjemaet prøver noe annet.
  await agent.post('/admin/rom').type('form').send({ name: 'Nytt Acme-rom', open_days: ['1'], organization_id: beta.id });
  assert.equal(models.Rooms.all(beta.id).length, 1);
  assert.ok(models.Rooms.all(acme.id).some((r) => r.name === 'Nytt Acme-rom'));
});

test('en bruker i to bedrifter bytter mellom dem og har rollen fra hver', async () => {
  const both = createAdmin('dobbel', 'viewer', { org: acme });
  models.Memberships.add(both.id, beta.id, 'manager');
  const agent = await login('dobbel');

  // Lesetilgang i Acme (første i alfabetet): kan ikke endre rom.
  assert.equal((await agent.get(`/admin/rom/${acmeRoom.id}/rediger`)).status, 403);
  assert.equal((await agent.post('/admin/bedrift').type('form').send({ org: beta.id, section: 'rooms' })).headers.location, '/admin/rom');
  // Romansvarlig i Beta: kan endre Betas rom, men ikke lenger Acmes.
  assert.equal((await agent.get(`/admin/rom/${betaRoom.id}/rediger`)).status, 200);
  assert.equal((await agent.get(`/admin/rom/${acmeRoom.id}/rediger`)).status, 404);
});

test('bedriftsadmin kan ikke endre konto eller passord til en som også er med i en annen bedrift', async () => {
  const shared = createAdmin('delt', 'viewer', { org: acme, email: 'delt@example.com' });
  models.Memberships.add(shared.id, beta.id, 'admin');
  const agent = await login('acme-admin');

  const page = await agent.get(`/admin/brukere/${shared.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Kontoen brukes også i Beta AS/);
  assert.doesNotMatch(page.text, /Tilbakestill passord/);

  assert.equal((await agent.post(`/admin/brukere/${shared.id}/tilbakestill`)).status, 403);
  await agent.post(`/admin/brukere/${shared.id}`).type('form').send({ username: 'kapret', email: 'kapret@acme.no', role: 'manager' });
  const after = models.AdminUsers.findById(shared.id);
  assert.equal(after.username, 'delt');
  assert.equal(after.email, 'delt@example.com');
  // Rollen i egen bedrift kan endres.
  assert.equal(models.Memberships.get(shared.id, acme.id).role, 'manager');
  assert.equal(models.Memberships.get(shared.id, beta.id).role, 'admin');

  // Fjernes fra Acme: kontoen beholdes fordi den brukes i Beta.
  await agent.post(`/admin/brukere/${shared.id}/fjern`);
  assert.ok(models.AdminUsers.findById(shared.id));
  assert.equal(models.Memberships.get(shared.id, acme.id), undefined);
});

test('bedriftsadmin oppretter brukere i egen bedrift, og siste administrator kan ikke fjernes', async () => {
  const agent = await login('acme-admin');
  const res = await agent.post('/admin/brukere').type('form').send({ username: 'ny-acme', name: 'Ny', role: 'manager' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Brukeren er opprettet/);
  const created = models.AdminUsers.findByUsername('ny-acme');
  assert.equal(created.must_change_password, 1);
  assert.equal(models.Memberships.get(created.id, acme.id).role, 'manager');
  assert.equal(models.Memberships.forUser(created.id).length, 1);

  // Beta har bare én administrator.
  const betaAgent = await login('beta-admin');
  const other = createAdmin('beta-leser', 'viewer', { org: beta });
  const demote = await betaAgent.post(`/admin/brukere/${other.id}`).type('form').send({ role: 'viewer', username: 'beta-leser' });
  assert.equal(demote.status, 302);
  const self = await betaAgent.post(`/admin/brukere/${betaAdmin.id}`).type('form').send({ role: 'viewer' });
  assert.equal(self.headers.location, '/admin/konto');
});

test('søknad går til valgt bedrift, og bare den bedriften kan godkjenne', async () => {
  const res = await request(app).post('/admin/be-om-tilgang').type('form').send({
    altcha: 'test-bypass',
    organization: acme.id,
    name: 'Ny Søker',
    email: 'ny@soker.no',
    username: 'ny-soker',
    password: PASSWORD,
    passwordConfirm: PASSWORD,
  });
  assert.equal(res.status, 200);
  const req = db.prepare(`SELECT * FROM admin_requests WHERE username = 'ny-soker'`).get();
  assert.equal(req.organization_id, acme.id);

  const betaAgent = await login('beta-admin');
  await betaAgent.post(`/admin/tilgang/${req.id}/godkjenn`).type('form').send({ role: 'admin' });
  assert.equal(models.AdminRequests.get(req.id).status, 'pending');

  const acmeAgent = await login('acme-admin');
  await acmeAgent.post(`/admin/tilgang/${req.id}/godkjenn`).type('form').send({ role: 'viewer' });
  const user = models.AdminUsers.findByUsername('ny-soker');
  assert.deepEqual(models.Memberships.forUser(user.id).map((m) => [m.name, m.role]), [['Acme AS', 'viewer']]);
});

test('innlogget bruker kan be om tilgang til en bedrift til', async () => {
  createAdmin('vandrer', 'viewer', { org: acme });
  const agent = await login('vandrer');
  await agent.post('/admin/konto/bedrifter').type('form').send({ organization: beta.id, reason: 'Prosjekt' });
  const req = db.prepare(`SELECT * FROM admin_requests WHERE username = 'vandrer'`).get();
  assert.equal(req.organization_id, beta.id);
  const betaAgent = await login('beta-admin');
  await betaAgent.post(`/admin/tilgang/${req.id}/godkjenn`).type('form').send({ role: 'manager' });
  const user = models.AdminUsers.findByUsername('vandrer');
  assert.equal(models.Memberships.get(user.id, beta.id).role, 'manager');
});

test('plattformadministrator oppretter bedrift med første administrator og går inn i den', async () => {
  createAdmin('plattform', 'admin', { org: null, platform: true });
  const agent = await login('plattform');
  const res = await agent.post('/admin/plattform/bedrifter').type('form').send({
    name: 'Gamma Bygg AS',
    adminName: 'Gunn Gamma',
    adminEmail: 'gunn@gamma.no',
    adminUsername: 'gunn',
  });
  assert.equal(res.status, 200);
  const gamma = models.Organizations.bySlug('gamma-bygg-as');
  assert.ok(gamma);
  const gunn = models.AdminUsers.findByUsername('gunn');
  assert.equal(models.Memberships.get(gunn.id, gamma.id).role, 'admin');
  assert.equal(gunn.must_change_password, 1);

  // Plattformadmin kan gå inn i Beta og endre det Beta eier.
  await agent.post(`/admin/plattform/bedrifter/${beta.id}/administrer`);
  assert.equal((await agent.get(`/admin/rom/${betaRoom.id}/rediger`)).status, 200);
  const log = db.prepare(`SELECT organization_id FROM audit_log WHERE action = 'platform.org_created'`).get();
  assert.equal(log.organization_id, null);
});

test('deaktivert bedrift: rommene er skjult og brukerne kan ikke logge inn', async () => {
  const agent = await login('plattform');
  const delta = createOrg('Delta AS');
  const deltaRoom = createRoom({ name: 'Delta-rommet', organization_id: delta.id });
  createAdmin('delta-admin', 'admin', { org: delta });
  const deltaAgent = await login('delta-admin');

  await agent.post(`/admin/plattform/bedrifter/${delta.id}`).type('form').send({ name: 'Delta AS', slug: 'delta-as' });
  assert.equal(models.Organizations.get(delta.id).active, 0);

  assert.doesNotMatch((await request(app).get('/')).text, /Delta-rommet/);
  assert.equal((await request(app).get(`/rom/${deltaRoom.id}`)).status, 404);
  assert.equal((await request(app).get('/b/delta-as')).status, 404);
  const book = await request(app).post(`/api/rooms/${deltaRoom.id}/bookings`).send({
    altcha: 'test-bypass', title: 'x', organizerName: 'x', organizerEmail: 'x@x.no', start: at('2030-05-08', '09:00'), end: at('2030-05-08', '10:00'),
  });
  assert.equal(book.status, 404);

  // Åpen økt kastes ut, og ny innlogging avvises.
  const kicked = await deltaAgent.get('/admin');
  assert.equal(kicked.headers.location, '/admin/login?melding=ingen-bedrift');
  const relogin = await request(app).post('/admin/login').type('form').send({ username: 'delta-admin', password: PASSWORD });
  assert.equal(relogin.status, 403);
});

test('felles forside viser bedriftsfilter, og /b/:slug bare én bedrift', async () => {
  const home = await request(app).get('/');
  assert.match(home.text, /id="filterOrg"/);
  assert.match(home.text, /Acme-rommet/);
  assert.match(home.text, /Beta-rommet/);
  const acmePage = await request(app).get('/b/acme-as');
  assert.match(acmePage.text, /Acme-rommet/);
  assert.doesNotMatch(acmePage.text, /Beta-rommet/);
  const room = await request(app).get(`/rom/${acmeRoom.id}`);
  assert.match(room.text, /Acme AS/);
});

test('den siste plattformadministratoren kan ikke fjernes', async () => {
  const agent = await login('plattform');
  const me = models.AdminUsers.findByUsername('plattform');
  await agent.post(`/admin/plattform/administratorer/${me.id}/fjern`);
  assert.equal(models.AdminUsers.findById(me.id).is_platform_admin, 1);
});

test('en bedrift kan ikke stå uten administrator, heller ikke når plattformen prøver', async () => {
  const epsilon = createOrg('Epsilon AS');
  const only = createAdmin('eneste-epsilon', 'admin', { org: epsilon });
  const agent = await login('plattform');
  await agent.post(`/admin/plattform/bedrifter/${epsilon.id}/administrer`);
  const demote = await agent.post(`/admin/brukere/${only.id}`).type('form').send({ role: 'viewer', username: 'eneste-epsilon' });
  assert.equal(demote.status, 400);
  assert.match(demote.text, /Epsilon AS må ha minst én administrator/);
  await agent.post(`/admin/brukere/${only.id}/fjern`);
  assert.equal(models.Memberships.get(only.id, epsilon.id).role, 'admin');
});
