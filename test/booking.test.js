const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, db, models, request, createRoom, createAdmin, login, at } = require('./helpers');
const mailer = require('../src/services/mailer');
const maintenance = require('../src/services/maintenance');

const outbox = [];
const capture = { sendMail: async (message) => outbox.push(message) };
const tokenFrom = (message) => /\/booking\/([A-Za-z0-9_-]{32})/.exec(message.text)[1];

beforeEach(() => {
  outbox.length = 0;
  mailer.setTransport(capture);
});

const room = createRoom({ name: 'Fjorden' });

function book(overrides = {}, roomId = room.id) {
  return request(app)
    .post(`/api/rooms/${roomId}/bookings`)
    .send({
      altcha: 'test-bypass',
      title: 'Planlegging',
      organizerName: 'Kari Nordmann',
      organizerEmail: 'kari@example.com',
      start: at('2030-03-04', '10:00'),
      end: at('2030-03-04', '11:00'),
      ...overrides,
    });
}

test('bookingen avvises uten løst robot-sjekk', async () => {
  const res = await book({ altcha: undefined });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'captcha');
});

test('skjult felt fylt ut av en robot lagrer ingenting', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
  const res = await book({ website: 'http://spam.example' });
  assert.equal(res.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, before);
  assert.equal(outbox.length, 0);
});

test('booking må bekreftes via lenken før den gjelder, og GET alene bekrefter ikke', async () => {
  const res = await book();
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pending');
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].subject, /Bekreft bookingen/);
  assert.equal(outbox[0].icalEvent, undefined);

  // Ubekreftet booking holder av tiden.
  const clash = await book({ organizerEmail: 'ola@example.com', start: at('2030-03-04', '10:30') });
  assert.equal(clash.status, 409);

  const token = tokenFrom(outbox[0]);
  const page = await request(app).get(`/booking/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Bekreft bookingen/);
  assert.equal(page.headers['cache-control'], 'no-store');
  const booking = models.Bookings.byTokenHash(require('../src/tokens').hashToken(token))[0];
  assert.equal(booking.status, 'pending');

  const confirm = await request(app).post(`/booking/${token}/bekreft`);
  assert.equal(confirm.status, 303);
  assert.equal(models.Bookings.get(booking.id).status, 'confirmed');
  const invite = outbox[1];
  assert.equal(invite.icalEvent.method, 'REQUEST');
  assert.match(invite.icalEvent.content, /METHOD:REQUEST/);
  assert.match(invite.icalEvent.content, new RegExp(token));
});

test('utløpt ubekreftet booking holder ikke av tiden, men kan bekreftes hvis tiden fortsatt er ledig', async () => {
  await book({ start: at('2030-03-05', '09:00'), end: at('2030-03-05', '10:00') });
  const token = tokenFrom(outbox[0]);
  db.prepare(`UPDATE bookings SET expires_at = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'`).run();

  const confirm = await request(app).post(`/booking/${token}/bekreft`);
  assert.equal(confirm.status, 303);

  // Ny runde: utløpt, og noen andre tar tiden i mellomtiden.
  outbox.length = 0;
  await book({ start: at('2030-03-05', '12:00'), end: at('2030-03-05', '13:00'), organizerEmail: 'per@example.com' });
  const late = tokenFrom(outbox[0]);
  db.prepare(`UPDATE bookings SET expires_at = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'`).run();
  const other = await book({ start: at('2030-03-05', '12:00'), end: at('2030-03-05', '13:00'), organizerEmail: 'lise@example.com' });
  assert.equal(other.status, 201);
  const res = await request(app).post(`/booking/${late}/bekreft`);
  assert.equal(res.status, 409);
  assert.match(res.text, /tiden er nå tatt/);
});

test('endre og avbestille via lenken sender oppdatert invitasjon og avlysning', async () => {
  await book({ start: at('2030-03-06', '09:00'), end: at('2030-03-06', '10:00'), organizerEmail: 'endre@example.com' });
  const token = tokenFrom(outbox[0]);
  await request(app).post(`/booking/${token}/bekreft`);
  const [booking] = models.Bookings.byTokenHash(require('../src/tokens').hashToken(token));

  const change = await request(app)
    .post(`/booking/${token}/endre`)
    .type('form')
    .send({ id: booking.id, date: '2030-03-06', startTime: '13:00', endTime: '14:30', title: 'Nytt navn', notes: '' });
  assert.equal(change.status, 303);
  const updated = models.Bookings.get(booking.id);
  assert.equal(updated.start_time, at('2030-03-06', '13:00'));
  assert.equal(updated.title, 'Nytt navn');
  const updateMail = outbox.at(-1);
  assert.match(updateMail.subject, /^Endret/);
  assert.match(updateMail.icalEvent.content, /SEQUENCE:1/);
  assert.match(updateMail.icalEvent.content, /DTSTART;TZID=Europe\/Oslo:20300306T130000/);

  const cancel = await request(app).post(`/booking/${token}/avbestill`).type('form').send({ id: booking.id });
  assert.equal(cancel.status, 303);
  assert.equal(models.Bookings.get(booking.id).status, 'cancelled');
  assert.equal(outbox.at(-1).icalEvent.method, 'CANCEL');
  assert.match(outbox.at(-1).icalEvent.content, /STATUS:CANCELLED/);
});

test('ukjent eller misformet lenke gir 404', async () => {
  assert.equal((await request(app).get('/booking/finnes-ikke')).status, 404);
  assert.equal((await request(app).get(`/booking/${'a'.repeat(32)}`)).status, 404);
  assert.equal((await request(app).post(`/booking/${'a'.repeat(32)}/bekreft`)).status, 404);
});

