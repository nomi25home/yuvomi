/**
 * Test: EIN Formatierer je Zone, nicht einer je Aufruf.
 *
 * Die Serien-Expansion liest seit #2034 je Vorkommen bis zu fuenf Offsets ueber
 * utcToWall, und jeder Aufruf legte einen neuen `Intl.DateTimeFormat` an - der
 * teure Teil. Gezaehlt wird der Konstruktor, nicht die Zeit: eine Zeitgrenze
 * waere auf einem langsamen Runner rot und auf einem schnellen bedeutungslos.
 *
 * Ausfuehren: npm run test:timezone-formatter-cache
 */

process.env.TZ = process.env.TZ || 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';

const RealDateTimeFormat = Intl.DateTimeFormat;
let constructed = [];
// Der Wrapper zaehlt und reicht durch - `new` und Aufruf ohne `new` wie das Original.
function CountingDateTimeFormat(locales, options) {
  constructed.push({ zone: options?.timeZone, key: JSON.stringify(options ?? {}) });
  return new RealDateTimeFormat(locales, options);
}
CountingDateTimeFormat.prototype = RealDateTimeFormat.prototype;
CountingDateTimeFormat.supportedLocalesOf = RealDateTimeFormat.supportedLocalesOf;
Intl.DateTimeFormat = CountingDateTimeFormat;

const { utcToWall, localToUTC } = await import('../server/utils/timezone.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');

const hour = 3600000;

function weekly({ id, start, tzid }) {
  return {
    id, start_datetime: start, end_datetime: new Date(Date.parse(start) + hour).toISOString().replace('.000Z', 'Z'),
    recurrence_rule: 'FREQ=WEEKLY', tzid, all_day: 0,
  };
}

test('eine Wochenserie ueber ein Jahr legt je Zone und Format hoechstens einen Formatierer an', () => {
  constructed = [];
  const rows = expandRecurringEvents(
    [
      weekly({ id: 1, start: '2031-01-06T08:00:00Z', tzid: 'Europe/Brussels' }),
      weekly({ id: 2, start: '2031-01-06T14:00:00Z', tzid: 'America/New_York' }),
    ],
    '2031-01-01', '2031-12-31', null, { maxIterations: 5000 },
  );
  assert.ok(rows.length >= 100, `Reichweite: die Serien wurden expandiert (${rows.length} Vorkommen)`);
  for (const zone of ['Europe/Brussels', 'America/New_York']) {
    const perOptions = new Map();
    for (const c of constructed.filter((c) => c.zone === zone)) perOptions.set(c.key, (perOptions.get(c.key) ?? 0) + 1);
    assert.ok(perOptions.size > 0, `Reichweite: ${zone} wurde ueberhaupt formatiert`);
    for (const [key, count] of perOptions) {
      assert.equal(count, 1, `${zone}: ${count} Formatierer fuer dieselben Optionen (${key}) - einer je Aufruf statt je Zone`);
    }
  }
});

test('Schreibweisen derselben Zone teilen sich einen Formatierer', () => {
  utcToWall('2031-06-01T10:00:00Z', 'Asia/Tokyo');
  constructed = [];
  assert.deepEqual(utcToWall('2031-06-01T10:00:00Z', 'asia/tokyo'), { date: '2031-06-01', time: '19:00:00' });
  assert.deepEqual(utcToWall('2031-06-01T10:00:00Z', 'ASIA/TOKYO'), { date: '2031-06-01', time: '19:00:00' });
  assert.equal(constructed.length, 0, `${constructed.length} Formatierer fuer zwei Schreibweisen einer schon gemerkten Zone`);
});

test('localToUTC: der zweite Aufruf in derselben Zone legt keinen Formatierer an', () => {
  // Die Serien-Expansion ruft localToUTC nur als Rueckfall - ohne diesen Fall
  // bliebe die Haelfte des Speichers ungeprueft.
  assert.equal(localToUTC('2031-06-01T10:00:00', 'Asia/Tokyo'), '2031-06-01T01:00:00Z');
  constructed = [];
  assert.equal(localToUTC('2031-06-01T10:00:00', 'Asia/Tokyo'), '2031-06-01T01:00:00Z');
  assert.equal(constructed.length, 0, `${constructed.length} Formatierer beim zweiten localToUTC in Asia/Tokyo`);
});

test('eine ungueltige Zone scheitert jedes Mal und vergiftet den Speicher nicht', () => {
  assert.equal(utcToWall('2031-06-01T10:00:00Z', 'Mars/Olympus_Mons'), null);
  assert.equal(utcToWall('2031-06-01T10:00:00Z', 'Mars/Olympus_Mons'), null);
  // localToUTC gibt bei ungueltiger Zone die Eingabe zurueck - auch beim zweiten Mal.
  assert.equal(localToUTC('2031-06-01T10:00:00', 'Mars/Olympus_Mons'), '2031-06-01T10:00:00');
  assert.equal(localToUTC('2031-06-01T10:00:00', 'Mars/Olympus_Mons'), '2031-06-01T10:00:00');
  // Eine gueltige Zone danach rechnet weiter richtig.
  assert.deepEqual(utcToWall('2031-06-01T10:00:00Z', 'Europe/Brussels'), { date: '2031-06-01', time: '12:00:00' });
});
