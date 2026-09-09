/**
 * Changelog pure-function tests — the parsing, classification, deploy mapping,
 * search and day-grouping the admin Changelog tab relies on. Canned git output,
 * so no repo and no database.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyCommits,
  classifySubject,
  GIT_FIELD_SEP as FS,
  GIT_RECORD_SEP as RS,
  groupCommitsByDay,
  matchesQuery,
  parseGitLog,
  parseNameOnlyLog,
  type RawCommit,
} from '../src/services/changelog';

const rec = (sha: string, authored: string, committed: string, subject: string, body: string) =>
  RS + [sha, authored, committed, subject, body].join(FS);

describe('parseGitLog', () => {
  test('parses multiple commits including multi-line bodies', () => {
    const raw =
      rec('aaa111', '2026-09-09T10:00:00-05:00', '2026-09-09T10:05:00-05:00', 'feat(social): share waypoints', 'line one\nline two') +
      rec('bbb222', '2026-09-08T09:00:00-05:00', '2026-09-08T09:00:00-05:00', 'fix: null guard', '');
    const commits = parseGitLog(raw);
    assert.equal(commits.length, 2);
    assert.equal(commits[0].sha, 'aaa111');
    assert.equal(commits[0].body, 'line one\nline two');
    assert.deepEqual(commits[0].files, []);
    assert.equal(commits[1].subject, 'fix: null guard');
  });

  test('skips empty and malformed chunks', () => {
    assert.deepEqual(parseGitLog(''), []);
    assert.deepEqual(parseGitLog(RS + 'only-one-field'), []);
  });
});

describe('parseNameOnlyLog', () => {
  test('maps each sha to its changed paths', () => {
    const raw = RS + 'aaa111\nserver/src/routes/social.ts\npublic/index.html\n' + RS + 'bbb222\nREADME.md\n';
    const map = parseNameOnlyLog(raw);
    assert.deepEqual(map.get('aaa111'), ['server/src/routes/social.ts', 'public/index.html']);
    assert.deepEqual(map.get('bbb222'), ['README.md']);
  });
});

describe('classifySubject', () => {
  test('splits type / scope / summary', () => {
    assert.deepEqual(classifySubject('feat(admin): add changelog tab'), {
      type: 'feat', scope: 'admin', summary: 'add changelog tab', breaking: false,
    });
  });

  test('handles a bare type and an unknown type', () => {
    assert.deepEqual(classifySubject('fix: null guard'), { type: 'fix', scope: null, summary: 'null guard', breaking: false });
    assert.equal(classifySubject('wip: poking at it').type, 'other');
    assert.equal(classifySubject('no prefix at all').type, 'other');
    assert.equal(classifySubject('no prefix at all').summary, 'no prefix at all');
  });

  test('flags breaking changes', () => {
    assert.equal(classifySubject('feat(api)!: drop the v1 routes').breaking, true);
    assert.equal(classifySubject('refactor: BREAKING CHANGE in the KV contract').breaking, true);
  });
});

const raw = (sha: string, committedAt: string, subject: string, body = '', files: string[] = []): RawCommit => ({
  sha, authoredAt: committedAt, committedAt, subject, body, files,
});

describe('classifyCommits', () => {
  test('marks commits newer than the newest deployed one as pending', () => {
    const commits = [
      raw('new2', '2026-09-09T12:00:00-05:00', 'feat: newest, not shipped'),
      raw('new1', '2026-09-09T11:00:00-05:00', 'fix: also not shipped'),
      raw('old1', '2026-09-09T10:00:00-05:00', 'feat: shipped'),
      raw('old0', '2026-09-08T10:00:00-05:00', 'chore: shipped earlier'),
    ];
    const deployed = new Map([['old1', '2026-09-09T10:30:00-05:00']]);
    const out = classifyCommits(commits, deployed);
    assert.deepEqual(out.map((c) => c.deployPending), [true, true, false, false]);
    assert.equal(out[2].deployedAt, '2026-09-09T10:30:00-05:00');
    // Older than the deployed one, unmapped: not pending, just untracked.
    assert.equal(out[3].deployedAt, null);
    assert.equal(out[3].deployPending, false);
  });

  test('nothing is pending when no deploy is known', () => {
    const out = classifyCommits([raw('a', '2026-09-09T10:00:00-05:00', 'feat: x')], new Map());
    assert.equal(out[0].deployPending, false);
    assert.equal(out[0].shortSha, 'a');
  });
});

describe('matchesQuery', () => {
  const [c] = classifyCommits(
    [raw('abc1234567', '2026-09-09T10:00:00-05:00', 'feat(social): share waypoints', 'friends can see them', ['server/src/routes/social.ts'])],
    new Map()
  );

  test('matches subject, body, scope, sha prefix and files', () => {
    for (const q of ['waypoint', 'FRIENDS can', 'social', 'abc12', 'routes/social']) {
      assert.equal(matchesQuery(c, q), true, q);
    }
  });

  test('an empty query matches everything, an unrelated one nothing', () => {
    assert.equal(matchesQuery(c, '   '), true);
    assert.equal(matchesQuery(c, 'stripe'), false);
    // A sha match is a prefix, not a substring.
    assert.equal(matchesQuery(c, '1234567'), false);
  });
});

describe('groupCommitsByDay', () => {
  test('buckets by Central-Time day, preserving order', () => {
    const commits = classifyCommits(
      [
        raw('a', '2026-09-09T23:30:00-05:00', 'feat: late night'),
        raw('b', '2026-09-09T08:00:00-05:00', 'fix: same day'),
        raw('c', '2026-09-08T08:00:00-05:00', 'docs: day before'),
      ],
      new Map()
    );
    const groups = groupCommitsByDay(commits);
    assert.deepEqual(groups.map((g) => g.date), ['2026-09-09', '2026-09-08']);
    assert.equal(groups[0].commits.length, 2);
    assert.match(groups[0].label, /September 9, 2026/);
  });

  test('a UTC timestamp lands on the Central-Time day, not the UTC one', () => {
    // 02:00Z on the 10th is 21:00 CT on the 9th.
    const groups = groupCommitsByDay(classifyCommits([raw('a', '2026-09-10T02:00:00Z', 'feat: x')], new Map()));
    assert.equal(groups[0].date, '2026-09-09');
  });
});
