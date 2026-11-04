import { describe, expect, it } from "vitest";
import { commandsFromLog, parseReceipts } from "@receipts-github/checker";

const LOG = [
  "2026-11-03T10:00:00.0000000Z ##[group]Run actions/checkout@v4",
  "2026-11-03T10:00:00.0000001Z with:",
  "2026-11-03T10:00:00.0000001Z   fetch-depth: 0",
  "2026-11-03T10:00:00.0000002Z ##[endgroup]",
  "2026-11-03T10:00:01.0000000Z ##[group]Run npm ci",
  "2026-11-03T10:00:01.0000001Z \u001b[36;1mnpm ci\u001b[0m",
  "2026-11-03T10:00:01.0000002Z \u001b[36;1mnpm test -- --reporter=dot\u001b[0m",
  "2026-11-03T10:00:01.0000003Z shell: /usr/bin/bash -e {0}",
  "2026-11-03T10:00:01.0000004Z env:",
  "2026-11-03T10:00:01.0000005Z   CI: true",
  "2026-11-03T10:00:01.0000006Z ##[endgroup]",
  "2026-11-03T10:00:09.0000000Z 12 passed",
].join("\n");

describe("commandsFromLog", () => {
  it("reads every line of a multi-line run step and nothing after its shell line", () => {
    expect(commandsFromLog(LOG)).toEqual(["actions/checkout@v4", "npm ci", "npm test -- --reporter=dot"]);
  });
});

describe("parseReceipts", () => {
  const raw = {
    pull: {
      number: 3,
      html_url: "https://github.com/o/r/pull/3",
      title: "Fix parser",
      body: null,
      user: { login: "Copilot", type: "Bot" },
      head: { sha: "ABC0000000000000000000000000000000000000" },
    },
    files: [{ filename: "b.ts", previous_filename: "a.ts", status: "renamed", additions: 1, deletions: 0 }],
    commits: [{ sha: "abc0000000000000000000000000000000000000", commit: { message: "Fix parser" } }],
    checkRuns: {
      abc0000000000000000000000000000000000000: [
        { id: 9, name: "test", head_sha: "abc0000000000000000000000000000000000000", status: "completed", conclusion: "neutral", html_url: null },
        { id: 10, name: "e2e", head_sha: "abc0000000000000000000000000000000000000", status: "in_progress", conclusion: null, html_url: null },
        { id: 11, name: "lint", head_sha: "abc0000000000000000000000000000000000000", status: "completed", conclusion: "cancelled", html_url: null },
      ],
    },
    statuses: { abc0000000000000000000000000000000000000: [{ context: "ci/circleci", state: "error", target_url: null }] },
    logs: { "9": LOG },
  };

  it("normalizes check runs and statuses into one list of checks", () => {
    const pr = parseReceipts(raw);
    expect(pr.body).toBe("");
    expect(pr.author).toEqual({ login: "Copilot", isBot: true });
    expect(pr.headSha).toBe("abc0000000000000000000000000000000000000");
    expect(pr.files).toEqual([{ path: "b.ts", previousPath: "a.ts", status: "renamed", additions: 1, deletions: 0 }]);
    expect(pr.checks.map((c) => [c.source, c.name, c.state, c.commands.length])).toEqual([
      ["check_run", "test", "success", 3],
      ["check_run", "e2e", "pending", 0],
      ["check_run", "lint", "skipped", 0],
      ["status", "ci/circleci", "failure", 0],
    ]);
  });

  it("rejects a response missing a field the checker reads", () => {
    expect(() => parseReceipts({ ...raw, pull: { number: 3 } })).toThrow();
  });
});
