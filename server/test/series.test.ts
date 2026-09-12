/**
 * Season standings — the club spreadsheet, in code.
 *
 * The parts worth being careful about: ties (a weigh-in calls them the same
 * place), drops (the reason a blown Saturday doesn't end a season), and the
 * rule that an open event's provisional board never counts.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pointsForPlace, standings, type EventBoard, type SeriesRules } from '../src/routes/tournaments';

const RULES: SeriesRules = { scoring: 'points', pointsTop: 100, pointsStep: 1, dropWorst: 0 };
const angler = (id: string) => ({ id, displayName: id, avatarUrl: null });
const ev = (id: string, rows: [string, number][], counted = true): EventBoard => ({
  id, name: id, counted,
  rows: rows.map(([who, score]) => ({ user: angler(who), score, fish: 1, bigLb: score })),
});

describe('points', () => {
  test('first place scores the top, each place below one step less', () => {
    assert.equal(pointsForPlace(1, RULES), 100);
    assert.equal(pointsForPlace(2, RULES), 99);
    assert.equal(pointsForPlace(10, RULES), 91);
  });

  test('weighing a fish always beats staying home, however far down you finish', () => {
    assert.equal(pointsForPlace(500, RULES), 1);
    assert.equal(pointsForPlace(50, { ...RULES, pointsTop: 20, pointsStep: 5 }), 1);
  });
});

describe('standings', () => {
  test('adds up the season and ranks it', () => {
    const table = standings([ev('e1', [['ann', 18], ['bob', 12]]), ev('e2', [['bob', 22], ['ann', 9]])], RULES);
    // One win and one second each, so both are on 199 and the heavier season
    // breaks it — which is how a trail settles a tie at the banquet.
    assert.equal(table[0].points, 199);
    assert.equal(table[1].points, 199);
    assert.equal(table[0].user.id, 'bob');
    assert.equal(table[0].fished, 2);
  });

  test('winning more events beats being consistent', () => {
    const table = standings([
      ev('e1', [['ann', 20], ['bob', 19]]),
      ev('e2', [['ann', 20], ['bob', 19]]),
    ], RULES);
    assert.deepEqual(table.map((r) => r.user.id), ['ann', 'bob']);
    assert.equal(table[0].points, 200);
    assert.equal(table[1].points, 198);
  });

  test('an event still running does not count — a provisional board is not a result', () => {
    const table = standings([ev('done', [['ann', 10]]), ev('open', [['bob', 99]], false)], RULES);
    assert.deepEqual(table.map((r) => r.user.id), ['ann']);
  });

  test('a tie shares the place, the way a weigh-in would call it', () => {
    const table = standings([ev('e1', [['ann', 10], ['bob', 10], ['cal', 5]])], RULES);
    const by = Object.fromEntries(table.map((r) => [r.user.id, r]));
    assert.equal(by.ann.points, 100);
    assert.equal(by.bob.points, 100);
    assert.equal(by.cal.events[0].place, 3); // third, not second
  });

  test('drops throw away the worst results so one bad day does not end a season', () => {
    const rules = { ...RULES, dropWorst: 1 };
    const table = standings([
      ev('e1', [['ann', 20], ['bob', 10]]),
      ev('e2', [['ann', 20], ['bob', 10]]),
      ev('e3', [['bob', 20], ['ann', 1]]),   // ann's blown Saturday
    ], rules);
    const ann = table.find((r) => r.user.id === 'ann')!;
    assert.equal(ann.dropped, 1);
    assert.equal(ann.counted, 2);
    assert.equal(ann.points, 200);           // both wins, the bad one dropped
    assert.ok(ann.events.find((e) => e.id === 'e3')!.dropped);
  });

  test('dropping never takes an angler down to nothing', () => {
    const table = standings([ev('e1', [['ann', 5]])], { ...RULES, dropWorst: 3 });
    assert.equal(table[0].counted, 1);
    assert.ok(table[0].points > 0);
  });

  test('a weight season simply adds the pounds up', () => {
    const table = standings([ev('e1', [['ann', 18.5], ['bob', 22]]), ev('e2', [['bob', 3], ['ann', 12]])],
      { ...RULES, scoring: 'weight' });
    assert.deepEqual(table.map((r) => r.user.id), ['ann', 'bob']);
    assert.equal(table[0].points, 30.5);
    assert.equal(table[1].points, 25);
  });

  test('ties in the season are broken by total weight, then by the biggest fish', () => {
    const table = standings([ev('e1', [['ann', 10]]), ev('e2', [['bob', 25]])], RULES);
    assert.equal(table[0].points, table[1].points);   // both won one event
    assert.equal(table[0].user.id, 'bob');            // heavier season
  });

  test('a season with nothing finished is an empty table, not a crash', () => {
    assert.deepEqual(standings([], RULES), []);
    assert.deepEqual(standings([ev('e1', [], true)], RULES), []);
  });

  test('each angler can see which events counted and which were dropped', () => {
    const table = standings([ev('e1', [['ann', 9]]), ev('e2', [['ann', 3]])], { ...RULES, dropWorst: 1 });
    const ann = table[0];
    assert.equal(ann.events.length, 2);
    assert.equal(ann.events.filter((e) => e.dropped).length, 1);
    assert.equal(ann.bestPlace, 1);
  });
});
