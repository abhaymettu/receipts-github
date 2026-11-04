import { describe, expect, it } from "vitest";
import { fetchReceipts, gitHub, GitHubError, parsePullRef, runGroups } from "../src/client.ts";

interface Recorded {
  readonly status?: number;
  readonly link?: string;
  readonly body: unknown;
}

/** A fetch that answers from `recorded` by URL and keeps every request it saw. */
function replay(recorded: Record<string, Recorded>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const hit = recorded[url];
    if (hit === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const headers = new Headers(hit.link === undefined ? {} : { link: hit.link });
    const body = typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
    return new Response(body, { status: hit.status ?? 200, headers });
  };
  return { fake, seen };
}

const API = "https://api.github.com";
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OLD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("parsePullRef", () => {
  it("reads a pull request URL", () => {
    expect(parsePullRef("https://github.com/octo-org/hello.world/pull/123")).toEqual({ owner: "octo-org", repo: "hello.world", number: 123 });
  });

  it("reads a URL that points into the pull request", () => {
    expect(parsePullRef("https://github.com/o/r/pull/7/files#diff-1")).toEqual({ owner: "o", repo: "r", number: 7 });
  });

  it("reads the short form", () => {
    expect(parsePullRef("o/r#42")).toEqual({ owner: "o", repo: "r", number: 42 });
  });

  it("rejects issues, pull number zero and other hosts", () => {
    expect(parsePullRef("https://github.com/o/r/issues/1")).toBe(null);
    expect(parsePullRef("o/r#0")).toBe(null);
    expect(parsePullRef("https://gitlab.com/o/r/pull/1")).toBe(null);
    expect(parsePullRef("o/r")).toBe(null);
  });
});

