import { createHmac, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appJwt, verifySignature } from "../src/app/auth.ts";
import { APP_LIMITS, checkTarget } from "../src/app/check.ts";
import { targets, type Target } from "../src/app/events.ts";
import worker, { type Env } from "../src/bin/worker.ts";
import { gitHub } from "../src/client.ts";

const API = "https://api.github.com";
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OLD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const APP_ID = 4242;
const SECRET = "hook-secret";

const bytes = (text: string) => new TextEncoder().encode(text);
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("verifySignature", () => {
  it("accepts the HMAC GitHub sends and rejects anything else", async () => {
    const body = '{"zen":"Keep it logically awesome."}';
    expect(await verifySignature(SECRET, bytes(body), sign(body))).toBe(true);
    expect(await verifySignature(SECRET, bytes(body + " "), sign(body))).toBe(false);
    expect(await verifySignature("other", bytes(body), sign(body))).toBe(false);
    expect(await verifySignature(SECRET, bytes(body), null)).toBe(false);
    expect(await verifySignature(SECRET, bytes(body), "sha1=abc")).toBe(false);
  });
});

describe("appJwt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  it("signs an RS256 JWT for the App that lasts under ten minutes", async () => {
    const now = Date.UTC(2026, 10, 4, 1, 0, 0);
    const jwt = await appJwt({ appId: "4242", privateKey, now });
    const [head = "", claims = "", signature = ""] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(payload).toEqual({ iss: "4242", iat: now / 1000 - 60, exp: now / 1000 + 480 });
    expect(verify("RSA-SHA256", Buffer.from(`${head}.${claims}`), createPublicKey(publicKey), Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("says how to convert the PKCS#1 key GitHub hands out", async () => {
    const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
    await expect(appJwt({ appId: "1", privateKey: pkcs1, now: 0 })).rejects.toThrow("openssl pkcs8 -topk8 -nocrypt");
  });
});

const repository = { id: 7, name: "r", owner: { login: "o" } };
const installation = { id: 99 };
const suitePull = (number: number, repoId = 7) => ({ number, base: { repo: { id: repoId } } });

describe("targets", () => {
  const pullEvent = (action: string) => ({ action, installation, repository, pull_request: { number: 5, head: { sha: HEAD } } });

  it("checks a pull request when it opens, is edited, gets a push or reopens", () => {
    for (const action of ["opened", "edited", "synchronize", "reopened"]) {
      expect(targets("pull_request", pullEvent(action), APP_ID)).toEqual([{ installationId: 99, pull: { owner: "o", repo: "r", number: 5 }, sha: HEAD }]);
    }
    expect(targets("pull_request", pullEvent("closed"), APP_ID)).toEqual([]);
  });

  it("checks again when another app's suite completes, for this repository's pull requests only", () => {
    const suite = (appId: number, action = "completed") => ({
      action,
      installation,
      repository,
      check_suite: { app: { id: appId }, head_sha: HEAD, pull_requests: [suitePull(5), suitePull(8, 1234)] },
    });
    expect(targets("check_suite", suite(15368), APP_ID)).toEqual([{ installationId: 99, pull: { owner: "o", repo: "r", number: 5 }, sha: HEAD }]);
    expect(targets("check_suite", suite(APP_ID), APP_ID)).toEqual([]);
    expect(targets("check_suite", suite(15368, "requested"), APP_ID)).toEqual([]);
  });

  it("checks again when someone re-runs the App's own check run, and ignores other check runs", () => {
    const run = (appId: number, action: string) => ({
      action,
      installation,
      repository,
      check_run: { app: { id: appId }, head_sha: HEAD, pull_requests: [suitePull(5)] },
    });
    expect(targets("check_run", run(APP_ID, "rerequested"), APP_ID)).toHaveLength(1);
    expect(targets("check_run", run(APP_ID, "completed"), APP_ID)).toEqual([]);
    expect(targets("check_run", run(15368, "rerequested"), APP_ID)).toEqual([]);
  });

  it("does nothing for events it does not subscribe to", () => {
    expect(targets("ping", { zen: "Design for failure." }, APP_ID)).toEqual([]);
  });
});

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/** A fetch that answers `METHOD url` from `routes` and keeps every request it saw, with its JSON body. */
function replay(routes: Record<string, unknown>) {
  const sent: Sent[] = [];
  const fake: typeof fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    sent.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const hit = routes[`${method} ${url}`];
    if (hit === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(typeof hit === "string" ? hit : JSON.stringify(hit), { status: 200 });
  };
  return { fake, sent };
}

describe("checkTarget", () => {
  const target: Target = { installationId: 99, pull: { owner: "o", repo: "r", number: 5 }, sha: HEAD };
  const pull = { number: 5, html_url: "https://github.com/o/r/pull/5", title: "Add a guard", body: "Tests pass.", user: { login: "dev", type: "User" }, head: { sha: HEAD } };
  const testRun = (status: string, conclusion: string | null) => ({
    id: 11,
    name: "test",
    head_sha: HEAD,
    status,
    conclusion,
    html_url: "https://github.com/o/r/actions/runs/3/job/11",
    app: { id: 15368, slug: "github-actions" },
  });
  const ownRun = (status: string) => ({ id: 77, name: "receipts", head_sha: HEAD, status, conclusion: null, html_url: null, app: { id: APP_ID, slug: "receipts-github" } });

  function routes({ head = HEAD, ci = testRun("completed", "success"), own = [] as unknown[] } = {}) {
    return {
      [`GET ${API}/repos/o/r/pulls/5`]: { ...pull, head: { sha: head } },
      [`GET ${API}/repos/o/r/pulls/5/files?per_page=100`]: [{ filename: "src/guard.ts", status: "added", additions: 9, deletions: 0 }],
      [`GET ${API}/repos/o/r/pulls/5/commits?per_page=100`]: [{ sha: head, commit: { message: "Add a guard" } }],
      [`GET ${API}/repos/o/r/commits/${head}/check-runs?per_page=100`]: { check_runs: [ci, ...own] },
      [`GET ${API}/repos/o/r/commits/${head}/status?per_page=100`]: { statuses: [] },
      [`GET ${API}/repos/o/r/actions/jobs/11/logs`]: "T ##[group]Run npm test\nT ##[endgroup]",
      [`GET ${API}/repos/o/r/commits/${HEAD}/check-runs?check_name=receipts&filter=latest`]: { check_runs: own },
      [`POST ${API}/repos/o/r/check-runs`]: { id: 501 },
      [`PATCH ${API}/repos/o/r/check-runs/77`]: { id: 77 },
    };
  }

  const run = async (recorded: Record<string, unknown>) => {
    const { fake, sent } = replay(recorded);
    const outcome = await checkTarget({ github: gitHub({ token: "t", fetch: fake }), target, appId: APP_ID });
    return { outcome, writes: sent.filter((s) => s.method !== "GET") };
  };

  it("posts a completed check run with the verdicts once CI has finished", async () => {
    const { outcome, writes } = await run(routes());
    expect(outcome).toEqual({ kind: "written", status: "completed", title: "0 unbacked, 0 unverifiable, 1 verified of 1 claim", checkRunId: 501 });
    expect(writes).toEqual([
      {
        method: "POST",
        url: `${API}/repos/o/r/check-runs`,
        body: expect.objectContaining({ name: "receipts", head_sha: HEAD, status: "completed", conclusion: "success" }),
      },
    ]);
  });

  it("marks the run in progress while another check is still running", async () => {
    const { outcome, writes } = await run(routes({ ci: testRun("in_progress", null) }));
    expect(outcome).toMatchObject({ kind: "written", status: "in_progress", title: "Waiting for 1 check" });
    expect(writes[0]?.body).toMatchObject({ status: "in_progress", output: { summary: expect.stringContaining("Still running: test") } });
  });

  it("updates the App's own run instead of adding a second one, and does not wait on it", async () => {
    const { outcome, writes } = await run(routes({ own: [ownRun("in_progress")] }));
    expect(outcome).toMatchObject({ kind: "written", status: "completed", checkRunId: 77 });
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([`PATCH ${API}/repos/o/r/check-runs/77`]);
  });

  it("never reopens a run another delivery already completed", async () => {
    const { outcome, writes } = await run(routes({ ci: testRun("in_progress", null), own: [ownRun("completed")] }));
    expect(outcome).toEqual({ kind: "skipped", reason: "already completed" });
    expect(writes).toEqual([]);
  });

  it("writes nothing for a head the pull request has moved past", async () => {
    const { outcome, writes } = await run(routes({ head: OLD }));
    expect(outcome).toEqual({ kind: "stale", headSha: OLD });
    expect(writes).toEqual([]);
  });

  it("stays inside a free Worker's 50 subrequests", () => {
    const perCheck = 1 + 3 + 2 * (APP_LIMITS.commits + 1) + APP_LIMITS.logs + 2;
    expect(perCheck).toBeLessThanOrEqual(40);
  });
});

describe("worker", () => {
  const env: Env = { APP_ID: String(APP_ID), PRIVATE_KEY: "unused", WEBHOOK_SECRET: SECRET };
  const deliver = (body: string, event: string, signature: string | null, to: Env = env) => {
    const waited: Promise<unknown>[] = [];
    const headers: Record<string, string> = { "x-github-event": event };
    if (signature !== null) headers["x-hub-signature-256"] = signature;
    const request = new Request("https://w.example/webhook", { method: "POST", body, headers });
    return worker.fetch(request, to, { waitUntil: (p) => waited.push(p) }).then((response) => ({ response, waited }));
  };

  it("refuses a delivery whose signature does not match", async () => {
    const { response, waited } = await deliver("{}", "ping", sign("{ }"));
    expect(response.status).toBe(401);
    expect(waited).toEqual([]);
  });

  it("refuses everything until both secrets are set", async () => {
    const { response } = await deliver("{}", "ping", sign("{}"), { ...env, WEBHOOK_SECRET: "" });
    expect(response.status).toBe(503);
  });

  it("acknowledges a signed delivery at once and checks in the background", async () => {
    const body = JSON.stringify({ action: "closed", installation, repository, pull_request: { number: 5, head: { sha: HEAD } } });
    const { response, waited } = await deliver(body, "pull_request", sign(body));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("pull_request: 0 pull request(s) to check\n");
    expect(waited).toHaveLength(1);
  });

  it("sends a browser on the root to the repository", async () => {
    const response = await worker.fetch(new Request("https://w.example/"), env, { waitUntil: () => undefined });
    expect([response.status, response.headers.get("location")]).toEqual([302, "https://github.com/abhaymettu/receipts-github"]);
  });
});
