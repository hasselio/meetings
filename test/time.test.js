const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const time = require('../src/time');

test('lokal tid konverteres riktig til UTC om vinteren og sommeren', () => {
  assert.equal(time.zonedTimeToUtc(2030, 1, 15, 10, 0).toISOString(), '2030-01-15T09:00:00.000Z');
  assert.equal(time.zonedTimeToUtc(2030, 7, 15, 10, 0).toISOString(), '2030-07-15T08:00:00.000Z');
});

test('10:00 lokal tid holder seg på 10:00 over overgangen til sommertid', () => {
  // Sommertid starter siste søndag i mars 2030 (31. mars).
  const before = time.zonedTimeToUtc(2030, 3, 25, 10, 0);
  const after = time.zonedTimeToUtc(2030, 4, 1, 10, 0);
  assert.equal(time.localMinutes(before), 600);
  assert.equal(time.localMinutes(after), 600);
  assert.equal(after - before, 7 * 24 * 3600 * 1000 - 3600 * 1000);
});

test('offset og ukedag', () => {
  assert.equal(time.offsetMinutes(new Date('2030-01-01T12:00:00Z')), 60);
  assert.equal(time.offsetMinutes(new Date('2030-07-01T12:00:00Z')), 120);
  assert.equal(time.localParts(new Date('2030-03-04T09:00:00Z')).weekday, 1);
});

test('datoer og klokkeslett formateres på norsk', () => {
  const d = new Date('2030-03-04T09:05:00Z');
  assert.equal(time.formatTime(d), '10:05');
  assert.equal(time.localDateKey(d), '2030-03-04');
  assert.match(time.formatDay(d), /mandag 4\. mars/);
});

test('addDays håndterer månedsskifte og skuddår', () => {
  assert.deepEqual(time.addDays(2028, 2, 28, 1), { year: 2028, month: 2, day: 29 });
  assert.deepEqual(time.addDays(2030, 12, 31, 1), { year: 2031, month: 1, day: 1 });
});