describe("gitHub", () => {
  it("sends the API headers and the token", async () => {
    const { fake, seen } = replay({ [`${API}/rate_limit`]: { body: { ok: true } } });
    expect(await gitHub({ token: "t0k", fetch: fake }).json("/rate_limit")).toEqual({ ok: true });
    expect(seen[0]?.headers).toEqual({
      accept: "application/vnd.github+json",
      authorization: "Bearer t0k",
      "user-agent": "receipts-github",
      "x-github-api-version": "2022-11-28",
    });
  });

  it("sends no authorization header without a token", async () => {
    const { fake, seen } = replay({ [`${API}/rate_limit`]: { body: {} } });
    await gitHub({ token: null, fetch: fake }).json("/rate_limit");
    expect(seen[0]?.headers["authorization"]).toBe(undefined);
  });

  it("follows Link rel=next and concatenates the pages", async () => {
    const { fake, seen } = replay({
      [`${API}/repos/o/r/pulls/1/files?per_page=100`]: {
        body: [{ n: 1 }, { n: 2 }],
        link: `<${API}/repos/o/r/pulls/1/files?per_page=100&page=2>; rel="next", <${API}/repos/o/r/pulls/1/files?per_page=100&page=2>; rel="last"`,
      },
      [`${API}/repos/o/r/pulls/1/files?per_page=100&page=2`]: {
        body: [{ n: 3 }],
        link: `<${API}/repos/o/r/pulls/1/files?per_page=100&page=1>; rel="prev"`,
      },
    });
    const all = await gitHub({ token: null, fetch: fake }).pages("/repos/o/r/pulls/1/files", (page) => (Array.isArray(page) ? page : []));
    expect(all).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(seen.map((s) => s.url)).toEqual([
      `${API}/repos/o/r/pulls/1/files?per_page=100`,
      `${API}/repos/o/r/pulls/1/files?per_page=100&page=2`,
    ]);
  });

  it("names the status, path and GitHub's message when a request fails", async () => {
    const { fake } = replay({ [`${API}/repos/o/r/pulls/9`]: { status: 403, body: { message: "Resource not accessible by integration" } } });
    const failure = gitHub({ token: null, fetch: fake }).json("/repos/o/r/pulls/9");
    await expect(failure).rejects.toThrow("GitHub GET /repos/o/r/pulls/9 returned 403: Resource not accessible by integration");
    await expect(failure).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("runGroups", () => {
  it("keeps each Run group through its endgroup and nothing else", () => {
    const log = [
      "2026-11-04T01:20:07.1Z ##[group]Runner Image",
      "2026-11-04T01:20:07.2Z Image: ubuntu-24.04",
      "2026-11-04T01:20:07.3Z ##[endgroup]",
      "2026-11-04T01:20:08.0Z ##[group]Run npm ci",
      "2026-11-04T01:20:08.1Z \u001b[36;1mnpm ci\u001b[0m",
      "2026-11-04T01:20:08.2Z \u001b[36;1mnpm test\u001b[0m",
      "2026-11-04T01:20:08.3Z shell: /usr/bin/bash -e {0}",
      "2026-11-04T01:20:08.4Z ##[endgroup]",
      "2026-11-04T01:20:30.0Z added 312 packages",
    ].join("\r\n");
    expect(runGroups(log)).toBe(
      [
        "2026-11-04T01:20:08.0Z ##[group]Run npm ci",
        "2026-11-04T01:20:08.1Z \u001b[36;1mnpm ci\u001b[0m",
        "2026-11-04T01:20:08.2Z \u001b[36;1mnpm test\u001b[0m",
        "2026-11-04T01:20:08.3Z shell: /usr/bin/bash -e {0}",
        "2026-11-04T01:20:08.4Z ##[endgroup]",
      ].join("\n"),
    );
  });
});

describe("fetchReceipts", () => {
  const pull = { number: 5, html_url: "https://github.com/o/r/pull/5", title: "Fix it", body: "Tests pass.", user: { login: "bot", type: "Bot" }, head: { sha: HEAD } };
  const commits = [
    { sha: OLD, commit: { message: "first" } },
    { sha: HEAD, commit: { message: "second" } },
  ];
  const files = [{ filename: "src/x.ts", status: "modified", additions: 1, deletions: 0 }];
  const actionsRun = { id: 11, name: "test", head_sha: HEAD, status: "completed", conclusion: "success", html_url: "https://github.com/o/r/actions/runs/3/job/11", app: { slug: "github-actions" } };
  const otherRun = { id: 12, name: "codecov", head_sha: HEAD, status: "completed", conclusion: "success", html_url: null, app: { slug: "codecov" } };
  const expiredRun = { id: 13, name: "test", head_sha: OLD, status: "completed", conclusion: "failure", html_url: null, app: { slug: "github-actions" } };
  const status = { context: "ci/legacy", state: "success", target_url: null };

  const recorded: Record<string, Recorded> = {
    [`${API}/repos/o/r/pulls/5`]: { body: pull },
    [`${API}/repos/o/r/pulls/5/files?per_page=100`]: { body: files },
    [`${API}/repos/o/r/pulls/5/commits?per_page=100`]: { body: commits },
    [`${API}/repos/o/r/commits/${HEAD}/check-runs?per_page=100`]: { body: { total_count: 2, check_runs: [actionsRun, otherRun] } },
    [`${API}/repos/o/r/commits/${OLD}/check-runs?per_page=100`]: { body: { total_count: 1, check_runs: [expiredRun] } },
    [`${API}/repos/o/r/commits/${HEAD}/status?per_page=100`]: { body: { state: "success", statuses: [status] } },
    [`${API}/repos/o/r/commits/${OLD}/status?per_page=100`]: { body: { state: "pending", statuses: [] } },
    [`${API}/repos/o/r/actions/jobs/11/logs`]: { body: "T ##[group]Run npm test\nT shell: bash\nT ##[endgroup]\nT 5 passed" },
    [`${API}/repos/o/r/actions/jobs/13/logs`]: { status: 410, body: { message: "Gone" } },
  };

  it("returns the raw responses keyed by commit, with Run groups of the Actions logs it could read", async () => {
    const { fake, seen } = replay(recorded);
    const raw = await fetchReceipts({ github: gitHub({ token: "t", fetch: fake }), pull: { owner: "o", repo: "r", number: 5 } });
    expect(raw).toEqual({
      pull,
      files,
      commits,
      checkRuns: { [HEAD]: [actionsRun, otherRun], [OLD]: [expiredRun] },
      statuses: { [HEAD]: [status], [OLD]: [] },
      logs: { "11": "T ##[group]Run npm test\nT shell: bash\nT ##[endgroup]" },
    });
    expect(seen.some((s) => s.url.endsWith("/actions/jobs/12/logs"))).toBe(false);
  });

  it("fails on an error that is not a missing log", async () => {
    const { fake } = replay({ ...recorded, [`${API}/repos/o/r/actions/jobs/11/logs`]: { status: 500, body: { message: "Server Error" } } });
    await expect(fetchReceipts({ github: gitHub({ token: "t", fetch: fake }), pull: { owner: "o", repo: "r", number: 5 } })).rejects.toThrow(
      "GitHub GET /repos/o/r/actions/jobs/11/logs returned 500: Server Error",
    );
  });
});
