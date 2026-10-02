const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, db, models, request, createRoom, at } = require('./helpers');
const Recurrence = require('../src/recurrence');
const mailer = require('../src/services/mailer');
const { hashToken } = require('../src/tokens');

const outbox = [];
beforeEach(() => {
  outbox.length = 0;
  mailer.setTransport({ sendMail: async (m) => outbox.push(m) });
});

test('ukentlig serie holder klokkeslettet over overgangen til sommertid', () => {
  const { occurrences, rule } = Recurrence.expand({
    start: new Date(at('2030-03-18', '10:00')),
    end: new Date(at('2030-03-18', '11:00')),
    pattern: 'weekly',
    until: '2030-04-08',
  });
  assert.deepEqual(
    occurrences.map((o) => o.start.toISOString()),
    [at('2030-03-18', '10:00'), at('2030-03-25', '10:00'), at('2030-04-01', '10:00'), at('2030-04-08', '10:00')]
  );
  assert.equal(occurrences[2].start.toISOString(), '2030-04-01T08:00:00.000Z');
  assert.deepEqual(rule.byDay, [1]);
  assert.equal(rule.durationMinutes, 60);
});

test('ukedager hopper over helg, annenhver uke hopper en uke, og for lange serier avvises', () => {
  const weekdays = Recurrence.expand({
    start: new Date(at('2030-03-07', '09:00')),
    end: new Date(at('2030-03-07', '09:30')),
    pattern: 'weekdays',
    until: '2030-03-12',
  });
  assert.equal(weekdays.occurrences.length, 4); // tor, fre, man, tir
  const biweekly = Recurrence.expand({
    start: new Date(at('2030-03-04', '09:00')),
    end: new Date(at('2030-03-04', '10:00')),
    pattern: 'biweekly',
    until: '2030-04-01',
  });
  assert.equal(biweekly.occurrences.length, 3);
  assert.match(
    Recurrence.expand({ start: new Date(at('2030-03-04', '09:00')), end: new Date(at('2030-03-04', '10:00')), pattern: 'weekdays', until: '2030-06-01' }).error,
    /maks 26/
  );
});

test('serie bookes med én bekreftelse, hopper over opptatte datoer og gir én kalenderinvitasjon med RRULE', async () => {
  const room = createRoom({ name: 'Serierommet' });
  models.Bookings.create({
    roomId: room.id,
    title: 'Opptatt',
    organizerName: 'Annen',
    organizerEmail: 'annen@example.com',
    start: at('2030-03-25', '10:00'),
    end: at('2030-03-25', '11:00'),
  });

  const payload = {
    altcha: 'test-bypass',
    title: 'Ukesmøte',
    organizerName: 'Serie Sara',
    organizerEmail: 'sara@example.com',
    start: at('2030-03-18', '10:00'),
    end: at('2030-03-18', '11:00'),
    repeat: 'weekly',
    repeatUntil: '2030-04-15',
  };
  const refused = await request(app).post(`/api/rooms/${room.id}/bookings`).send(payload);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /25\. mars/);

  const res = await request(app).post(`/api/rooms/${room.id}/bookings`).send({ ...payload, skipConflicts: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.count, 4);
  assert.equal(res.body.skipped.length, 1);
  assert.equal(outbox.length, 1);

  const token = /\/booking\/([A-Za-z0-9_-]{32})/.exec(outbox[0].text)[1];
  const series = models.Bookings.byTokenHash(hashToken(token));
  assert.equal(series.length, 4);
  assert.ok(series.every((b) => b.status === 'pending' && b.series_id === series[0].series_id));

  await request(app).post(`/booking/${token}/bekreft`);
  const invite = outbox[1].icalEvent.content;
  assert.match(invite, /RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20300415T215959Z/);
  assert.match(invite, /EXDATE;TZID=Europe\/Oslo:20300325T100000/);
  assert.equal((invite.match(/BEGIN:VEVENT/g) || []).length, 1);

  // Flytt én forekomst: invitasjonen får en egen hendelse med RECURRENCE-ID.
  const second = series[1];
  await request(app)
    .post(`/booking/${token}/endre`)
    .type('form')
    .send({ id: second.id, date: '2030-04-01', startTime: '12:00', endTime: '13:00', title: 'Ukesmøte' });
  const updated = outbox.at(-1).icalEvent.content;
  assert.match(updated, /RECURRENCE-ID;TZID=Europe\/Oslo:20300401T100000/);
  assert.match(updated, /DTSTART;TZID=Europe\/Oslo:20300401T120000/);

  // Avlys én forekomst, deretter resten.
  const one = await request(app).post(`/booking/${token}/avbestill`).type('form').send({ id: series[2].id });
  assert.equal(one.status, 303);
  assert.match(outbox.at(-1).icalEvent.content, /RECURRENCE-ID;TZID=Europe\/Oslo:20300408T100000/);
  const all = await request(app).post(`/booking/${token}/avbestill`).type('form').send({ id: 'alle' });
  assert.equal(all.status, 303);
  const left = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE series_id = ? AND status != 'cancelled'`).get(series[0].series_id).n;
  assert.equal(left, 0);
  assert.doesNotMatch(outbox.at(-1).icalEvent.content, /RECURRENCE-ID/);
});
