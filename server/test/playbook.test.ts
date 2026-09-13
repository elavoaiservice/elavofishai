/**
 * The crappie playbook. The phases are chosen by water temperature first and
 * the month only as a fallback, which is the whole point of writing it down —
 * the same week of November has run 80°F one year and low 60s the next.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { phaseFor, playbookFor, playbookForPrompt } from '../src/services/playbook';

const crappie = playbookFor('crappie')!;

describe('finding a playbook', () => {
  test('matches however the species is written', () => {
    assert.ok(playbookFor('Crappie'));
    assert.ok(playbookFor('Black Crappie'));
    assert.ok(playbookFor('white crappie'));
  });
  test('returns nothing for a species we have not written up', () => {
    // Largemouth has its own book now; these genuinely do not.
    assert.equal(playbookFor('Flathead Catfish'), null);
    assert.equal(playbookFor('Walleye'), null);
    assert.equal(playbookFor(''), null);
    assert.equal(playbookForPrompt('Walleye', 5, 60), '');
  });
});

describe('which phase the water is in', () => {
  test('50 degrees in February is pre-spawn — the trigger everything hangs on', () => {
    assert.match(phaseFor(crappie, 2, 50)!.name, /pre-spawn/i);
  });
  test('44 degrees in January is winter, not pre-spawn', () => {
    assert.match(phaseFor(crappie, 1, 44)!.name, /winter/i);
  });
  test('60 degrees in March is the spawn', () => {
    assert.match(phaseFor(crappie, 3, 60)!.name, /spawn/i);
  });
  test('85 degrees is summer whatever the month says', () => {
    assert.match(phaseFor(crappie, 5, 85)!.name, /summer/i);
    assert.match(phaseFor(crappie, 9, 85)!.name, /summer/i);
  });
  // The same reading means two different things depending on the direction of
  // travel, so the month has to break the tie.
  test('68 degrees is post-spawn in May and late fall in November', () => {
    assert.match(phaseFor(crappie, 5, 68)!.name, /post-spawn/i);
    assert.match(phaseFor(crappie, 11, 68)!.name, /late fall/i);
  });
  test('falls back to the month when there is no temperature', () => {
    assert.match(phaseFor(crappie, 7, null)!.name, /summer/i);
    assert.match(phaseFor(crappie, 12, null)!.name, /winter/i);
  });
  test('every month of the year resolves to a phase', () => {
    for (let m = 1; m <= 12; m += 1) {
      assert.ok(phaseFor(crappie, m, null), `month ${m} has no phase`);
    }
  });
});

describe('what the planner is handed', () => {
  test('carries the laws, the phase and the mistakes', () => {
    const text = playbookForPrompt('crappie', 11, 62);
    assert.match(text, /ANGLER PLAYBOOK — CRAPPIE/);
    assert.match(text, /Late fall/i);
    assert.match(text, /62°F/);
    assert.match(text, /bait fish/i);
    assert.match(text, /Common mistakes/i);
    // It must defer to the lake's own evidence, not compete with it.
    assert.match(text, /follow the lake/i);
  });
  test('says plainly when it is guessing from the calendar', () => {
    const text = playbookForPrompt('crappie', 7, null);
    assert.match(text, /no water temperature available/i);
  });
  test('the source is named, because someone should be able to check it', () => {
    assert.match(playbookForPrompt('crappie', 3, 58), /crappiemoment/i);
  });
});

describe('the other two playbooks', () => {
  test('largemouth has its own book, and the other bass do not borrow it', () => {
    assert.equal(playbookFor('Largemouth Bass')!.species, 'largemouth bass');
    // The app also carries "White Bass" and "Striped & Hybrid"; neither is a
    // largemouth, and giving them largemouth advice would be worse than none.
    assert.equal(playbookFor('White Bass'), null);
    assert.equal(playbookFor('Striped & Hybrid'), null);
  });

  test('the sunfish book answers to what people actually call them', () => {
    for (const name of ['Sunfish', 'bluegill', 'Shellcracker', 'redear', 'bream']) {
      assert.ok(playbookFor(name), `${name} found no playbook`);
    }
  });

  test('every phase of every playbook covers a real temperature band and some months', () => {
    for (const name of ['crappie', 'largemouth bass', 'sunfish']) {
      const book = playbookFor(name)!;
      for (const p of book.phases) {
        assert.ok(p.tempF[0] < p.tempF[1], `${name}/${p.name} has an inverted range`);
        assert.ok(p.months.length > 0, `${name}/${p.name} has no months`);
        assert.ok(p.where && p.depth && p.presentation && p.bait && p.key, `${name}/${p.name} is missing a field`);
      }
      for (let m = 1; m <= 12; m += 1) {
        assert.ok(phaseFor(book, m, null), `${name} has no phase for month ${m}`);
      }
    }
  });

  test('bass in August is the late-summer grind, not the spawn', () => {
    assert.match(phaseFor(playbookFor('Largemouth Bass')!, 8, 88)!.name, /late summer/i);
  });

  test('panfish in June is the bedding window', () => {
    assert.match(phaseFor(playbookFor('Sunfish')!, 6, 78)!.name, /bedding/i);
  });

  test('each book names its source so it can be checked', () => {
    assert.match(playbookForPrompt('Largemouth Bass', 3, 55), /TacticalBassin/i);
    assert.match(playbookForPrompt('Sunfish', 6, 75), /RichardGene/i);
  });
});
