// "Update Driftmail" for installations made with the Deploy to Cloudflare button.
//
// The button copies the repository into the deployer's GitHub account and
// connects that copy to Cloudflare, so a push to the copy redeploys. Upstream
// changes never arrive on their own. .github/workflows/sync-upstream.yml
// replaces the copy's tree with upstream's; this module tells an admin whether
// that would change anything, and starts it.
//
// Entirely optional: without GITHUB_UPDATE_TOKEN and GITHUB_UPDATE_REPO the
// card stays hidden, and deploying from a clone with `pnpm run deploy` is
// unaffected either way.

import type { Env } from "./env.ts";

export const DEFAULT_UPSTREAM = "Rajveer-Mahida/driftmail";
export const DEFAULT_UPSTREAM_REF = "master";
export const SYNC_WORKFLOW = "sync-upstream.yml";

const GITHUB = "https://api.github.com";

export type UpdateConfig = {
  token: string;
  repo: string;
  ref: string | null;
  upstream: string;
  upstreamRef: string;
};

export type CommitInfo = { sha: string; tree: string; message: string; date: string | null; url: string };

export type RunInfo = {
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
};

export type UpdateStatus =
  | { configured: false }
  | {
      configured: true;
      repo: string;
      upstream: string;
      upToDate: boolean;
      current: CommitInfo;
      latest: CommitInfo;
      lastRun: RunInfo | null;
    };

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Read the optional update settings. The upstream repository itself never
 *  shows the card: there is nothing to pull from. */
export function updateConfig(env: Env): UpdateConfig | null {
  const token = env.GITHUB_UPDATE_TOKEN?.trim();
  const repo = env.GITHUB_UPDATE_REPO?.trim();
  if (!token || !repo || !REPO_RE.test(repo)) return null;
  const upstream = env.DRIFTMAIL_UPSTREAM?.trim() || DEFAULT_UPSTREAM;
  if (repo.toLowerCase() === upstream.toLowerCase()) return null;
  return {
    token,
    repo,
    ref: env.GITHUB_UPDATE_REF?.trim() || null,
    upstream,
    upstreamRef: env.DRIFTMAIL_UPSTREAM_REF?.trim() || DEFAULT_UPSTREAM_REF,
  };
}

async function gh<T>(cfg: UpdateConfig, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${GITHUB}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${cfg.token}`,
      "x-github-api-version": "2022-11-28",
      // GitHub rejects requests without a User-Agent.
      "user-agent": "driftmail-updater",
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) {
    const hint =
      res.status === 401
        ? " — the GITHUB_UPDATE_TOKEN is invalid or expired."
        : res.status === 403 || res.status === 404
          ? ` — check that the token can access ${cfg.repo} (Contents, Actions: read and write).`
          : "";
    throw new GitHubError(res.status, `GitHub: ${json?.message ?? res.status}${hint}`);
  }
  return json as T;
}

type GhCommit = {
  sha: string;
  html_url: string;
  commit: { message: string; tree: { sha: string }; committer: { date: string } | null };
};

const toCommit = (c: GhCommit): CommitInfo => ({
  sha: c.sha,
  tree: c.commit.tree.sha,
  message: c.commit.message.split("\n")[0],
  date: c.commit.committer?.date ?? null,
  url: c.html_url,
});

async function defaultBranch(cfg: UpdateConfig): Promise<string> {
  if (cfg.ref) return cfg.ref;
  const repo = await gh<{ default_branch: string }>(cfg, `/repos/${cfg.repo}`);
  return repo.default_branch;
}

/**
 * Up to date means the copy's tree is byte-identical to upstream's — exactly
 * what the sync workflow produces — so no version numbers are needed.
 */
export async function getUpdateStatus(env: Env): Promise<UpdateStatus> {
  const cfg = updateConfig(env);
  if (!cfg) return { configured: false };

  const branch = await defaultBranch(cfg);
  const [current, latest, runs] = await Promise.all([
    gh<GhCommit>(cfg, `/repos/${cfg.repo}/commits/${encodeURIComponent(branch)}`),
    gh<GhCommit>(cfg, `/repos/${cfg.upstream}/commits/${encodeURIComponent(cfg.upstreamRef)}`),
    gh<{ workflow_runs: Array<{ status: string; conclusion: string | null; html_url: string; created_at: string }> }>(
      cfg,
      `/repos/${cfg.repo}/actions/workflows/${SYNC_WORKFLOW}/runs?per_page=1`,
    ).catch((err) => {
      // A copy made before the workflow existed: report it, don't fail.
      if (err instanceof GitHubError && err.status === 404) return { workflow_runs: [] };
      throw err;
    }),
  ]);

  const run = runs.workflow_runs[0];
  return {
    configured: true,
    repo: cfg.repo,
    upstream: cfg.upstream,
    upToDate: current.commit.tree.sha === latest.commit.tree.sha,
    current: toCommit(current),
    latest: toCommit(latest),
    lastRun: run
      ? { status: run.status, conclusion: run.conclusion, url: run.html_url, createdAt: run.created_at }
      : null,
  };
}

/** Start the sync workflow on the copy's deploy branch. */
export async function startUpdate(env: Env): Promise<{ repo: string; branch: string }> {
  const cfg = updateConfig(env);
  if (!cfg) throw new GitHubError(400, "Updates aren't configured: set GITHUB_UPDATE_TOKEN and GITHUB_UPDATE_REPO.");
  const branch = await defaultBranch(cfg);
  try {
    await gh(cfg, `/repos/${cfg.repo}/actions/workflows/${SYNC_WORKFLOW}/dispatches`, {
      method: "POST",
      body: { ref: branch },
    });
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      throw new GitHubError(
        404,
        `GitHub can't find .github/workflows/${SYNC_WORKFLOW} in ${cfg.repo}. Copy it from ${cfg.upstream} once; later updates keep it current.`,
      );
    }
    throw err;
  }
  return { repo: cfg.repo, branch };
}
