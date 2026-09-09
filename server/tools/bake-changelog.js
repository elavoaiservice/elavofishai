/**
 * Bake the commit history into the image so the admin Changelog tab works in a
 * container that has no .git (the same trick as build-info.json).
 *
 *   node tools/bake-changelog.js <git-dir> <out-file> [max-count]
 *
 * Writes a JSON array of { sha, authoredAt, committedAt, subject, body, files }
 * — the RawCommit shape server/src/services/changelog.ts reads. Never fails the
 * build: on any error it writes an empty array and the tab falls back to live
 * git (or reports that history isn't available).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const FS_SEP = '\x1f';
const RS_SEP = '\x1e';

const gitDir = process.argv[2] || '/app/.git';
const outFile = process.argv[3] || './dist/changelog.json';
const maxCount = Number(process.argv[4] || 2000);

function git(args) {
  return execFileSync('git', ['-c', "safe.directory=*", '--git-dir=' + gitDir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseMeta(raw) {
  const out = [];
  for (const chunk of raw.split(RS_SEP)) {
    if (!chunk.trim()) continue;
    const fields = chunk.split(FS_SEP);
    if (fields.length < 5) continue;
    const [sha, authoredAt, committedAt, subject, ...body] = fields;
    out.push({
      sha: sha.trim(),
      authoredAt: authoredAt.trim(),
      committedAt: committedAt.trim(),
      subject: subject.trim(),
      body: body.join(FS_SEP).trim(),
      files: [],
    });
  }
  return out;
}

try {
  const meta = git([
    'log', `--max-count=${maxCount}`, '--no-merges',
    `--pretty=format:${RS_SEP}%H${FS_SEP}%aI${FS_SEP}%cI${FS_SEP}%s${FS_SEP}%b`,
  ]);
  const commits = parseMeta(meta);

  // Second pass for changed paths, so searching by file works in the container.
  const files = git([
    'log', `--max-count=${maxCount}`, '--no-merges', '--name-only',
    `--pretty=format:${RS_SEP}%H`,
  ]);
  const byShaEntries = files
    .split(RS_SEP)
    .filter((c) => c.trim())
    .map((chunk) => {
      const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
      return [lines.shift(), lines];
    });
  const bySha = new Map(byShaEntries);
  for (const c of commits) c.files = bySha.get(c.sha) || [];

  fs.writeFileSync(outFile, JSON.stringify(commits));
  console.log(`changelog: baked ${commits.length} commits → ${outFile}`);
} catch (e) {
  console.warn('changelog: bake failed, writing empty history —', e.message);
  fs.writeFileSync(outFile, '[]');
}
