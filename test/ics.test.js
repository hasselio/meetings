const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const ics = require('../src/ics');

test('tekst escapes og lange linjer brettes uten å dele tegn', () => {
  assert.equal(ics.escapeText('a;b,c\\d\ne'), 'a\\;b\\,c\\\\d\\ne');
  const long = 'DESCRIPTION:' + 'æøå'.repeat(40);
  const folded = ics.fold(long);
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(folded.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join(''), long);
});

test('VTIMEZONE for Oslo får regler for sommertid og vintertid', () => {
  const out = ics.buildCalendar({
    method: 'REQUEST',
    events: [{ uid: 'x@y', start: new Date('2030-03-04T09:00:00Z'), end: new Date('2030-03-04T10:00:00Z'), summary: 'Test' }],
  });
  assert.match(out, /BEGIN:DAYLIGHT\r\nDTSTART:\d{4}03\d\dT020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU/);
  assert.match(out, /BEGIN:STANDARD\r\nDTSTART:\d{4}10\d\dT030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU/);
  assert.match(out, /DTSTART;TZID=Europe\/Oslo:20300304T100000/);
  assert.match(out, /METHOD:REQUEST/);
  assert.ok(out.endsWith('END:VCALENDAR\r\n'));
});

test('gjentakelse, unntak og forekomst skrives riktig', () => {
  const out = ics.buildCalendar({
    method: 'REQUEST',
    events: [
      {
        uid: 'serie@y',
        start: new Date('2030-03-04T09:00:00Z'),
        end: new Date('2030-03-04T10:00:00Z'),
        summary: 'Ukesmøte',
        rrule: { freq: 'WEEKLY', interval: 2, byDay: [1], until: new Date('2030-06-01T21:59:59Z') },
        exdates: [new Date('2030-04-01T08:00:00Z')],
      },
      {
        uid: 'serie@y',
        recurrenceId: new Date('2030-03-18T09:00:00Z'),
        start: new Date('2030-03-18T10:00:00Z'),
        end: new Date('2030-03-18T11:00:00Z'),
        summary: 'Ukesmøte (flyttet)',
      },
    ],
  });
  assert.match(out, /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;UNTIL=20300601T215959Z/);
  assert.match(out, /EXDATE;TZID=Europe\/Oslo:20300401T100000/);
  assert.match(out, /RECURRENCE-ID;TZID=Europe\/Oslo:20300318T100000/);
});
