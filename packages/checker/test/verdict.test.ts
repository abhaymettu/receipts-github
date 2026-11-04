import { describe, expect, it } from "vitest";
import { judge, type Check, type Claim, type Kind, type PullRequest, type Sha } from "@receipts-github/checker";

const A = "a".repeat(40) as Sha;
const B = "b".repeat(40) as Sha;
const HEAD = "c".repeat(40) as Sha;

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    title: "t",
    body: "",
    author: { login: "agent", isBot: true },
    headSha: HEAD,
    commits: [
      { sha: A, message: "one" },
      { sha: B, message: "two" },
      { sha: HEAD, message: "three" },
    ],
    files: [],
    checks: [],
    ...over,
  };
}

function check(name: string, state: Check["state"], sha: Sha = HEAD, commands: string[] = []): Check {
  return { source: "check_run", name, sha, state, url: `https://ci/${name}`, commands };
}

const claim = (kind: Kind, text: string, files: string[] = [], sha: string | null = null): Claim => ({ kind, text, files, sha });

const status = (v: ReturnType<typeof judge>) =>
  v.status === "unbacked" ? `unbacked/${v.basis}: ${v.reason}` : `${v.status}: ${v.reason}`;

describe("test claims", () => {
  const tests = claim("test_pass", "All tests pass.");

  it("are verified by a passing test check on the head commit", () => {
    expect(status(judge(tests, pr({ checks: [check("test (ubuntu)", "success")] })))).toBe(
      "verified: `test (ubuntu)` passed on the head commit ccccccc",
    );
  });

  it("count a check whose Actions log ran a test command, whatever its name", () => {
    const ci = check("ci", "success", HEAD, ["npm ci", "pnpm -r test"]);
    expect(judge(tests, pr({ checks: [ci] })).status).toBe("verified");
  });

  it("are contradicted when a test check failed on the head commit", () => {
    const checks = [check("test (ubuntu)", "success"), check("test (windows)", "failure")];
    expect(status(judge(tests, pr({ checks })))).toBe("unbacked/contradicted: `test (windows)` failed on the head commit");
  });

  it("are stale when tests passed only on an earlier commit", () => {
    expect(status(judge(tests, pr({ checks: [check("unit tests", "success", A)] })))).toBe(
      "unbacked/stale: tests last ran on aaaaaaa, 2 commit(s) before the head",
    );
  });

  it("are unbacked when the pull request has no checks at all", () => {
    expect(status(judge(tests, pr()))).toBe("unbacked/missing: no check ran on this pull request");
  });

  it("are unbacked when checks ran but none runs tests", () => {
    expect(status(judge(tests, pr({ checks: [check("lint", "success")] })))).toBe(
      "unbacked/missing: no check on this pull request runs tests (checks: `lint`)",
    );
  });

  it("are unverifiable when the only check does not say what it ran", () => {
    expect(status(judge(tests, pr({ checks: [check("CircleCI", "success")] })))).toBe(
      "unverifiable: no check says it runs tests, and `CircleCI` does not say what it ran",
    );
  });

  it("count a check that ran the command the claim names, whatever kind of command it is", () => {
    const ci = check("check", "success", HEAD, ["actions/checkout@v4", "mise run check"]);
    const v = judge(claim("test_pass", "`mise run check`: all 10 checks passed."), pr({ checks: [ci] }));
    expect(status(v)).toBe("verified: `check` passed on the head commit ccccccc");
  });

  it("do not count a named command of another kind", () => {
    const ci = check("ci", "success", HEAD, ["make lint"]);
    expect(judge(claim("test_pass", "`make test` and `make lint` pass."), pr({ checks: [ci] })).status).toBe("unbacked");
  });

  it("are unverifiable, not stale, when a head check does not say what it ran", () => {
    const checks = [check("unit tests", "success", A), check("CircleCI", "success")];
    expect(status(judge(tests, pr({ checks })))).toBe(
      "unverifiable: no check on the head commit says it runs tests, and `CircleCI` does not say what it ran",
    );
  });

  it("name at most three checks in a reason", () => {
    const checks = ["test a", "test b", "test c", "test d", "test e"].map((n) => check(n, "success"));
    expect(status(judge(tests, pr({ checks })))).toBe(
      "verified: `test a`, `test b`, `test c` and 2 more passed on the head commit ccccccc",
    );
  });

  it("are unverifiable while the test check is still running", () => {
    expect(status(judge(tests, pr({ checks: [check("test", "pending")] })))).toBe("unverifiable: `test` had not finished");
  });

  it("ignore skipped checks", () => {
    expect(judge(tests, pr({ checks: [check("test", "skipped"), check("lint", "success")] })).status).toBe("unbacked");
  });
});

