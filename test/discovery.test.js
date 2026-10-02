const { test } = require('node:test');
const assert = require('node:assert/strict');
const { app, db, models, request, createRoom, at } = require('./helpers');

const small = createRoom({ name: 'Lite rom', capacity: 4, facilities: ['screen'] });
const big = createRoom({ name: 'Stort rom', capacity: 12, facilities: ['screen', 'teams'] });
const closed = createRoom({ name: 'Helgestengt' });
db.prepare(`UPDATE rooms SET open_days = '1,2,3,4,5' WHERE id = ?`).run(closed.id);

models.Bookings.create({
  roomId: small.id,
  title: 'Hemmelig strategimøte',
  organizerName: 'Kari Hemmelig',
  organizerEmail: 'kari@example.com',
  start: at('2030-03-04', '10:00'),
  end: at('2030-03-04', '11:00'),
});
models.RoomBlocks.create({ roomId: big.id, start: at('2030-03-05', '00:00'), end: at('2030-03-06', '00:00'), reason: 'Intern årsak' });

test('forsiden har filterdata for hvert rom', async () => {
  const res = await request(app).get('/');
  assert.match(res.text, /id="roomFilters"/);
  assert.match(res.text, new RegExp(`data-room-id="${big.id}"[\\s\\S]*?data-capacity="12"[\\s\\S]*?data-facilities="screen,teams"`));
  // Bare fasiliteter som finnes i minst ett rom, tilbys som filter.
  assert.match(res.text, /data-facility="teams"/);
  assert.doesNotMatch(res.text, /data-facility="coffee"/);
});

test('ledighets-API tar hensyn til bookinger, sperringer og regler', async () => {
  const check = async (start, end) => {
    const res = await request(app).get(`/api/availability?start=${start}&end=${end}`);
    assert.equal(res.status, 200);
    return Object.fromEntries(res.body.rooms.map((r) => [r.id, r.free]));
  };
  const monday = await check(at('2030-03-04', '10:30'), at('2030-03-04', '11:30'));
  assert.equal(monday[small.id], false);
  assert.equal(monday[big.id], true);
  const tuesday = await check(at('2030-03-05', '09:00'), at('2030-03-05', '10:00'));
  assert.equal(tuesday[big.id], false);
  const saturday = await check(at('2030-03-09', '09:00'), at('2030-03-09', '10:00'));
  assert.equal(saturday[closed.id], false);
  assert.equal(saturday[small.id], true);

  assert.equal((await request(app).get('/api/availability?start=x&end=y')).status, 400);
});

test('kalenderabonnementet viser bare opptatt, uten navn eller årsak', async () => {
  // Bookingen ligger langt frem i tid; legg inn en som er innenfor vinduet.
  const soon = new Date(Date.now() + 2 * 24 * 3600 * 1000);
  soon.setUTCMinutes(0, 0, 0);
  models.Bookings.create({
    roomId: big.id,
    title: 'Konfidensielt',
    organizerName: 'Ola Skjult',
    organizerEmail: 'ola@example.com',
    start: soon.toISOString(),
    end: new Date(soon.getTime() + 3600 * 1000).toISOString(),
  });
  models.RoomBlocks.create({ roomId: big.id, start: new Date(soon.getTime() + 24 * 3600 * 1000).toISOString(), end: new Date(soon.getTime() + 26 * 3600 * 1000).toISOString(), reason: 'Hemmelig årsak' });

  const res = await request(app).get(`/rom/${big.id}/kalender.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/calendar/);
  assert.match(res.text, /X-WR-CALNAME:Stort rom/);
  assert.match(res.text, /SUMMARY:Opptatt/);
  assert.match(res.text, /SUMMARY:Ikke tilgjengelig/);
  assert.doesNotMatch(res.text, /Konfidensielt|Ola Skjult|ola@example|Hemmelig årsak|METHOD:/);
  assert.equal((await request(app).get('/rom/9999/kalender.ics')).status, 404);
});

test('romsiden lenker til abonnementet', async () => {
  const res = await request(app).get(`/rom/${big.id}`);
  assert.match(res.text, new RegExp(`webcal://localhost:3000/rom/${big.id}/kalender.ics`));
});
