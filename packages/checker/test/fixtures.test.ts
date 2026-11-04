import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPullRequest, parseReceipts } from "@receipts-github/checker";

const DIR = join(import.meta.dirname, "fixtures");

/** Verdicts on ten real agent pull requests, each read against the pull request on GitHub (fixtures/README.md). */
const EXPECTED: Record<string, string[]> = {
  "LayerNorm__overlay-web__390": ["verified commit", "verified typecheck_pass", "verified test_pass", "verified test_pass", "verified build_pass", "verified verified", "verified verified", "unbacked deployed/contradicted", "verified test_pass", "verified typecheck_pass"],
  "Open-MBEE__OpenSysML__1908": ["unverifiable verified", "verified commit", "verified file_change", "unbacked test_pass/stale", "unverifiable lint_pass", "verified commit"],
  "YOKEN21__grok-bot-cursor__20": [],
  "can1357__oh-my-pi__15391": ["verified file_change", "unbacked test_pass/missing", "unverifiable verified"],
  "databricks__unity-gateway__1338": ["verified lint_pass", "unverifiable ran"],
  "dorogoy__zipline-mcp__299": ["verified file_change", "verified test_pass", "verified build_pass", "unverifiable ran"],
  "hyperledger__fabric-x-orderer__1413": ["verified test_pass"],
  "kody-hq__kody__4840": ["verified file_change", "verified test_pass", "verified test_pass", "unverifiable typecheck_pass"],
  "kzarzycki__dotagents__88": ["verified test_pass"],
  "ricadoHuang__BMItest__12": ["verified file_change", "verified file_change"],
};

describe("real pull requests", () => {
  const names = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

  it("has a recorded verdict list for every fixture", () => {
    expect(names.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(names)("%s", (name) => {
    const pr = parseReceipts(JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")));
    const got = checkPullRequest(pr).findings.map(
      (f) => `${f.verdict.status} ${f.claim.kind}${f.verdict.status === "unbacked" ? `/${f.verdict.basis}` : ""}`,
    );
    expect(got).toEqual(EXPECTED[name]);
  });
});
