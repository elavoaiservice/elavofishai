/**
 * Changelog service — turns raw `git log` output into a clean, searchable,
 * date-grouped feed for the admin Changelog tab. Ported from ElavoAI's
 * changelog so both apps read the same way.
 *
 * The parsing, conventional-commit classification, search and day-grouping are
 * pure functions (unit-tested without a repo). The one impure part is loading
 * the commits, which differs from ElavoAI: this app runs in a container with no
 * .git, so the history is baked into `dist/changelog.json` at image build time
 * (like build-info.json). Outside the container it shells out to git, so the
 * tab works in local development too.
 *
 * Dates are grouped + displayed in Central Time, matching ElavoAI.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const TZ = 'America/Chicago';

/** Field + record separators used in the git --pretty format (ASCII US/RS). */
export const GIT_FIELD_SEP = '\x1f';
export const GIT_RECORD_SEP = '\x1e';

/** Metadata format: RECORD_SEP first so the body (the trailing field) can run
 *  to the end of the record without colliding with anything after it.
 *  Order: hash, authorISO, committerISO, subject, body. */
export const GIT_PRETTY_FORMAT =
  `${GIT_RECORD_SEP}%H${GIT_FIELD_SEP}%aI${GIT_FIELD_SEP}%cI${GIT_FIELD_SEP}%s${GIT_FIELD_SEP}%b`;

/** Files format for the search pass: RECORD_SEP + hash, then --name-only
 *  appends the changed paths on their own lines. */
export const GIT_FILES_FORMAT = `${GIT_RECORD_SEP}%H`;

export type CommitType =
  | 'feat' | 'fix' | 'docs' | 'refactor' | 'perf'
  | 'test' | 'chore' | 'style' | 'build' | 'ci' | 'revert' | 'other';

export interface RawCommit {
  sha: string;
  authoredAt: string; // ISO
  committedAt: string; // ISO
  subject: string;
  body: string;
  files: string[]; // changed paths — empty unless the search pass ran
}

export interface ClassifiedCommit extends RawCommit {
  shortSha: string;
  type: CommitType;
  scope: string | null;
  summary: string; // subject minus the `type(scope):` prefix
  breaking: boolean;
  deployedAt: string | null; // ISO — when this code went live
  deployPending: boolean; // committed on the branch but not in the running build
}

export interface DayGroup {
  /** YYYY-MM-DD in Central Time — stable grouping key. */
  date: string;
  /** Human label, e.g. "Wednesday, September 9, 2026". */
  label: string;
  commits: ClassifiedCommit[];
}

/** Conventional-commit type → display metadata for the UI. */
export const COMMIT_TYPE_META: Record<CommitType, { label: string; emoji: string }> = {
  feat: { label: 'Feature', emoji: '✨' },
  fix: { label: 'Fix', emoji: '🐛' },
  perf: { label: 'Perf', emoji: '⚡' },
  refactor: { label: 'Refactor', emoji: '♻️' },
  docs: { label: 'Docs', emoji: '📝' },
  test: { label: 'Tests', emoji: '🧪' },
  build: { label: 'Build', emoji: '📦' },
  ci: { label: 'CI', emoji: '🔧' },
  style: { label: 'Style', emoji: '💅' },
  chore: { label: 'Chore', emoji: '🧹' },
  revert: { label: 'Revert', emoji: '⏪' },
  other: { label: 'Other', emoji: '•' },
};

const KNOWN_TYPES = new Set<CommitType>([
  'feat', 'fix', 'docs', 'refactor', 'perf',
  'test', 'chore', 'style', 'build', 'ci', 'revert',
]);

/**
 * Parse the metadata blob (GIT_PRETTY_FORMAT) into commit records. Each record
 * starts at a RECORD_SEP and has five FIELD_SEP-delimited fields; the fifth
 * (body) runs to the end of the record.
 */
export function parseGitLog(raw: string): RawCommit[] {
  const out: RawCommit[] = [];
  for (const chunk of raw.split(GIT_RECORD_SEP)) {
    if (!chunk.trim()) continue;
    const fields = chunk.split(GIT_FIELD_SEP);
    if (fields.length < 5) continue; // malformed — skip defensively
    const [sha, authoredAt, committedAt, subject, ...bodyParts] = fields;
    out.push({
      sha: sha.trim(),
      authoredAt: authoredAt.trim(),
      committedAt: committedAt.trim(),
      subject: subject.trim(),
      body: bodyParts.join(GIT_FIELD_SEP).trim(),
      files: [],
    });
  }
  return out;
}

/** Parse the `--name-only` pass into a sha → files map. */
export function parseNameOnlyLog(raw: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const chunk of raw.split(GIT_RECORD_SEP)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    const sha = lines.shift();
    if (!sha) continue;
    map.set(sha, lines);
  }
  return map;
}

