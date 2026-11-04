/**
 * Records real pull requests as `RawReceipts` fixtures and writes the fixtures README from the same list.
 *
 *   node --conditions=source scripts/fetch-fixtures.ts            # every fixture
 *   node --conditions=source scripts/fetch-fixtures.ts o/r#n ...  # only these
 *
 * Needs GITHUB_TOKEN or a signed-in `gh`: job logs are not served without a token.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RawReceipts } from "@receipts-github/checker";
import { fetchReceipts, gitHub, parsePullRef, type PullRef } from "../packages/github/src/client.ts";
import { resolveToken } from "../packages/github/src/token.ts";

interface Fixture {
  readonly pr: string;
  readonly agent: string;
  readonly why: string;
}

const FIXTURES: readonly Fixture[] = [
  {
    pr: "hyperledger/fabric-x-orderer#1413",
    agent: "Claude Code",
    why: "Plainly passing CI on the head commit; claims `make unit-tests-batcher` passes and names `docs/batcher.md`.",
  },
  {
    pr: "dorogoy/zipline-mcp#299",
    agent: "Jules",
    why: "Plainly passing CI; claims tests, lint and build pass, so the claimed commands can be matched to the Actions logs.",
  },
  {
    pr: "kody-hq/kody#4840",
    agent: "Devin",
    why: "Passing CI; the body names five specific files and claims typecheck and related tests pass.",
  },
  {
    pr: "databricks/unity-gateway#1338",
    agent: "OpenAI Codex",
    why: "Several failing check runs on the head commit; claims `just lint` passes.",
  },
  {
    pr: "LayerNorm/overlay-web#390",
    agent: "Devin",
    why: "A failing check on the head commit beside claims that build, tests and typecheck passed on the current head.",
  },
  {
    pr: "can1357/oh-my-pi#15391",
    agent: "OpenAI Codex",
    why: "No check runs or statuses on any commit, while the body claims `bun check` and named test suites pass.",
  },
  {
    pr: "Open-MBEE/OpenSysML#1908",
    agent: "Devin",
    why: "Checks ran only on the older commit (cancelled when the head was pushed), none on the head; claims `make test` and `make lint` pass and names files.",
  },
  {
    pr: "kzarzycki/dotagents#88",
    agent: "Claude Code",
    why: "A commit-sha claim: `mise run check` at `a249731` passed all 10 checks, and `a249731` is not one of the PR's commits.",
  },
  {
    pr: "ricadoHuang/BMItest#12",
    agent: "Copilot coding agent",
    why: "The body names specific files (`bmi_logic.py`, `app.py`, a deploy workflow); passing checks on the head.",
  },
  {
    pr: "YOKEN21/grok-bot-cursor#20",
    agent: "Cursor background agent",
    why: "Claims `npm ci` and `npm run check` pass with a test count, and names the config file it changed.",
  },
];

const User = z.object({ login: z.string(), type: z.string() });
const GitRef = z.object({ label: z.string(), ref: z.string(), sha: z.string() });
const Pull = z.looseObject({ user: User, head: GitRef, base: GitRef }).transform(({ _links, ...rest }) => rest);
const File = z.looseObject({}).transform(({ patch, ...rest }) => rest);
const Commit = z.looseObject({ author: User.nullable(), committer: User.nullable() });
const Run = z.looseObject({ app: z.object({ slug: z.string() }).nullable() });

/** Drops what the checker never reads and that makes up most of the bytes: patches, repository and app objects. */
function trim(raw: RawReceipts): RawReceipts {
  const runs = (value: unknown) => z.array(Run).parse(value);
  return {
    ...raw,
    pull: Pull.parse(raw.pull),
    files: z.array(File).parse(raw.files),
    commits: z.array(Commit).parse(raw.commits),
    checkRuns: Object.fromEntries(Object.entries(raw.checkRuns).map(([sha, value]) => [sha, runs(value)])),
  };
}

const DIR = join(import.meta.dirname, "../packages/checker/test/fixtures");

const fileName = (ref: PullRef): string => `${ref.owner}__${ref.repo}__${ref.number}.json`;

function refOf(input: string): PullRef {
  const ref = parsePullRef(input);
  if (ref === null) throw new Error(`not a pull request reference: ${input}`);
  return ref;
}

function readme(): string {
  const rows = FIXTURES.map((f) => {
    const ref = refOf(f.pr);
    const url = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
    return `| [\`${fileName(ref)}\`](${fileName(ref)}) | ${url} | ${f.agent} | ${f.why} |`;
  });
  return [
    "# Fixtures",
    "",
    "Real public pull requests written by coding agents, recorded once in `RawReceipts` shape (see `packages/checker/src/receipts.ts`).",
    "Each file holds the pull request, its files and commits (without patches, repository objects or user profiles), the check runs and statuses of the head commit and up to 20 recent commits, and the `##[group]Run` lines of up to 30 Actions job logs.",
    "",
    "Regenerate with `node --conditions=source scripts/fetch-fixtures.ts` (this README is written from the same list). The pull requests keep changing on GitHub, so a fresh fetch can change verdicts.",
    "",
    "| Fixture | Pull request | Agent | What it exercises |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

const wanted = process.argv.slice(2);
const github = gitHub({ token: await resolveToken() });
await mkdir(DIR, { recursive: true });
for (const input of wanted.length > 0 ? wanted : FIXTURES.map((f) => f.pr)) {
  const ref = refOf(input);
  const raw = trim(await fetchReceipts({ github, pull: ref }));
  await writeFile(join(DIR, fileName(ref)), `${JSON.stringify(raw, null, 1)}\n`);
  process.stdout.write(`${fileName(ref)}: ${Object.keys(raw.checkRuns).length} commits, ${Object.keys(raw.logs).length} logs\n`);
}
await writeFile(join(DIR, "README.md"), readme());
