import type { Claim } from "./claims.ts";
import { COMMAND, GATES, NAME, type Gate } from "./commands.ts";
import type { ChangedFile, Check, Commit, PullRequest, Sha } from "./receipts.ts";

/**
 * One claim against the receipts its pull request carries.
 *
 *   verified      a receipt on the pull request backs it
 *   unbacked      the pull request could carry a receipt for it and none backs it: the check failed
 *                 (contradicted), passed only on an older commit (stale), or never ran (missing)
 *   unverifiable  no receipt a pull request carries could back it (a command run on the author's machine),
 *                 or the check that would decide it has not finished
 */

export type Status = "verified" | "unbacked" | "unverifiable";

export type Basis = "contradicted" | "stale" | "missing";

export type Evidence =
  | { readonly kind: "check"; readonly check: Check }
  | { readonly kind: "file"; readonly file: ChangedFile }
  | { readonly kind: "commit"; readonly commit: Commit };

export type Verdict =
  | { readonly status: "verified"; readonly reason: string; readonly evidence: readonly Evidence[] }
  | { readonly status: "unbacked"; readonly basis: Basis; readonly reason: string; readonly evidence: readonly Evidence[] }
  | { readonly status: "unverifiable"; readonly reason: string };

const WHAT: Readonly<Record<Gate, string>> = {
  tests: "tests",
  build: "a build",
  typecheck: "a type check",
  lint: "a linter",
  deploy: "a deploy",
};

const short = (sha: Sha): string => sha.slice(0, 7);
const named = (checks: readonly Check[]): string => [...new Set(checks.map((c) => `\`${c.name}\``))].join(", ");
const byCheck = (checks: readonly Check[]): Evidence[] => checks.map((check) => ({ kind: "check", check }));

const verified = (reason: string, evidence: readonly Evidence[] = []): Verdict => ({ status: "verified", reason, evidence });
const unbacked = (basis: Basis, reason: string, evidence: readonly Evidence[] = []): Verdict => ({
  status: "unbacked",
  basis,
  reason,
  evidence,
});
const unverifiable = (reason: string): Verdict => ({ status: "unverifiable", reason });

function runs(pr: PullRequest, gate: Gate): Check[] {
  return pr.checks.filter(
    (c) => c.state !== "skipped" && (NAME[gate].test(c.name) || c.commands.some((cmd) => COMMAND[gate].test(cmd))),
  );
}

const onHead = (pr: PullRequest, checks: readonly Check[]): Check[] => checks.filter((c) => c.sha === pr.headSha);

/** A check whose name names no gate and whose log was not read: it may have run anything. */
const isOpaque = (c: Check): boolean => c.commands.length === 0 && !GATES.some((g) => NAME[g].test(c.name));

function missing(pr: PullRequest, gate: Gate): Verdict {
  if (pr.checks.length === 0) return unbacked("missing", "no check ran on this pull request");
  const opaque = pr.checks.filter(isOpaque);
  if (opaque.length > 0) {
    return unverifiable(`no check says it runs ${WHAT[gate]}, and ${named(opaque)} does not say what it ran`);
  }
  return unbacked("missing", `no check on this pull request runs ${WHAT[gate]} (checks: ${named(pr.checks)})`);
}

function stale(pr: PullRequest, checks: readonly Check[], gate: Gate): Verdict {
  const order = new Map(pr.commits.map((c, i) => [c.sha, i]));
  const latest = checks.reduce((a, b) => ((order.get(b.sha) ?? -1) > (order.get(a.sha) ?? -1) ? b : a));
  const at = order.get(latest.sha);
  const behind = at === undefined ? "an earlier commit" : `${pr.commits.length - 1 - at} commit(s) before the head`;
  return unbacked("stale", `${WHAT[gate]} last ran on ${short(latest.sha)}, ${behind}`, byCheck([latest]));
}

/** Tests, builds, linters, type checks, deploys: every matching check on the head commit decides. */
function gate(pr: PullRequest, g: Gate, fallback?: Gate): Verdict {
  const matching = runs(pr, g);
  if (matching.length === 0 && fallback !== undefined) {
    const passed = onHead(pr, runs(pr, fallback));
    if (passed.length > 0 && passed.every((c) => c.state === "success")) {
      return verified(`${named(passed)} passed on the head commit and needs ${WHAT[g]} to pass`, byCheck(passed));
    }
  }
  if (matching.length === 0) return missing(pr, g);
  const head = onHead(pr, matching);
  if (head.length === 0) return stale(pr, matching, g);
  const failed = head.filter((c) => c.state === "failure");
  if (failed.length > 0) return unbacked("contradicted", `${named(failed)} failed on the head commit`, byCheck(failed));
  const pending = head.filter((c) => c.state === "pending");
  if (pending.length > 0) return unverifiable(`${named(pending)} had not finished`);
  return verified(`${named(head)} passed on the head commit ${short(pr.headSha)}`, byCheck(head));
}

const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.[a-z]+$|(?:^|\/)test_[^/]+\.py$/i;

