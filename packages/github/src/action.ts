import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { checkPullRequest, parseReceipts, summarize } from "@receipts-github/checker";
import { fetchReceipts, gitHub, GitHubError, type GitHub, type PullRef } from "./client.ts";

export const POLL_MS = 15_000;
/** GitHub rejects a check run whose output.summary exceeds 65,535 characters. */
export const SUMMARY_LIMIT = 65_000;

/** What identifies the checks this action must not wait for or judge: its own workflow run and its own check run. */
export interface Self {
  readonly runId: string;
  readonly checkName: string;
}

export function isOwnCheck(check: { name: string; urls: readonly (string | null)[] }, self: Self): boolean {
  const ownRun = `/actions/runs/${self.runId}/`;
  return check.name === self.checkName || check.urls.some((url) => url?.includes(ownRun) === true);
}

const CheckRunStatus = z.object({
  name: z.string(),
  status: z.string(),
  html_url: z.string().nullable(),
  details_url: z.string().nullable(),
});
export type CheckRunStatus = z.infer<typeof CheckRunStatus>;

export type WaitDecision =
  | { readonly kind: "ready" }
  | { readonly kind: "wait"; readonly pending: readonly string[] }
  | { readonly kind: "give_up"; readonly pending: readonly string[] };

/** Whether every other check on the head commit has finished, and if not, whether there is time left to wait. */
export function decideWait({
  runs,
  self,
  elapsedMs,
  limitMs,
}: {
  runs: readonly CheckRunStatus[];
  self: Self;
  elapsedMs: number;
  limitMs: number;
}): WaitDecision {
  const pending = runs
    .filter((run) => run.status !== "completed")
    .filter((run) => !isOwnCheck({ name: run.name, urls: [run.html_url, run.details_url] }, self))
    .map((run) => run.name);
  if (pending.length === 0) return { kind: "ready" };
  return elapsedMs + POLL_MS <= limitMs ? { kind: "wait", pending } : { kind: "give_up", pending };
}

const FailOn = z.enum(["unbacked", "never"]);

export interface Inputs {
  readonly token: string;
  readonly failOn: z.infer<typeof FailOn>;
  readonly waitMs: number;
  readonly checkName: string;
}

/** Inputs arrive as `INPUT_<NAME>` with the name upper-cased and hyphens kept. */
export function parseInputs(env: NodeJS.ProcessEnv): Inputs {
  const input = (name: string): string => env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";
  const token = input("token");
  if (token === "") throw new Error("input token is empty");
  const failOn = FailOn.safeParse(input("fail-on") || "unbacked");
  if (!failOn.success) throw new Error(`input fail-on must be unbacked or never, got ${input("fail-on")}`);
  const minutes = Number(input("wait-minutes") || "10");
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`input wait-minutes must be a number of minutes, got ${input("wait-minutes")}`);
  return { token, failOn: failOn.data, waitMs: minutes * 60_000, checkName: input("check-name") || "receipts" };
}

const PullRequestEvent = z.object({
  pull_request: z.object({ number: z.number().int(), head: z.object({ sha: z.string() }) }),
});

const Env = z.object({
  GITHUB_EVENT_NAME: z.string(),
  GITHUB_EVENT_PATH: z.string(),
  GITHUB_REPOSITORY: z.string().regex(/^[^/]+\/[^/]+$/),
  GITHUB_RUN_ID: z.string(),
  GITHUB_SERVER_URL: z.string().default("https://github.com"),
  GITHUB_API_URL: z.string().default("https://api.github.com"),
  GITHUB_STEP_SUMMARY: z.string().optional(),
});

const CheckRunsPage = z.object({ check_runs: z.array(CheckRunStatus) });

async function waitForChecks({ github, repo, sha, self, limitMs }: { github: GitHub; repo: string; sha: string; self: Self; limitMs: number }) {
  const started = Date.now();
  for (;;) {
    const runs = await github.pages(`/repos/${repo}/commits/${sha}/check-runs`, (page) => CheckRunsPage.parse(page).check_runs);
    const decision = decideWait({ runs: z.array(CheckRunStatus).parse(runs), self, elapsedMs: Date.now() - started, limitMs });
    switch (decision.kind) {
      case "ready":
        return;
      case "give_up":
        process.stdout.write(`::warning::Stopped waiting after ${limitMs / 60_000} min; still running: ${decision.pending.join(", ")}\n`);
        return;
      case "wait":
        process.stdout.write(`Waiting for ${decision.pending.length} check(s): ${decision.pending.join(", ")}\n`);
        await sleep(POLL_MS);
        break;
      default: {
        const _exhaustive: never = decision;
        return _exhaustive;
      }
    }
  }
}

/** Cuts by UTF-8 bytes, which stays under the limit however GitHub counts characters. */
export function capSummary(markdown: string): string {
  const bytes = Buffer.from(markdown);
  if (bytes.length <= SUMMARY_LIMIT) return markdown;
  const note = "\n\n(Cut to fit the check run; the job's step summary has the full table.)";
  const kept = new TextDecoder().decode(bytes.subarray(0, SUMMARY_LIMIT - Buffer.byteLength(note)));
  return kept.replace(/\uFFFD$/, "") + note;
}

/** Exit code: 1 on an error, or when no check run could be written and fail-on says a verdict fails the step. */
export async function run(): Promise<number> {
  try {
    return await checkThisPullRequest();
  } catch (error) {
    process.stdout.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function checkThisPullRequest(): Promise<number> {
  const env = Env.parse(process.env);
  if (env.GITHUB_EVENT_NAME !== "pull_request" && env.GITHUB_EVENT_NAME !== "pull_request_target") {
    process.stdout.write(`::notice::receipts checks pull requests; nothing to do on ${env.GITHUB_EVENT_NAME}\n`);
    return 0;
  }
  const inputs = parseInputs(process.env);
  const event = PullRequestEvent.parse(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")));
  const [owner = "", repo = ""] = env.GITHUB_REPOSITORY.split("/");
  const pull: PullRef = { owner, repo, number: event.pull_request.number };
  const sha = event.pull_request.head.sha;
  const self: Self = { runId: env.GITHUB_RUN_ID, checkName: inputs.checkName };
  const github = gitHub({ token: inputs.token, baseUrl: env.GITHUB_API_URL });

  await waitForChecks({ github, repo: env.GITHUB_REPOSITORY, sha, self, limitMs: inputs.waitMs });

  const pr = parseReceipts(await fetchReceipts({ github, pull }));
  const report = checkPullRequest(pr, { ignoreCheck: (c) => isOwnCheck({ name: c.name, urls: [c.url] }, self) });
  const summary = summarize(report, inputs.failOn);
  process.stdout.write(`${summary.text}\n`);
  if (env.GITHUB_STEP_SUMMARY !== undefined) await appendFile(env.GITHUB_STEP_SUMMARY, `${summary.markdown}\n`);

  try {
    await github.post(`/repos/${env.GITHUB_REPOSITORY}/check-runs`, {
      name: inputs.checkName,
      head_sha: sha,
      status: "completed",
      conclusion: summary.conclusion,
      details_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      output: { title: summary.title, summary: capSummary(summary.markdown) },
    });
    return 0;
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 403) throw error;
    process.stdout.write(
      "::warning::This token cannot create check runs (a fork pull request or a read-only token), so the verdicts are in the step summary only\n",
    );
    return summary.conclusion === "failure" ? 1 : 0;
  }
}
