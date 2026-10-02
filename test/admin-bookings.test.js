const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, models, createAdmin, login, createRoom, at } = require('./helpers');
const mailer = require('../src/services/mailer');

const outbox = [];
beforeEach(() => {
  outbox.length = 0;
  mailer.setTransport({ sendMail: async (m) => outbox.push(m) });
});

const roomA = createRoom({ name: 'Rom A' });
const roomB = createRoom({ name: 'Rom B' });
db.prepare(`UPDATE rooms SET open_days = '1,2,3,4,5', open_from = '08:00', open_to = '16:00'`).run();
createAdmin('ansvarlig', 'manager');
createAdmin('kikker', 'viewer');

const person = { title: 'Styremøte', organizerName: 'Per Hansen', organizerEmail: 'per@example.com', notes: 'Kaffe' };

test('admin booker på vegne av andre, også utenfor romreglene, og bookingen gjelder med en gang', async () => {
  const agent = await login('ansvarlig');
  const res = await agent
    .post(`/admin/api/rooms/${roomA.id}/bookings`)
    .send({ ...person, start: at('2030-06-01', '18:00'), end: at('2030-06-01', '20:00') }); // lørdag kveld
  assert.equal(res.status, 201);
  const booking = db.prepare(`SELECT * FROM bookings WHERE title = 'Styremøte'`).get();
  assert.equal(booking.status, 'confirmed');
  assert.ok(booking.created_by_admin_id);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'per@example.com');
  assert.equal(outbox[0].icalEvent.method, 'REQUEST');

  const clash = await agent
    .post(`/admin/api/rooms/${roomA.id}/bookings`)
    .send({ ...person, start: at('2030-06-01', '19:00'), end: at('2030-06-01', '21:00') });
  assert.equal(clash.status, 409);

  const silent = await agent
    .post(`/admin/api/rooms/${roomA.id}/bookings`)
    .send({ ...person, title: 'Stille', start: at('2030-06-03', '09:00'), end: at('2030-06-03', '10:00'), notify: false });
  assert.equal(silent.status, 201);
  assert.equal(outbox.length, 1);
});

test('admin kan flytte til et annet rom og ny tid, og personen får oppdatert invitasjon', async () => {
  const agent = await login('ansvarlig');
  const booking = db.prepare(`SELECT * FROM bookings WHERE title = 'Styremøte'`).get();
  const res = await agent
    .patch(`/admin/api/bookings/${booking.id}`)
    .send({ roomId: roomB.id, start: at('2030-06-04', '13:00'), end: at('2030-06-04', '14:00') });
  assert.equal(res.status, 200);
  const moved = models.Bookings.get(booking.id);
  assert.equal(moved.room_id, roomB.id);
  assert.equal(moved.start_time, at('2030-06-04', '13:00'));
  assert.equal(moved.title, 'Styremøte');
  assert.match(outbox[0].subject, /^Endret/);
  assert.match(outbox[0].icalEvent.content, /LOCATION:Rom B/);
  const log = db.prepare(`SELECT summary FROM audit_log WHERE action = 'booking.updated' ORDER BY id DESC`).get();
  assert.match(log.summary, /Rom B/);
});

test('ny e-postadresse gir avlysning til den gamle og invitasjon til den nye', async () => {
  const agent = await login('ansvarlig');
  const booking = db.prepare(`SELECT * FROM bookings WHERE title = 'Styremøte'`).get();
  const res = await agent.patch(`/admin/api/bookings/${booking.id}`).send({ organizerEmail: 'ny@example.com' });
  assert.equal(res.status, 200);
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0].to, 'per@example.com');
  assert.equal(outbox[0].icalEvent.method, 'CANCEL');
  assert.equal(outbox[1].to, 'ny@example.com');
  assert.equal(outbox[1].icalEvent.method, 'REQUEST');
});

test('flytting kan ikke kollidere med andre bookinger', async () => {
  const agent = await login('ansvarlig');
  const [a, b] = ['Første', 'Andre'].map((title, i) =>
    models.Bookings.create({
      roomId: roomA.id,
      title,
      organizerName: 'X',
      organizerEmail: 'x@example.com',
      start: at('2030-06-05', `1${i}:00`),
      end: at('2030-06-05', `1${i}:30`),
    })
  );
  const res = await agent.patch(`/admin/api/bookings/${b.id}`).send({ start: at('2030-06-05', '10:15'), end: at('2030-06-05', '10:45') });
  assert.equal(res.status, 409);
  assert.equal(models.Bookings.get(b.id).start_time, at('2030-06-05', '11:00'));
  assert.ok(a);
});

test('admin kan booke en serie og avlyse hele serien på én gang', async () => {
  const agent = await login('ansvarlig');
  const res = await agent.post(`/admin/api/rooms/${roomA.id}/bookings`).send({
    ...person,
    title: 'Serie fra admin',
    start: at('2030-09-02', '09:00'),
    end: at('2030-09-02', '10:00'),
    repeat: 'weekly',
    repeatUntil: '2030-09-30',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.count, 5);
  const first = db.prepare(`SELECT * FROM bookings WHERE title = 'Serie fra admin' ORDER BY start_time`).get();
  const cancel = await agent.post(`/admin/api/bookings/${first.id}/cancel`).send({ scope: 'series' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.cancelled, 5);
});

test('ubekreftede bookinger vises i adminkalenderen med status', async () => {
  const agent = await login('ansvarlig');
  db.prepare(
    `INSERT INTO bookings (room_id, title, organizer_name, organizer_email, start_time, end_time, ics_uid, status, expires_at)
     VALUES (?, 'Venter', 'V', 'v@example.com', ?, ?, 'u-venter', 'pending', '2099-01-01T00:00:00.000Z')`
  ).run(roomA.id, at('2030-06-06', '09:00'), at('2030-06-06', '10:00'));
  const res = await agent.get(`/admin/api/rooms/${roomA.id}/events?start=2030-06-01T00:00:00Z&end=2030-06-08T00:00:00Z`);
  const pending = res.body.find((e) => e.title === 'Venter');
  assert.equal(pending.extendedProps.status, 'pending');
  assert.ok(pending.classNames.includes('ev-pending'));
});

test('lesetilgang kan ikke booke eller flytte', async () => {
  const agent = await login('kikker');
  const booking = db.prepare(`SELECT * FROM bookings LIMIT 1`).get();
  assert.equal((await agent.post(`/admin/api/rooms/${roomA.id}/bookings`).send(person)).status, 403);
  assert.equal((await agent.patch(`/admin/api/bookings/${booking.id}`).send({ title: 'x' })).status, 403);
});