/** "Fixed", "it works": something that exercises the code has to have passed on the head commit. */
function works(pr: PullRequest): Verdict {
  const v = gate(pr, "tests");
  if (v.status !== "verified") return v;
  const tests = pr.files.filter((f) => f.status !== "removed" && TEST_FILE.test(f.path));
  return verified(
    tests.length > 0 ? `${v.reason}, and the diff changes ${tests.length} test file(s)` : v.reason,
    [...v.evidence, ...tests.map((file): Evidence => ({ kind: "file", file }))],
  );
}

const TICKED = /`([^`\n]{2,})`/g;

/** What a claim names: its files' basenames and its backticked tokens, as receipts' `_objects`. */
function objects(claim: Claim): string[] {
  const names = claim.files.map((f) => f.replace(/\/+$/, "").split("/").pop() ?? f);
  const ticked = [...claim.text.matchAll(TICKED)].map((m) => m[1] ?? "");
  return [...names, ...ticked].filter((n) => n.length >= 3).map((n) => n.toLowerCase());
}

/** "I ran the migration", "verified the endpoint": only a check that ran it on the head commit is a receipt. */
function observed(claim: Claim, pr: PullRequest): Verdict {
  const passed = onHead(pr, pr.checks).filter((c) => c.state === "success");
  const names = objects(claim);
  const hit = passed.find((c) => names.some((n) => `${c.name}\n${c.commands.join("\n")}`.toLowerCase().includes(n)));
  if (hit !== undefined) return verified(`\`${hit.name}\` ran it on the head commit`, byCheck([hit]));
  if (claim.kind === "verified") {
    const tests = onHead(pr, runs(pr, "tests"));
    if (tests.length > 0 && tests.every((c) => c.state === "success")) {
      return verified(`${named(tests)} passed on the head commit`, byCheck(tests));
    }
    return unverifiable("a check done by hand leaves no receipt in a pull request");
  }
  return unverifiable("a command run outside CI leaves no receipt in a pull request");
}

const clean = (p: string): string => p.replace(/^(?:\.\/|~\/)/, "");

function touches(file: ChangedFile, name: string): boolean {
  const n = clean(name);
  return [file.path, file.previousPath].some((p) => {
    if (p === null) return false;
    if (n.endsWith("/")) return p.startsWith(n) || p.includes(`/${n}`);
    return p === n || p.endsWith(`/${n}`) || n.endsWith(`/${p}`) || (!n.includes("/") && p.split("/").pop() === n);
  });
}

function files(claim: Claim, pr: PullRequest): Verdict {
  if (claim.files.length === 0) {
    return pr.files.length > 0
      ? verified(`the diff changes ${pr.files.length} file(s)`)
      : unbacked("missing", "the diff changes no files");
  }
  const hits: ChangedFile[] = [];
  for (const name of claim.files) {
    const touched = pr.files.filter((f) => touches(f, name));
    if (touched.length === 0) return unbacked("missing", `the diff does not touch \`${name}\``);
    hits.push(...touched);
  }
  return verified(
    `the diff touches ${claim.files.map((f) => `\`${f}\``).join(", ")}`,
    [...new Set(hits)].map((file): Evidence => ({ kind: "file", file })),
  );
}

const PR_NUMBER = /#(\d+)\b/;

function git(claim: Claim, pr: PullRequest): Verdict {
  const head = pr.commits.at(-1);
  switch (claim.kind) {
    case "commit": {
      if (claim.sha !== null) {
        const sha = claim.sha.toLowerCase();
        const commit = pr.commits.find((c) => c.sha.startsWith(sha));
        return commit === undefined
          ? unbacked("missing", `commit ${sha} is not in this pull request`)
          : verified(`commit ${sha} is in this pull request`, [{ kind: "commit", commit }]);
      }
      return head === undefined
        ? unbacked("missing", "this pull request has no commits")
        : verified(`this pull request has ${pr.commits.length} commit(s)`, [{ kind: "commit", commit: head }]);
    }
    case "push":
      return verified(`the head commit ${short(pr.headSha)} is pushed`);
    default: {
      const n = PR_NUMBER.exec(claim.text)?.[1];
      return n !== undefined && Number(n) !== pr.number
        ? unverifiable(`it names another pull request (#${n})`)
        : verified("this pull request is open");
    }
  }
}

export function judge(claim: Claim, pr: PullRequest): Verdict {
  switch (claim.kind) {
    case "test_pass":
      return gate(pr, "tests");
    case "build_pass":
      return gate(pr, "build", "tests");
    case "typecheck_pass":
      return gate(pr, "typecheck", "build");
    case "lint_pass":
      return gate(pr, "lint");
    case "works":
      return works(pr);
    case "verified":
    case "ran":
      return observed(claim, pr);
    case "file_change":
      return files(claim, pr);
    case "commit":
    case "push":
    case "pr":
      return git(claim, pr);
    case "deployed": {
      const v = gate(pr, "deploy");
      return v.status === "unbacked" && v.basis === "missing" ? unverifiable("no deploy check ran on this pull request") : v;
    }
    case "installed":
      return unverifiable("an install on the author's machine leaves no receipt in a pull request");
    default: {
      const exhaustive: never = claim.kind;
      return exhaustive;
    }
  }
}