test('maks tre ubekreftede bookinger per e-post', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await book({ organizerEmail: 'mange@example.com', start: at('2030-03-07', `0${7 + i}:00`), end: at('2030-03-07', `0${7 + i}:30`) });
    assert.equal(res.status, 201);
  }
  const res = await book({ organizerEmail: 'mange@example.com', start: at('2030-03-07', '15:00'), end: at('2030-03-07', '15:30') });
  assert.equal(res.status, 429);
});

test('uten e-post gjelder bookingen med en gang, og lenken vises i svaret', async () => {
  mailer.setTransport(null);
  const res = await book({ start: at('2030-03-08', '09:00'), end: at('2030-03-08', '10:00'), organizerEmail: 'uten@example.com' });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'confirmed');
  assert.equal(res.body.mailSent, false);
  assert.match(res.body.manageUrl, /^http:\/\/localhost:3000\/booking\/[A-Za-z0-9_-]{32}$/);
});

test('romregler, sperringer og pause mellom møter håndheves', async () => {
  const strict = createRoom({ name: 'Strengt' });
  db.prepare(
    `UPDATE rooms SET open_from = '08:00', open_to = '16:00', open_days = '1,2,3,4,5', max_duration_minutes = 120, buffer_minutes = 15 WHERE id = ?`
  ).run(strict.id);
  mailer.setTransport(null);

  const saturday = await book({ start: at('2030-03-09', '10:00'), end: at('2030-03-09', '11:00') }, strict.id);
  assert.equal(saturday.status, 400);
  assert.match(saturday.body.error, /lørdager/);

  const late = await book({ start: at('2030-03-11', '15:30'), end: at('2030-03-11', '16:30') }, strict.id);
  assert.match(late.body.error, /mellom 08:00 og 16:00/);

  const long = await book({ start: at('2030-03-11', '08:00'), end: at('2030-03-11', '11:00') }, strict.id);
  assert.match(long.body.error, /maks 2 timer/);

  assert.equal((await book({ start: at('2030-03-11', '09:00'), end: at('2030-03-11', '10:00') }, strict.id)).status, 201);
  const tight = await book({ start: at('2030-03-11', '10:00'), end: at('2030-03-11', '11:00'), organizerEmail: 'b@example.com' }, strict.id);
  assert.equal(tight.status, 409);
  assert.equal(tight.body.code, 'buffer');

  models.RoomBlocks.create({ roomId: strict.id, start: at('2030-03-12', '00:00'), end: at('2030-03-13', '00:00'), reason: 'Maling' });
  const blocked = await book({ start: at('2030-03-12', '09:00'), end: at('2030-03-12', '10:00') }, strict.id);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /sperret.*Maling/);
});

test('påminnelse sendes én gang for møter som starter innen et døgn', async () => {
  const start = new Date(Date.now() + 20 * 3600 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const b = models.Bookings.create({
    roomId: room.id,
    title: 'I morgen',
    organizerName: 'Påminnes',
    organizerEmail: 'minn@example.com',
    start: start.toISOString(),
    end: new Date(start.getTime() + 3600 * 1000).toISOString(),
  });
  db.prepare(`UPDATE bookings SET confirmed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(b.id);

  assert.equal(await maintenance.sendReminders(), 1);
  assert.match(outbox[0].subject, /Påminnelse/);
  assert.match(outbox[0].text, /\/booking\//);
  assert.equal(await maintenance.sendReminders(), 0);
});

test('personopplysninger anonymiseres etter oppbevaringstiden', () => {
  const old = models.Bookings.create({
    roomId: room.id,
    title: 'Gammelt møte',
    organizerName: 'Gammel',
    organizerEmail: 'gammel@example.com',
    notes: 'hemmelig',
    start: '2020-01-01T09:00:00.000Z',
    end: '2020-01-01T10:00:00.000Z',
  });
  const { anonymized } = maintenance.applyRetention();
  assert.ok(anonymized >= 1);
  const row = models.Bookings.get(old.id);
  assert.equal(row.organizer_email, '');
  assert.equal(row.organizer_name, 'Anonymisert');
  assert.equal(row.notes, null);
  assert.equal(row.manage_token_hash, null);
  assert.equal(row.start_time, '2020-01-01T09:00:00.000Z');
});

test('administrator kan slette alle opplysninger for en e-postadresse', async () => {
  mailer.setTransport(capture);
  const b = models.Bookings.create({
    roomId: room.id,
    title: 'Slett meg',
    organizerName: 'Sletter',
    organizerEmail: 'slett@example.com',
    start: at('2030-04-01', '09:00'),
    end: at('2030-04-01', '10:00'),
  });
  createAdmin('personvern');
  createAdmin('leser', 'viewer');
  const viewer = await login('leser');
  assert.equal((await viewer.get('/admin/personvern')).status, 403);

  const agent = await login('personvern');
  const found = await agent.post('/admin/personvern').type('form').send({ email: 'SLETT@example.com' });
  assert.match(found.text, /Slett meg/);
  const res = await agent.post('/admin/personvern/slett').type('form').send({ email: 'slett@example.com' });
  assert.equal(res.status, 200);
  const row = models.Bookings.get(b.id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.organizer_email, '');
  assert.equal(outbox.at(-1).icalEvent.method, 'CANCEL');
  const log = db.prepare(`SELECT summary FROM audit_log WHERE action = 'access.privacy_erased'`).get();
  assert.doesNotMatch(log.summary, /slett@example\.com/);
});

test('personvernsiden finnes og lenkes fra bunnteksten', async () => {
  const res = await request(app).get('/personvern');
  assert.equal(res.status, 200);
  assert.match(res.text, /Dine rettigheter/);
  assert.match((await request(app).get('/')).text, /href="\/personvern"/);
});
