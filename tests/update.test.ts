// "Update Driftmail" for Deploy-button copies: status from GitHub, and starting
// the sync workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubFetch } from "./fakes/env.ts";
import { getUpdateStatus, startUpdate, updateConfig, GitHubError } from "../apps/api/src/update.ts";

const ENV = { GITHUB_UPDATE_TOKEN: "ghp_test", GITHUB_UPDATE_REPO: "someone/my-driftmail" } as never;

const commit = (sha: string, tree: string, message = "feat: thing") => ({
  body: {
    sha,
    html_url: `https://github.com/x/commit/${sha}`,
    commit: { message: `${message}\n\nbody`, tree: { sha: tree }, committer: { date: "2026-11-01T00:00:00Z" } },
  },
});

function github(copyTree: string, upstreamTree: string, runs: unknown = { workflow_runs: [] }) {
  return stubFetch([
    { match: (u) => u.endsWith("/repos/someone/my-driftmail"), respond: () => ({ body: { default_branch: "main" } }) },
    { match: (u) => u.endsWith("/repos/someone/my-driftmail/commits/main"), respond: () => commit("c0ffee1", copyTree) },
    {
      match: (u) => u.endsWith("/repos/Rajveer-Mahida/driftmail/commits/master"),
      respond: () => commit("beef002", upstreamTree, "feat: domain rules"),
    },
    {
      match: (u) => u.includes("/actions/workflows/sync-upstream.yml/runs"),
      respond: () => (runs === 404 ? { status: 404, body: { message: "Not Found" } } : { body: runs }),
    },
    {
      match: (u, init) => u.endsWith("/actions/workflows/sync-upstream.yml/dispatches") && init?.method === "POST",
      respond: () => ({ body: {} }),
    },
  ]);
}

test("updates are off unless a token and the copy's repo are set", () => {
  assert.equal(updateConfig({} as never), null);
  assert.equal(updateConfig({ GITHUB_UPDATE_TOKEN: "t" } as never), null);
  assert.equal(updateConfig({ GITHUB_UPDATE_TOKEN: "t", GITHUB_UPDATE_REPO: "not a repo" } as never), null);
  // The upstream repository has nothing to pull from.
  assert.equal(updateConfig({ GITHUB_UPDATE_TOKEN: "t", GITHUB_UPDATE_REPO: "rajveer-mahida/Driftmail" } as never), null);
  assert.equal(updateConfig(ENV)?.upstream, "Rajveer-Mahida/driftmail");
});

test("an unconfigured instance reports that without calling GitHub", async () => {
  const { calls, restore } = stubFetch([]);
  try {
    assert.deepEqual(await getUpdateStatus({} as never), { configured: false });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("identical trees mean up to date; different trees mean an update", async () => {
  let gh = github("tree-a", "tree-a");
  try {
    const s = await getUpdateStatus(ENV);
    assert.equal(s.configured && s.upToDate, true);
    // Every call authenticates and names itself — GitHub rejects requests without a User-Agent.
    for (const c of gh.calls) {
      assert.equal(c.headers.authorization, "Bearer ghp_test");
      assert.equal(c.headers["user-agent"], "driftmail-updater");
    }
  } finally {
    gh.restore();
  }

  gh = github("tree-a", "tree-b", {
    workflow_runs: [{ status: "in_progress", conclusion: null, html_url: "https://run", created_at: "2026-11-03T00:00:00Z" }],
  });
  try {
    const s = await getUpdateStatus(ENV);
    assert.ok(s.configured);
    if (s.configured) {
      assert.equal(s.upToDate, false);
      assert.equal(s.latest.message, "feat: domain rules", "first line only");
      assert.deepEqual(s.lastRun, { status: "in_progress", conclusion: null, url: "https://run", createdAt: "2026-11-03T00:00:00Z" });
    }
  } finally {
    gh.restore();
  }
});

test("a copy made before the workflow existed still reports status", async () => {
  const gh = github("tree-a", "tree-b", 404);
  try {
    const s = await getUpdateStatus(ENV);
    assert.ok(s.configured && s.lastRun === null);
  } finally {
    gh.restore();
  }
});

test("starting an update dispatches the workflow on the deploy branch", async () => {
  const gh = github("tree-a", "tree-b");
  try {
    assert.deepEqual(await startUpdate(ENV), { repo: "someone/my-driftmail", branch: "main" });
    const dispatch = gh.calls.find((c) => c.url.endsWith("/dispatches"));
    assert.deepEqual(dispatch?.body, { ref: "main" });
  } finally {
    gh.restore();
  }

  await assert.rejects(startUpdate({} as never), (e: unknown) => e instanceof GitHubError && e.status === 400);
});

test("a missing workflow file says how to fix it", async () => {
  const { restore } = stubFetch([
    { match: (u) => u.endsWith("/repos/someone/my-driftmail"), respond: () => ({ body: { default_branch: "main" } }) },
    { match: (u) => u.endsWith("/dispatches"), respond: () => ({ status: 404, body: { message: "Not Found" } }) },
  ]);
  try {
    await assert.rejects(startUpdate(ENV), /Copy it from Rajveer-Mahida\/driftmail once/);
  } finally {
    restore();
  }
});