/** Split a conventional-commit subject into type / scope / summary. */
export function classifySubject(subject: string): {
  type: CommitType;
  scope: string | null;
  summary: string;
  breaking: boolean;
} {
  // type(scope)!: summary  |  type!: summary  |  type: summary
  const m = subject.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.*)$/i);
  if (!m) return { type: 'other', scope: null, summary: subject, breaking: false };
  const rawType = m[1].toLowerCase() as CommitType;
  const type = KNOWN_TYPES.has(rawType) ? rawType : 'other';
  return {
    type,
    scope: m[2] ? m[2].trim() : null,
    summary: m[4]?.trim() || subject,
    breaking: m[3] === '!' || /BREAKING CHANGE/.test(subject),
  };
}

/**
 * Classify commits + attach deploy times. `shaToDeployedAt` maps a commit to
 * the time the build carrying it went live. A commit with no mapped deploy is
 * `deployPending` when it is NEWER (lower index — the log is newest-first) than
 * the newest commit that DID deploy; older unmapped commits simply predate
 * deploy tracking and get deployedAt=null without the pending flag.
 */
export function classifyCommits(
  raw: RawCommit[],
  shaToDeployedAt: Map<string, string>
): ClassifiedCommit[] {
  let newestDeployedIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    if (shaToDeployedAt.has(raw[i].sha)) {
      newestDeployedIdx = i;
      break;
    }
  }
  return raw.map((c, idx) => {
    const { type, scope, summary, breaking } = classifySubject(c.subject);
    const deployedAt = shaToDeployedAt.get(c.sha) ?? null;
    const deployPending = deployedAt === null && newestDeployedIdx >= 0 && idx < newestDeployedIdx;
    return { ...c, shortSha: c.sha.slice(0, 7), type, scope, summary, breaking, deployedAt, deployPending };
  });
}

/** Case-insensitive keyword match across subject, body, scope, sha and files. */
export function matchesQuery(c: ClassifiedCommit, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (c.subject.toLowerCase().includes(q)) return true;
  if (c.body.toLowerCase().includes(q)) return true;
  if (c.scope?.toLowerCase().includes(q)) return true;
  if (c.shortSha.toLowerCase().startsWith(q)) return true;
  return c.files.some((f) => f.toLowerCase().includes(q));
}

const DAY_KEY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const DAY_LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});

/** Group commits into per-day buckets (Central Time), preserving order. */
export function groupCommitsByDay(commits: ClassifiedCommit[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const c of commits) {
    const d = new Date(c.committedAt);
    const key = DAY_KEY_FMT.format(d);
    if (!current || current.date !== key) {
      current = { date: key, label: DAY_LABEL_FMT.format(d), commits: [] };
      groups.push(current);
    }
    current.commits.push(c);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Loading the history (impure)
// ---------------------------------------------------------------------------

/** Newest-first commits scanned from HEAD. */
export const MAX_SCAN = 2000;

// The Dockerfile bakes this to dist/changelog.json, but this module compiles to
// dist/services/, so __dirname is one level deeper — the original path silently
// missed the file in the container and fell through to `git`, which isn't
// installed in the runtime image ("spawn git ENOENT"). Tests never caught it:
// under tsx there is no baked file at all, so the git fallback is the only path
// exercised. Look in both places.
const BAKED_CANDIDATES = [
  path.join(__dirname, '..', 'changelog.json'), // dist/changelog.json (compiled)
  path.join(__dirname, 'changelog.json'), // alongside, if the layout changes
];

export interface History {
  commits: RawCommit[];
  /** 'baked' = read from the image, 'git' = read live from a checkout. */
  source: 'baked' | 'git';
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd: path.join(__dirname, '..', '..'), // repo root from server/dist or server/src
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000,
  });
  return stdout;
}

/**
 * The commit history behind the running build. Prefers the baked file (the
 * container has no .git); falls back to live git for local development.
 * Throws only when neither is available.
 */
export async function loadHistory(withFiles: boolean): Promise<History> {
  for (const file of BAKED_CANDIDATES) {
    try {
      const baked = JSON.parse(fs.readFileSync(file, 'utf8')) as RawCommit[];
      if (Array.isArray(baked) && baked.length) {
        return { commits: baked.map((c) => ({ ...c, files: c.files || [] })), source: 'baked' };
      }
    } catch {
      /* try the next location, then fall through to live git */
    }
  }

  const rawLog = await git(['log', `--max-count=${MAX_SCAN}`, '--no-merges', `--pretty=format:${GIT_PRETTY_FORMAT}`]);
  const commits = parseGitLog(rawLog);
  if (withFiles) {
    try {
      const rawFiles = await git([
        'log', `--max-count=${MAX_SCAN}`, '--no-merges', '--name-only', `--pretty=format:${GIT_FILES_FORMAT}`,
      ]);
      const filesBySha = parseNameOnlyLog(rawFiles);
      for (const c of commits) c.files = filesBySha.get(c.sha) ?? [];
    } catch {
      /* search will just miss file matches */
    }
  }
  return { commits, source: 'git' };
}
