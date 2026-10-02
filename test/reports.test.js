const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, models, createAdmin, login, createRoom, at } = require('./helpers');
const Reports = require('../src/reports');

const room = createRoom({ name: 'Målerommet' });
// Man–fre 08–16 = 8 timer per dag.
db.prepare(`UPDATE rooms SET open_days = '1,2,3,4,5', open_from = '08:00', open_to = '16:00' WHERE id = ?`).run(room.id);
const week = { from: '2030-03-04', to: '2030-03-10' }; // man–søn

models.Bookings.create({ roomId: room.id, title: '=HYPERLINK("http://ondt")', organizerName: 'Kari; Nordmann', organizerEmail: 'kari@example.com', start: at('2030-03-04', '09:00'), end: at('2030-03-04', '13:00') });
models.Bookings.create({ roomId: room.id, title: 'Kort', organizerName: 'Ola', organizerEmail: 'ola@example.com', start: at('2030-03-05', '10:00'), end: at('2030-03-05', '12:00') });
const cancelled = models.Bookings.create({ roomId: room.id, title: 'Avlyst', organizerName: 'Per', organizerEmail: 'per@example.com', start: at('2030-03-06', '10:00'), end: at('2030-03-06', '11:00') });
models.Bookings.cancel(cancelled.id);
// Fredag er sperret hele dagen.
models.RoomBlocks.create({ roomId: room.id, start: at('2030-03-08', '00:00'), end: at('2030-03-09', '00:00') });

test('utnyttelse = bookede timer / åpne timer minus sperringer', () => {
  const range = Reports.resolveRange({ from: week.from, to: week.to });
  const { rooms, weekdays } = Reports.utilization(range);
  const r = rooms.find((x) => x.id === room.id);
  assert.equal(r.availableHours, 32); // 4 åpne dager × 8 t (fredag sperret)
  assert.equal(r.bookedHours, 6);
  assert.equal(r.bookings, 2);
  assert.equal(r.cancelled, 1);
  assert.equal(r.utilization, 6 / 32);
  assert.equal(r.avgMinutes, 180);
  assert.equal(weekdays.find((w) => w.day === 1).hours, 4);
});

test('CSV er trygg mot formler, bruker semikolon og BOM, og eksporten logges', async () => {
  createAdmin('rapportor', 'manager');
  const agent = await login('rapportor');
  const res = await agent.get(`/admin/rapporter/bookinger.csv?fra=${week.from}&til=${week.to}`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /bookinger_2030-03-04_2030-03-10\.csv/);
  const text = res.text;
  assert.ok(text.startsWith('﻿'));
  assert.match(text, /^﻿Dato;Fra;Til;Rom;Tittel;Navn;E-post;Status;Gjentas;Booket av admin\r\n/);
  assert.match(text, /"'=HYPERLINK\(""http:\/\/ondt""\)"/);
  assert.match(text, /"Kari; Nordmann"/);
  assert.match(text, /Avlyst/);
  const log = db.prepare(`SELECT summary FROM audit_log WHERE action = 'report.exported' ORDER BY id DESC`).get();
  assert.match(log.summary, /3 bookinger med personopplysninger/);

  const util = await agent.get(`/admin/rapporter/utnyttelse.csv?fra=${week.from}&til=${week.to}`);
  assert.match(util.text, /Målerommet;2;1;6,0;32,0;18,8;180/);
});

test('rapportsiden vises for lesetilgang, men uten eksport', async () => {
  createAdmin('rapportleser', 'viewer');
  const agent = await login('rapportleser');
  const page = await agent.get(`/admin/rapporter?fra=${week.from}&til=${week.to}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Målerommet/);
  assert.match(page.text, /19 %/);
  assert.doesNotMatch(page.text, /bookinger\.csv/);
  assert.equal((await agent.get('/admin/rapporter/bookinger.csv')).status, 403);
});
