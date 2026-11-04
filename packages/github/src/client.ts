import { z } from "zod";
import type { RawReceipts } from "@receipts-github/checker";

export const API_VERSION = "2022-11-28";

/** Check runs and statuses are read for the head commit and this many of the most recent commits. */
export const MAX_COMMITS = 20;
/** Actions job logs read per pull request. */
export const MAX_LOGS = 30;

export interface PullRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const NAME = "[A-Za-z0-9_.-]+";
const PULL_URL = new RegExp(`^https?://github\\.com/(${NAME})/(${NAME})/pull/(\\d+)(?:[/?#].*)?$`);
const PULL_SHORT = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);

/** Reads `https://github.com/o/r/pull/n` or `o/r#n`. */
export function parsePullRef(input: string): PullRef | null {
  const match = PULL_URL.exec(input.trim()) ?? PULL_SHORT.exec(input.trim());
  if (match === null) return null;
  const [, owner = "", repo = "", digits = ""] = match;
  const number = Number(digits);
  return number > 0 ? { owner, repo, number } : null;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly path: string;

  constructor({ method, path, status, detail }: { method: string; path: string; status: number; detail: string }) {
    super(`GitHub ${method} ${path} returned ${status}${detail === "" ? "" : `: ${detail}`}`);
    this.name = "GitHubError";
    this.status = status;
    this.path = path;
  }
}

export interface GitHub {
  json(path: string): Promise<unknown>;
  /** Follows `Link: rel="next"` and concatenates what `items` picks out of each page. */
  pages(path: string, items: (page: unknown) => readonly unknown[]): Promise<unknown[]>;
  text(path: string): Promise<string>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
}

export interface GitHubOptions {
  readonly token: string | null;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

const NEXT_LINK = /<([^>]+)>;\s*rel="next"/;
const ErrorBody = z.object({ message: z.string() });

export function gitHub({ token, baseUrl = "https://api.github.com", fetch: send = fetch }: GitHubOptions): GitHub {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "receipts-github",
  };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;

  async function request(method: string, pathOrUrl: string, body?: unknown): Promise<Response> {
    const url = pathOrUrl.startsWith("https://") || pathOrUrl.startsWith("http://") ? pathOrUrl : baseUrl + pathOrUrl;
    const init: RequestInit = { method, headers, redirect: "follow" };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await send(url, init).catch((error: unknown) => {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
      throw new Error(`GitHub ${method} ${url} did not answer: ${cause}`);
    });
    if (response.ok) return response;
    const path = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
    throw new GitHubError({ method, path, status: response.status, detail: await errorDetail(response) });
  }

  return {
    json: async (path) => (await request("GET", path)).json(),
    text: async (path) => (await request("GET", path)).text(),
    post: async (path, body) => (await request("POST", path, body)).json(),
    patch: async (path, body) => (await request("PATCH", path, body)).json(),
    async pages(path, items) {
      const all: unknown[] = [];
      let next: string | null = path + (path.includes("?") ? "&" : "?") + "per_page=100";
      while (next !== null) {
        const response = await request("GET", next);
        all.push(...items(await response.json()));
        next = NEXT_LINK.exec(response.headers.get("link") ?? "")?.[1] ?? null;
      }
      return all;
    },
  };
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  const parsed = ErrorBody.safeParse(safeJson(text));
  const message = parsed.success ? parsed.data.message : text.slice(0, 200);
  return response.headers.get("x-ratelimit-remaining") === "0" ? `${message} (rate limit exhausted)` : message;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const AnyArray = z.array(z.unknown());
const PullHead = z.object({ head: z.object({ sha: z.string() }) });
const CommitShas = z.array(z.object({ sha: z.string() }));
const CheckRunsPage = z.object({ check_runs: z.array(z.unknown()) });
const StatusPage = z.object({ statuses: z.array(z.unknown()) });
const ActionsRun = z.object({ id: z.number().int(), app: z.object({ slug: z.string() }).nullable() });

/**
 * Each `##[group]Run <cmd>` block through its `##[endgroup]`, and nothing else: the block holds a multi-line
 * `run:` script and its `shell:` line, which `commandsFromLog` reads. A megabyte job log keeps a few kilobytes.
 */
export function runGroups(log: string): string {
  const kept: string[] = [];
  let inRun = false;
  for (const line of log.split(/\r?\n/)) {
    if (line.includes("##[group]Run ")) inRun = true;
    if (inRun) kept.push(line);
    if (line.includes("##[endgroup]")) inRun = false;
  }
  return kept.join("\n");
}

/** Statuses GitHub returns for a log it will not hand over: expired, deleted, or needs a token. */
const MISSING_LOG = new Set([401, 403, 404, 410]);

/** How much history to read; the App lowers both to stay inside a Worker's subrequest budget. */
export interface Limits {
  readonly commits: number;
  readonly logs: number;
}

export async function fetchReceipts({
  github,
  pull,
  limits = { commits: MAX_COMMITS, logs: MAX_LOGS },
}: {
  github: GitHub;
  pull: PullRef;
  limits?: Limits;
}): Promise<RawReceipts> {
  const repo = `/repos/${pull.owner}/${pull.repo}`;
  const [pullJson, files, commits] = await Promise.all([
    github.json(`${repo}/pulls/${pull.number}`),
    github.pages(`${repo}/pulls/${pull.number}/files`, (page) => AnyArray.parse(page)),
    github.pages(`${repo}/pulls/${pull.number}/commits`, (page) => AnyArray.parse(page)),
  ]);

  const recent = CommitShas.parse(commits).map((c) => c.sha).slice(-limits.commits).reverse();
  const shas = [...new Set([PullHead.parse(pullJson).head.sha, ...recent])];

  const perSha = await mapLimit(shas, async (sha) => {
    const [runs, statuses] = await Promise.all([
      github.pages(`${repo}/commits/${sha}/check-runs`, (page) => CheckRunsPage.parse(page).check_runs),
      github.pages(`${repo}/commits/${sha}/status`, (page) => StatusPage.parse(page).statuses),
    ]);
    return { sha, runs, statuses };
  });

  const actionsJobIds = perSha
    .flatMap(({ runs }) => z.array(ActionsRun).parse(runs))
    .filter((run) => run.app?.slug === "github-actions")
    .map((run) => run.id)
    .slice(0, limits.logs);

  const logs = await mapLimit(actionsJobIds, async (id) => {
    try {
      return [String(id), runGroups(await github.text(`${repo}/actions/jobs/${id}/logs`))] as const;
    } catch (error) {
      if (error instanceof GitHubError && MISSING_LOG.has(error.status)) return null;
      throw error;
    }
  });

  return {
    pull: pullJson,
    files,
    commits,
    checkRuns: Object.fromEntries(perSha.map(({ sha, runs }) => [sha, runs])),
    statuses: Object.fromEntries(perSha.map(({ sha, statuses }) => [sha, statuses])),
    logs: Object.fromEntries(logs.filter((entry) => entry !== null)),
  };
}

/** `Promise.all` over `items`, at most `limit` in flight, results in input order. */
async function mapLimit<T, R>(items: readonly T[], work: (item: T) => Promise<R>, limit = 8): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const queue = items.entries();
  const worker = async () => {
    for (const [index, item] of queue) results[index] = await work(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
