import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCommand, WORKFLOW, WORKFLOW_PATH, writeWorkflow } from "../src/cli.ts";

describe("parseCommand", () => {
  it("checks a pull request URL with the defaults", () => {
    expect(parseCommand(["https://github.com/o/r/pull/12"])).toEqual({
      kind: "check",
      pull: { owner: "o", repo: "r", number: 12 },
      json: false,
      failOn: "unbacked",
    });
  });

  it("reads --json and --fail-on in either order around the pull request", () => {
    expect(parseCommand(["--fail-on", "never", "o/r#3", "--json"])).toEqual({
      kind: "check",
      pull: { owner: "o", repo: "r", number: 3 },
      json: true,
      failOn: "never",
    });
    expect(parseCommand(["o/r#3", "--fail-on=never"])).toEqual({
      kind: "check",
      pull: { owner: "o", repo: "r", number: 3 },
      json: false,
      failOn: "never",
    });
  });

  it("reads init and init --force", () => {
    expect(parseCommand(["init"])).toEqual({ kind: "init", force: false });
    expect(parseCommand(["init", "--force"])).toEqual({ kind: "init", force: true });
  });

  it("reads --help", () => {
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseCommand(["-h", "o/r#1"])).toEqual({ kind: "help" });
  });

  it("explains each bad invocation", () => {
    expect(parseCommand([])).toEqual({ kind: "error", message: "expected exactly one pull request" });
    expect(parseCommand(["o/r#1", "o/r#2"])).toEqual({ kind: "error", message: "expected exactly one pull request" });
    expect(parseCommand(["o/r"])).toEqual({ kind: "error", message: "not a pull request: o/r" });
    expect(parseCommand(["o/r#1", "--fail-on", "always"])).toEqual({
      kind: "error",
      message: "--fail-on must be unbacked or never, got always",
    });
    expect(parseCommand(["init", "o/r#1"])).toEqual({ kind: "error", message: "init takes no arguments" });
    expect(parseCommand(["o/r#1", "--verbose"])).toMatchObject({ kind: "error" });
  });
});

describe("writeWorkflow", () => {
  const expected = [
    "name: receipts",
    "",
    "on:",
    "  pull_request:",
    "    types: [opened, edited, synchronize, reopened]",
    "",
    "permissions:",
    "  checks: write",
    "  contents: read",
    "  pull-requests: read",
    "  actions: read",
    "  statuses: read",
    "",
    "jobs:",
    "  read-claims:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: abhaymettu/receipts-github@v0.1.0",
    "",
  ].join("\n");

  it("writes the workflow into a repository that has none", async () => {
    const root = await mkdtemp(join(tmpdir(), "receipts-init-"));
    expect(await writeWorkflow({ root, force: false })).toEqual({ written: true, path: join(root, ".github/workflows/receipts.yml") });
    expect(await readFile(join(root, WORKFLOW_PATH), "utf8")).toBe(expected);
  });

  it("leaves an existing workflow alone unless forced", async () => {
    const root = await mkdtemp(join(tmpdir(), "receipts-init-"));
    await writeWorkflow({ root, force: false });
    await writeFile(join(root, WORKFLOW_PATH), "mine\n");
    expect(await writeWorkflow({ root, force: false })).toEqual({ written: false, path: join(root, WORKFLOW_PATH) });
    expect(await readFile(join(root, WORKFLOW_PATH), "utf8")).toBe("mine\n");
    expect(await writeWorkflow({ root, force: true })).toEqual({ written: true, path: join(root, WORKFLOW_PATH) });
    expect(await readFile(join(root, WORKFLOW_PATH), "utf8")).toBe(expected);
  });

  it("asks for the same permissions as this repository's own receipts workflow", async () => {
    const dogfood = await readFile(join(import.meta.dirname, "../../../.github/workflows/receipts.yml"), "utf8");
    const permissions = (yaml: string) => /^permissions:\n(?: {2}.+\n)+/m.exec(yaml)?.[0];
    expect(permissions(WORKFLOW)).toBe("permissions:\n  checks: write\n  contents: read\n  pull-requests: read\n  actions: read\n  statuses: read\n");
    expect(permissions(dogfood)).toBe(permissions(WORKFLOW));
  });
});
