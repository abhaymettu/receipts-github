import { z } from "zod";
import { checkPullRequest, parseReceipts, summarize, type Check } from "@receipts-github/checker";
import { fetchReceipts, type GitHub, type Limits } from "../client.ts";
import { capSummary } from "../summary.ts";
import type { Target } from "./events.ts";

export const CHECK_NAME = "receipts";

/**
 * A Worker on the free plan may make 50 subrequests per delivery. Five commits and ten job logs keep a check near
 * 30: the token, three pull request reads, two per commit, the logs, the lookup and the write.
 */
export const APP_LIMITS: Limits = { commits: 5, logs: 10 };

export type Outcome =
  | { readonly kind: "stale"; readonly headSha: string }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "written"; readonly status: "in_progress" | "completed"; readonly title: string; readonly checkRunId: number };

const OwnRuns = z.object({
  check_runs: z.array(z.object({ id: z.number().int(), status: z.string(), app: z.object({ id: z.number().int() }).nullable() })),
});
const Written = z.object({ id: z.number().int() });

/** The App's own check run, and the Action's if a repository runs both, judge nothing and wait for nothing. */
const isReceipts = (check: Check): boolean => check.name === CHECK_NAME;

/**
 * Reads the pull request's receipts and writes the App's check run on its head: in progress while other checks run,
 * completed with the verdicts once they have finished. A delivery for an older head writes nothing, since the push
 * that moved the head brings its own delivery.
 */
export async function checkTarget({ github, target, appId }: { github: GitHub; target: Target; appId: number }): Promise<Outcome> {
  const pr = parseReceipts(await fetchReceipts({ github, pull: target.pull, limits: APP_LIMITS }));
  if (pr.headSha !== target.sha) return { kind: "stale", headSha: pr.headSha };

  const repo = `/repos/${target.pull.owner}/${target.pull.repo}`;
  const pending = pr.checks.filter((c) => c.sha === pr.headSha && c.state === "pending" && !isReceipts(c)).map((c) => c.name);
  const summary = summarize(checkPullRequest(pr, { ignoreCheck: isReceipts }), "unbacked");

  const own = OwnRuns.parse(await github.json(`${repo}/commits/${pr.headSha}/check-runs?check_name=${CHECK_NAME}&filter=latest`))
    .check_runs.find((run) => run.app?.id === appId);
  // Deliveries race: one that saw a check still running must not reopen a run another already completed.
  if (pending.length > 0 && own?.status === "completed") return { kind: "skipped", reason: "already completed" };

  const fields =
    pending.length > 0
      ? {
          status: "in_progress",
          output: {
            title: `Waiting for ${pending.length} check${pending.length === 1 ? "" : "s"}`,
            summary: capSummary(`Still running: ${pending.join(", ")}\n\nVerdicts so far:\n\n${summary.markdown}`),
          },
        }
      : { status: "completed", conclusion: summary.conclusion, output: { title: summary.title, summary: capSummary(summary.markdown) } };

  const written = Written.parse(
    own === undefined
      ? await github.post(`${repo}/check-runs`, { name: CHECK_NAME, head_sha: pr.headSha, ...fields })
      : await github.patch(`${repo}/check-runs/${own.id}`, fields),
  );
  return { kind: "written", status: pending.length > 0 ? "in_progress" : "completed", title: fields.output.title, checkRunId: written.id };
}
