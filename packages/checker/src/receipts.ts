import { z } from "zod";

/**
 * The receipts a pull request carries, as the checker sees them.
 *
 * GitHub's REST responses are parsed once, in `parseReceipts`, into these types. Check runs and commit
 * statuses both become a `Check`, so a verdict never cares which API a CI system reports through.
 */

export type Sha = string & { readonly __brand: "Sha" };

export type CheckState = "pending" | "success" | "failure" | "skipped";

export interface Check {
  readonly source: "check_run" | "status";
  readonly name: string;
  readonly sha: Sha;
  readonly state: CheckState;
  readonly url: string | null;
  /** Shell commands the job ran, read from its Actions log. Empty when no log was read. */
  readonly commands: readonly string[];
}

export type FileStatus = "added" | "removed" | "modified" | "renamed";

export interface ChangedFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
}

export interface Commit {
  readonly sha: Sha;
  readonly message: string;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly author: { readonly login: string; readonly isBot: boolean };
  readonly headSha: Sha;
  /** Oldest first, as `pulls/{n}/commits` returns them. */
  readonly commits: readonly Commit[];
  readonly files: readonly ChangedFile[];
  readonly checks: readonly Check[];
}

const PullSchema = z.object({
  number: z.number().int(),
  html_url: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string(), type: z.string() }),
  head: z.object({ sha: z.string() }),
});

const FileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int(),
  deletions: z.number().int(),
});

const CommitSchema = z.object({
  sha: z.string(),
  commit: z.object({ message: z.string() }),
});

const CheckRunSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable(),
});

const StatusSchema = z.object({
  context: z.string(),
  state: z.enum(["error", "failure", "pending", "success"]),
  target_url: z.string().nullable(),
});

/** The raw responses for one pull request, exactly as the GitHub REST API returned them. */
export interface RawReceipts {
  /** `GET /repos/{owner}/{repo}/pulls/{n}` */
  readonly pull: unknown;
  /** `GET /repos/{owner}/{repo}/pulls/{n}/files`, all pages concatenated */
  readonly files: unknown;
  /** `GET /repos/{owner}/{repo}/pulls/{n}/commits`, all pages concatenated */
  readonly commits: unknown;
  /** `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` per commit, keyed by sha, `.check_runs` of each */
  readonly checkRuns: Readonly<Record<string, unknown>>;
  /** `GET /repos/{owner}/{repo}/commits/{sha}/status` per commit, keyed by sha, `.statuses` of each */
  readonly statuses: Readonly<Record<string, unknown>>;
  /** `GET /repos/{owner}/{repo}/actions/jobs/{id}/logs` per Actions check run id, as text */
  readonly logs: Readonly<Record<string, string>>;
}

const asSha = (s: string): Sha => s.toLowerCase() as Sha;

/** A run cancelled or marked stale by a newer push never judged the code, so it counts as skipped, not failed. */
function checkRunState(status: string, conclusion: string | null): CheckState {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
    case "neutral":
      return "success";
    case "skipped":
    case "cancelled":
    case "stale":
      return "skipped";
    case "action_required":
      return "pending";
    default:
      return "failure";
  }
}

const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const ANSI = /\u001b\[[\d;]*m/g;
const STEP_META = /^(?:shell|with|env):/;

/**
 * The commands each Actions step ran: the `##[group]Run <cmd>` line and, for a multi-line `run:` block, the script
 * lines echoed after it, up to the step's `shell:`, `with:` or `env:` line.
 */
export function commandsFromLog(log: string): string[] {
  const out: string[] = [];
  let inStep = false;
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.replace(STAMP, "").replace(ANSI, "");
    if (line.startsWith("##[group]Run ")) {
      inStep = true;
      out.push(line.slice("##[group]Run ".length).trim());
    } else if (line.startsWith("##[endgroup]") || STEP_META.test(line)) {
      inStep = false;
    } else if (inStep && line.trim().length > 0) {
      out.push(line.trim());
    }
  }
  return [...new Set(out.filter((c) => c.length > 0))];
}

export function parseReceipts(raw: RawReceipts): PullRequest {
  const pull = PullSchema.parse(raw.pull);
  const files = z.array(FileSchema).parse(raw.files);
  const commits = z.array(CommitSchema).parse(raw.commits);

  const checks: Check[] = [];
  for (const [sha, runs] of Object.entries(raw.checkRuns)) {
    for (const run of z.array(CheckRunSchema).parse(runs)) {
      const log = raw.logs[String(run.id)];
      checks.push({
        source: "check_run",
        name: run.name,
        sha: asSha(run.head_sha || sha),
        state: checkRunState(run.status, run.conclusion),
        url: run.html_url,
        commands: log === undefined ? [] : commandsFromLog(log),
      });
    }
  }
  for (const [sha, statuses] of Object.entries(raw.statuses)) {
    for (const s of z.array(StatusSchema).parse(statuses)) {
      checks.push({
        source: "status",
        name: s.context,
        sha: asSha(sha),
        state: s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failure",
        url: s.target_url,
        commands: [],
      });
    }
  }

  return {
    number: pull.number,
    url: pull.html_url,
    title: pull.title,
    body: pull.body ?? "",
    author: { login: pull.user.login, isBot: pull.user.type === "Bot" },
    headSha: asSha(pull.head.sha),
    commits: commits.map((c) => ({ sha: asSha(c.sha), message: c.commit.message })),
    files: files.map((f) => ({
      path: f.filename,
      previousPath: f.previous_filename ?? null,
      status: f.status === "added" || f.status === "removed" || f.status === "renamed" ? f.status : "modified",
      additions: f.additions,
      deletions: f.deletions,
    })),
    checks,
  };
}
