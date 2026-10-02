const { test } = require('node:test');
const assert = require('node:assert/strict');
const { app, db, models, request, createAdmin, login, createRoom, at } = require('./helpers');
const Rules = require('../src/rules');
const mailer = require('../src/services/mailer');

const outbox = [];
mailer.setTransport({ sendMail: async (m) => outbox.push(m) });

test('regler beskrives forståelig', () => {
  const room = { open_from: '08:00', open_to: '16:00', open_days: '1,2,3,4,5', max_duration_minutes: 90, max_days_ahead: 30, buffer_minutes: 15 };
  assert.deepEqual(Rules.describe(room), [
    'Kan bookes man–fre, 08:00–16:00',
    'Maks 1 t 30 min per booking',
    'Inntil 30 dager frem i tid',
    '15 min pause mellom møter',
  ]);
  assert.equal(Rules.describeDays([1, 3, 5]), 'man, ons, fre');
  assert.equal(Rules.describeDays([0, 1, 2, 3, 4, 5, 6]), 'alle dager');
});

test('romskjemaet lagrer regler og avviser ugyldige', async () => {
  createAdmin('romsjef', 'manager');
  const agent = await login('romsjef');
  const bad = await agent.post('/admin/rom').type('form').send({ name: 'Uten dager', open_from: '08:00', open_to: '16:00' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /minst én dag/);

  const backwards = await agent
    .post('/admin/rom')
    .type('form')
    .send({ name: 'Baklengs', open_from: '16:00', open_to: '08:00', open_days: ['1'] });
  assert.match(backwards.text, /slutte etter/);

  const ok = await agent.post('/admin/rom').type('form').send({
    name: 'Regelrommet',
    open_from: '08:00',
    open_to: '16:00',
    open_days: ['1', '2', '3', '4', '5'],
    max_duration_minutes: '120',
    max_days_ahead: '60',
    buffer_minutes: '15',
  });
  assert.equal(ok.status, 302);
  const room = models.Rooms.all().find((r) => r.name === 'Regelrommet');
  assert.equal(room.open_days, '1,2,3,4,5');
  assert.equal(room.max_duration_minutes, 120);
  assert.equal(room.buffer_minutes, 15);

  const page = await request(app).get(`/rom/${room.id}`);
  assert.match(page.text, /Kan bookes man–fre, 08:00–16:00/);
});

test('sperring stopper booking, vises som opptatt, og kan avlyse bookinger i perioden', async () => {
  createAdmin('sperrer');
  const agent = await login('sperrer');
  const room = createRoom({ name: 'Sperrerommet' });
  const booking = models.Bookings.create({
    roomId: room.id,
    title: 'Kolliderer',
    organizerName: 'Kari',
    organizerEmail: 'kari@example.com',
    start: at('2030-05-06', '10:00'),
    end: at('2030-05-06', '11:00'),
  });

  const form = { room: room.id, start: '2030-05-06T08:00', end: '2030-05-08T16:00', reason: 'Oppussing' };
  const refused = await agent.post('/admin/sperringer').type('form').send(form);
  assert.equal(refused.status, 400);
  assert.match(refused.text, /1 booking\(er\) ligger i perioden/);
  assert.match(refused.text, /Kolliderer/);
  assert.equal(models.RoomBlocks.overlapping(room.id, at('2030-05-06', '00:00'), at('2030-05-09', '00:00')).length, 0);

  outbox.length = 0;
  const done = await agent.post('/admin/sperringer').type('form').send({ ...form, cancelConflicts: '1' });
  assert.equal(done.status, 302);
  assert.equal(models.Bookings.get(booking.id).status, 'cancelled');
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].text, /Oppussing/);

  const events = await request(app).get(`/api/rooms/${room.id}/events?start=2030-05-04T00:00:00Z&end=2030-05-11T00:00:00Z`);
  const blocked = events.body.find((e) => e.classNames.includes('ev-blocked'));
  assert.equal(blocked.title, 'Ikke tilgjengelig');
  assert.doesNotMatch(JSON.stringify(events.body), /Oppussing/);

  const res = await request(app)
    .post(`/api/rooms/${room.id}/bookings`)
    .send({ altcha: 'test-bypass', title: 'x', organizerName: 'y', organizerEmail: 'z@example.com', start: at('2030-05-07', '09:00'), end: at('2030-05-07', '10:00') });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'blocked');

  const block = db.prepare('SELECT id FROM room_blocks WHERE room_id = ?').get(room.id);
  assert.equal((await agent.post(`/admin/sperringer/${block.id}/slett`)).status, 302);
  const actions = db.prepare('SELECT action FROM audit_log').all().map((r) => r.action);
  assert.ok(actions.includes('room.blocked'));
  assert.ok(actions.includes('room.unblocked'));
});

test('lesetilgang ser sperringer, men kan ikke opprette dem', async () => {
  createAdmin('seer', 'viewer');
  const agent = await login('seer');
  const page = await agent.get('/admin/sperringer');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Sperr perioden/);
  assert.equal((await agent.post('/admin/sperringer').type('form').send({})).status, 403);
});
