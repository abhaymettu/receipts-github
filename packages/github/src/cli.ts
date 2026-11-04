import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { checkPullRequest, parseReceipts, summarize } from "@receipts-github/checker";
import { fetchReceipts, gitHub, parsePullRef, type PullRef } from "./client.ts";
import { resolveToken } from "./token.ts";

export type FailOn = Parameters<typeof summarize>[1];

export const USAGE = [
  "usage: receipts-github <https://github.com/owner/repo/pull/123 | owner/repo#123> [--json] [--fail-on unbacked|never]",
  "       receipts-github init [--force]   write .github/workflows/receipts.yml into this git repository",
].join("\n");

export const WORKFLOW_PATH = ".github/workflows/receipts.yml";

export const WORKFLOW = `name: receipts

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions:
  checks: write
  contents: read
  pull-requests: read
  actions: read
  statuses: read

jobs:
  receipts:
    runs-on: ubuntu-latest
    steps:
      - uses: abhaymettu/receipts-github@v0.1.0
`;

export type Command =
  | { readonly kind: "check"; readonly pull: PullRef; readonly json: boolean; readonly failOn: FailOn }
  | { readonly kind: "init"; readonly force: boolean }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export function parseFailOn(value: string): FailOn | null {
  return value === "unbacked" || value === "never" ? value : null;
}

export function parseCommand(argv: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        "fail-on": { type: "string", default: "unbacked" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  if (positionals[0] === "init") {
    return positionals.length === 1 ? { kind: "init", force: values.force } : { kind: "error", message: "init takes no arguments" };
  }
  if (positionals.length !== 1) return { kind: "error", message: "expected exactly one pull request" };
  const pull = parsePullRef(positionals[0] ?? "");
  if (pull === null) return { kind: "error", message: `not a pull request: ${positionals[0]}` };
  const failOn = parseFailOn(values["fail-on"]);
  if (failOn === null) return { kind: "error", message: `--fail-on must be unbacked or never, got ${values["fail-on"]}` };
  return { kind: "check", pull, json: values.json, failOn };
}

/** Writes the workflow under `root` unless one is already there and `force` is false. */
export async function writeWorkflow({ root, force }: { root: string; force: boolean }): Promise<{ written: boolean; path: string }> {
  const path = join(root, WORKFLOW_PATH);
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  try {
    await writeFile(path, WORKFLOW, { flag: force ? "w" : "wx" });
    return { written: true, path };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return { written: false, path };
    throw error;
  }
}

async function init(force: boolean): Promise<number> {
  let root: string;
  try {
    root = (await promisify(execFile)("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  } catch {
    process.stderr.write("receipts-github: init runs inside a git repository\n");
    return 2;
  }
  const { written, path } = await writeWorkflow({ root, force });
  if (!written) {
    process.stderr.write(`receipts-github: ${path} already exists; pass --force to replace it\n`);
    return 2;
  }
  process.stdout.write(`wrote ${path}\ncommit and push it; the check appears on your next pull request\n`);
  return 0;
}

/** Exit code: 0 when the claims hold or fail-on is never, 1 when a claim is unbacked, 2 on any error. */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await dispatch(parseCommand(argv));
  } catch (error) {
    process.stderr.write(`receipts-github: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

async function dispatch(command: Command): Promise<number> {
  switch (command.kind) {
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "error":
      process.stderr.write(`receipts-github: ${command.message}\n${USAGE}\n`);
      return 2;
    case "init":
      return init(command.force);
    case "check":
      return check(command);
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

async function check({ pull, json, failOn }: Extract<Command, { kind: "check" }>): Promise<number> {
  const token = await resolveToken();
  if (token === null) {
    process.stderr.write(
      "receipts-github: no GITHUB_TOKEN and no signed-in gh, so reading unauthenticated (60 requests an hour, no job logs)\n",
    );
  }
  const raw = await fetchReceipts({ github: gitHub({ token }), pull });
  const report = checkPullRequest(parseReceipts(raw));
  const summary = summarize(report, failOn);
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${summary.text}\n`);
  return summary.conclusion === "failure" ? 1 : 0;
}
