import fs from 'fs';
import path from 'path';

// "Current" = the git commit this image was built from (baked into
// dist/build-info.json at Docker build time). "Target" = the latest commit on
// the tracked branch of the public GitHub repo — what an upgrade would pull.

export interface BuildInfo {
  commit?: string;
  commitShort?: string;
  subject?: string;
  committedAt?: string;
  branch?: string;
  version?: string;
  builtAt?: string;
}

let cachedBuild: BuildInfo | null = null;
export function buildInfo(): BuildInfo {
  if (cachedBuild) return cachedBuild;
  let info: BuildInfo = {};
  try {
    info = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
  } catch {
    /* not baked (e.g. local dev) — fall through to package.json */
  }
  if (!info.version) {
    try {
      info.version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
    } catch {
      /* ignore */
    }
  }
  cachedBuild = info;
  return info;
}

const REPO = process.env.UPGRADE_REPO || 'elavoaiservice/elavofishai';
function targetBranch(): string {
  return process.env.UPGRADE_BRANCH || buildInfo().branch || 'main';
}

export interface TargetInfo {
  branch: string;
  commit?: string;
  commitShort?: string;
  subject?: string;
  committedAt?: string;
  error?: string;
}

let targetCache: { at: number; data: TargetInfo } | null = null;

// Latest commit on the tracked branch, cached 60s to avoid hammering GitHub.
export async function targetVersion(): Promise<TargetInfo> {
  const now = Date.now();
  if (targetCache && now - targetCache.at < 60_000) return targetCache.data;
  const branch = targetBranch();
  const data: TargetInfo = { branch };
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'ElavoFishAI' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(branch)}`, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const j = (await r.json()) as { sha?: string; commit?: { message?: string; committer?: { date?: string } } };
      data.commit = j.sha;
      data.commitShort = (j.sha || '').slice(0, 7);
      data.subject = (j.commit?.message || '').split('\n')[0];
      data.committedAt = j.commit?.committer?.date;
    } else {
      data.error = `GitHub returned ${r.status}`;
    }
  } catch (e) {
    data.error = (e as Error).message.slice(0, 80) || 'could not reach GitHub';
  }
  targetCache = { at: now, data };
  return data;
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'ElavoFishAI' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

export interface IncomingCommit {
  sha: string; // short
  subject: string;
  /** Full sha, ISO commit time and message body — used by the changelog feed,
   *  which shows these as "not deployed" rows. */
  fullSha?: string;
  committedAt?: string;
  body?: string;
}

// The commits on the branch that the running build doesn't have yet (base..head),
// newest first — this is the "Incoming" list shown before an upgrade.
export async function incomingCommits(baseSha: string, headSha: string): Promise<IncomingCommit[]> {
  if (!baseSha || !headSha || baseSha === headSha) return [];
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/compare/${baseSha}...${headSha}`, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return [];
    const j = (await r.json()) as {
      commits?: { sha?: string; commit?: { message?: string; committer?: { date?: string } } }[];
    };
    return (j.commits || [])
      .map((c) => {
        const message = c.commit?.message || '';
        const nl = message.indexOf('\n');
        return {
          sha: (c.sha || '').slice(0, 7),
          fullSha: c.sha || '',
          subject: nl === -1 ? message : message.slice(0, nl),
          body: nl === -1 ? '' : message.slice(nl + 1).trim(),
          committedAt: c.commit?.committer?.date,
        };
      })
      .reverse(); // newest first
  } catch {
    return [];
  }
}

export interface VersionStatus {
  environment: string;
  branch: string;
  current: BuildInfo;
  target: TargetInfo;
  upToDate: boolean;
  incoming: IncomingCommit[];
}

export async function versionStatus(): Promise<VersionStatus> {
  const current = buildInfo();
  const target = await targetVersion();
  const upToDate = !!current.commit && !!target.commit && current.commit === target.commit;
  const incoming = upToDate || !current.commit || !target.commit
    ? []
    : await incomingCommits(current.commit, target.commit);
  return {
    environment: process.env.NODE_ENV || 'development',
    branch: target.branch,
    current,
    target,
    upToDate,
    incoming,
  };
}