describe("build claims", () => {
  it("fall back to a passing test check when no check builds", () => {
    const v = judge(claim("build_pass", "The build succeeds."), pr({ checks: [check("test", "success")] }));
    expect(status(v)).toBe("verified: `test` passed on the head commit and needs a build to pass");
  });
});

describe("works claims", () => {
  it("need a passing test check and list changed test files", () => {
    const files = [
      { path: "src/parse.ts", previousPath: null, status: "modified" as const, additions: 3, deletions: 1, added: [] },
      { path: "src/parse.test.ts", previousPath: null, status: "modified" as const, additions: 9, deletions: 0, added: [] },
    ];
    const v = judge(claim("works", "Fixed the off-by-one."), pr({ files, checks: [check("test", "success")] }));
    expect(status(v)).toBe("verified: `test` passed on the head commit ccccccc, and the diff changes 1 test file(s)");
    expect(v.status === "verified" && v.evidence.map((e) => e.kind)).toEqual(["check", "file"]);
  });

  it("are unbacked when only a build ran", () => {
    const v = judge(claim("works", "It works now."), pr({ checks: [check("build", "success")] }));
    expect(status(v)).toBe("unbacked/missing: no check on this pull request runs tests (checks: `build`)");
  });
});

describe("file claims", () => {
  const files = [
    { path: "packages/core/src/config.ts", previousPath: null, status: "modified" as const, additions: 1, deletions: 1, added: [] },
    { path: "docs/new.md", previousPath: "docs/old.md", status: "renamed" as const, additions: 0, deletions: 0, added: [] },
  ];

  it("are verified when the diff touches every named file, by suffix or basename", () => {
    const v = judge(claim("file_change", "Updated `src/config.ts` and `old.md`.", ["src/config.ts", "old.md"]), pr({ files }));
    expect(status(v)).toBe("verified: the diff touches `src/config.ts`, `old.md`");
  });

  it("are unbacked when a named file is not in the diff", () => {
    const v = judge(claim("file_change", "Edited `README.md`.", ["README.md"]), pr({ files }));
    expect(status(v)).toBe("unbacked/missing: the diff does not touch `README.md`");
  });

  it("count a named file the diff adds a line naming, as when a file is added to a list", () => {
    const workflow = [
      { path: ".github/workflows/ship.yml", previousPath: null, status: "modified" as const, additions: 1, deletions: 1, added: ["  Copy-Item app.py, bmi_logic.py dist\\"] },
    ];
    const v = judge(claim("file_change", "Added `bmi_logic.py` to the copy list.", ["bmi_logic.py", "bmi_logic.py"]), pr({ files: workflow }));
    expect(status(v)).toBe("verified: the diff adds a line naming `bmi_logic.py` (named in `.github/workflows/ship.yml`)");
  });

  it("match a named directory by prefix", () => {
    expect(judge(claim("file_change", "Refactored `packages/core/`.", ["packages/core/"]), pr({ files })).status).toBe(
      "verified",
    );
  });
});

describe("git claims", () => {
  it("verify a named commit by its sha prefix", () => {
    expect(status(judge(claim("commit", "Committed as bbbbbbb.", [], "bbbbbbb"), pr()))).toBe(
      "verified: commit bbbbbbb is in this pull request",
    );
  });

  it("flag a named commit the pull request does not contain", () => {
    expect(status(judge(claim("commit", "Committed as 1234abc.", [], "1234abc"), pr()))).toBe(
      "unbacked/missing: commit 1234abc is not in this pull request",
    );
  });

  it("leave a claim about another pull request unverifiable", () => {
    expect(status(judge(claim("pr", "Opened PR #12 for the docs."), pr()))).toBe(
      "unverifiable: it names another pull request (#12)",
    );
  });
});

describe("claims about the author's machine", () => {
  it("are unverifiable unless a check on the head commit ran the thing named", () => {
    const ran = claim("ran", "I ran `migrate.py`.", ["migrate.py"]);
    expect(status(judge(ran, pr()))).toBe("unverifiable: a command run outside CI leaves no receipt in a pull request");
    const ci = check("db", "success", HEAD, ["python migrate.py --check"]);
    expect(status(judge(ran, pr({ checks: [ci] })))).toBe("verified: `db` ran it on the head commit");
  });

  it("treat installs as unverifiable and deploys as unverifiable without a deploy check", () => {
    expect(judge(claim("installed", "Installed the CLI."), pr()).status).toBe("unverifiable");
    expect(status(judge(claim("deployed", "Deployed to production."), pr({ checks: [check("test", "success")] })))).toBe(
      "unverifiable: no deploy check ran on this pull request",
    );
    expect(judge(claim("deployed", "It is live."), pr({ checks: [check("Vercel", "failure")] })).status).toBe("unbacked");
  });
});
