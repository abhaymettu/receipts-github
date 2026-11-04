import { describe, expect, it } from "vitest";
import { capSummary, decideWait, isOwnCheck, parseInputs, SUMMARY_LIMIT, type CheckRunStatus } from "../src/action.ts";

const self = { runId: "777", checkName: "receipts", jobName: "read-claims" };

const run = (name: string, status: string, url: string | null = null): CheckRunStatus => ({
  name,
  status,
  html_url: url,
  details_url: url,
});

describe("isOwnCheck", () => {
  it("matches another run of its own job, so an edit and a push do not wait on each other", () => {
    expect(isOwnCheck({ name: "read-claims", urls: ["https://github.com/o/r/actions/runs/778/job/1"] }, self)).toBe(true);
  });

  it("matches a job of this workflow run by its URL", () => {
    expect(isOwnCheck({ name: "receipts", urls: ["https://github.com/o/r/actions/runs/777/job/9"] }, { ...self, checkName: "x" })).toBe(true);
  });

  it("matches the check run this action posts, by name", () => {
    expect(isOwnCheck({ name: "receipts", urls: [null] }, self)).toBe(true);
  });

  it("does not match another run whose id starts with this one", () => {
    expect(isOwnCheck({ name: "test", urls: ["https://github.com/o/r/actions/runs/7771/job/9"] }, self)).toBe(false);
  });
});

describe("decideWait", () => {
  const limitMs = 10 * 60_000;

  it("is ready when every other check has completed", () => {
    const runs = [run("test", "completed"), run("lint", "completed")];
    expect(decideWait({ runs, self, elapsedMs: 0, limitMs })).toEqual({ kind: "ready" });
  });

  it("is ready with no checks at all", () => {
    expect(decideWait({ runs: [], self, elapsedMs: 0, limitMs })).toEqual({ kind: "ready" });
  });

  it("ignores this workflow run's own jobs and its own check name while they run", () => {
    const runs = [
      run("receipts", "in_progress", "https://github.com/o/r/actions/runs/777/job/1"),
      run("receipts", "queued"),
      run("test", "completed"),
    ];
    expect(decideWait({ runs, self, elapsedMs: 0, limitMs })).toEqual({ kind: "ready" });
  });

  it("waits while another check is queued or in progress", () => {
    const runs = [run("test", "in_progress"), run("lint", "queued"), run("build", "completed")];
    expect(decideWait({ runs, self, elapsedMs: 60_000, limitMs })).toEqual({ kind: "wait", pending: ["test", "lint"] });
  });

  it("gives up when one more poll would pass the limit", () => {
    const runs = [run("test", "in_progress")];
    expect(decideWait({ runs, self, elapsedMs: limitMs - 14_000, limitMs })).toEqual({ kind: "give_up", pending: ["test"] });
  });

  it("gives up at once when wait-minutes is 0", () => {
    expect(decideWait({ runs: [run("test", "queued")], self, elapsedMs: 0, limitMs: 0 })).toEqual({ kind: "give_up", pending: ["test"] });
  });
});

describe("parseInputs", () => {
  it("reads the INPUT_ variables GitHub sets, hyphens kept", () => {
    const env = { "INPUT_TOKEN": "ghs_x", "INPUT_FAIL-ON": "never", "INPUT_WAIT-MINUTES": "2.5", "INPUT_CHECK-NAME": "claims" };
    expect(parseInputs(env)).toEqual({ token: "ghs_x", failOn: "never", waitMs: 150_000, checkName: "claims" });
  });

  it("falls back to the action.yml defaults for empty inputs", () => {
    expect(parseInputs({ INPUT_TOKEN: "ghs_x", "INPUT_FAIL-ON": "", "INPUT_WAIT-MINUTES": "" })).toEqual({
      token: "ghs_x",
      failOn: "unbacked",
      waitMs: 600_000,
      checkName: "receipts",
    });
  });

  it("rejects a fail-on value it does not know", () => {
    expect(() => parseInputs({ INPUT_TOKEN: "t", "INPUT_FAIL-ON": "always" })).toThrow("input fail-on must be unbacked or never, got always");
  });

  it("rejects a missing token and a negative wait", () => {
    expect(() => parseInputs({})).toThrow("input token is empty");
    expect(() => parseInputs({ INPUT_TOKEN: "t", "INPUT_WAIT-MINUTES": "-1" })).toThrow("input wait-minutes must be a number of minutes, got -1");
  });
});

describe("capSummary", () => {
  it("leaves a summary under the limit alone", () => {
    expect(capSummary("| ✓ verified | tests pass |")).toBe("| ✓ verified | tests pass |");
  });

  it("cuts a long summary to the limit and says so", () => {
    const capped = capSummary("✓".repeat(30_000));
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(capped.startsWith("✓".repeat(21_000))).toBe(true);
    expect(capped.includes("\uFFFD")).toBe(false);
    expect(capped.endsWith("(Cut to fit the check run; the job's step summary has the full table.)")).toBe(true);
  });
});
