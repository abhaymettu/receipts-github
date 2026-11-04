/**
 * Freezes the 200 pull requests the blind labelling set is drawn from (CONTRACT.md, "The labelled set").
 *
 *   node scripts/freeze-corpus.ts            writes data/prs.json and prints its sha256
 *
 * Search results drift, so the frozen file, not this script, is the set; the script records how it was drawn.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const SEED = 20261104;
const WINDOW = { from: "2026-09-01", to: "2026-10-31" };
const TOTAL = 200;
const PER_REPO = 3;
const MIN_STARS = 10;
const MIN_AGENT_PRS = 3;
const OWN_ORGS = ["abhaymettu", "oneirum"];

const AGENTS = [
  { agent: "copilot", query: "author:app/copilot-swe-agent" },
  { agent: "devin", query: "author:app/devin-ai-integration" },
  { agent: "jules", query: "author:app/google-labs-jules" },
  { agent: "cursor", query: "author:app/cursor" },
  { agent: "claude-app", query: "author:app/claude" },
  { agent: "claude-code", query: '"Generated with Claude Code" in:body', marker: "Generated with [Claude Code]" },
  { agent: "codex", query: '"chatgpt.com/codex/tasks" in:body', marker: "chatgpt.com/codex/tasks" },
] as const;

interface Item {
  readonly number: number;
  readonly html_url: string;
  readonly repository_url: string;
  readonly body: string | null;
  readonly user: { readonly login: string; readonly type: string } | null;
  readonly created_at: string;
}

interface Scan {
  readonly agent: string;
  readonly query: string;
  readonly queue: Item[];
  readonly pool: number;
  got: number;
}

interface Pick {
  readonly id: string;
  readonly url: string;
  readonly source: "own" | "public";
  readonly agent: string;
  readonly created: string;
}

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, search = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (search) await sleep(2200);
    const res = await fetch(`https://api.github.com/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (res.ok) return (await res.json()) as T;
    const limited = res.status === 403 || res.status === 429;
    if ((!limited && res.status < 500) || attempt === 8) throw new Error(`${res.status} ${path}`);
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000 - Date.now();
    const wait = limited ? Math.max(Number(res.headers.get("retry-after") ?? 0) * 1000, reset, 30_000) : 5_000 * (attempt + 1);
    console.error(`${res.status}, waiting ${Math.round(wait / 1000)} s`);
    await sleep(Math.min(wait, 120_000));
  }
}

const search = (q: string, perPage: number, sort = true) =>
  api<{ total_count: number; items: Item[] }>(
    `search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}${sort ? "&sort=created&order=desc" : ""}`,
    true,
  );

function weeks(): [string, string][] {
  const out: [string, string][] = [];
  for (let d = new Date(`${WINDOW.from}T00:00:00Z`); d <= new Date(`${WINDOW.to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7)) {
    const end = new Date(d);
    end.setUTCDate(end.getUTCDate() + 6);
    const to = end > new Date(`${WINDOW.to}T00:00:00Z`) ? WINDOW.to : end.toISOString().slice(0, 10);
    out.push([d.toISOString().slice(0, 10), to]);
  }
  return out;
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const repoOf = (item: Item) => item.repository_url.replace("https://api.github.com/repos/", "");
const prose = (body: string | null) => (body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
const eligibleText = (item: Item) =>
  prose(item.body).length >= 40 && !/dependabot|renovate/i.test(item.user?.login ?? "");

const repoMeta = new Map<string, { public: boolean; stars: number; archived: boolean }>();
async function meta(repo: string) {
  const hit = repoMeta.get(repo);
  if (hit) return hit;
  const r = await api<{ private: boolean; stargazers_count: number; archived: boolean }>(`repos/${repo}`).catch(() => null);
  const m = { public: r !== null && !r.private, stars: r?.stargazers_count ?? 0, archived: r?.archived ?? true };
  repoMeta.set(repo, m);
  return m;
}

const traffic = new Map<string, number>();
async function agentPrs(repo: string, query: string) {
  const key = `${repo} ${query}`;
  const hit = traffic.get(key);
  if (hit !== undefined) return hit;
  const n = (await search(`is:pr repo:${repo} ${query} created:${WINDOW.from}..${WINDOW.to}`, 1, false)).total_count;
  traffic.set(key, n);
  return n;
}

const pick = (item: Item, source: Pick["source"], agent: string): Pick => ({
  id: `${repoOf(item)}#${item.number}`,
  url: item.html_url,
  source,
  agent,
  created: item.created_at.slice(0, 10),
});

async function main() {
  const own: Pick[] = [];
  const mine = await search(`is:pr author:abhaymettu created:2026-01-01..${WINDOW.to}`, 100);
  for (const item of mine.items) {
    if (eligibleText(item) && (await meta(repoOf(item))).public) own.push(pick(item, "own", "own"));
  }

  const picks: Pick[] = [...own];
  const perRepo = new Map<string, number>();
  const scans: Scan[] = [];
  for (const [i, a] of AGENTS.entries()) {
    const pool: Item[] = [];
    for (const [from, to] of weeks()) {
      const res = await search(`is:pr ${a.query} created:${from}..${to}`, 50);
      pool.push(...res.items.filter((it) => eligibleText(it) && ("marker" in a ? (it.body ?? "").includes(a.marker) : true)));
    }
    scans.push({ ...a, queue: shuffled(pool, SEED + i), pool: pool.length, got: 0 });
  }

  /** The next eligible pull request in this agent's shuffled pool, or null when the pool runs out. */
  async function next(scan: Scan): Promise<Pick | null> {
    for (let item = scan.queue.shift(); item !== undefined; item = scan.queue.shift()) {
      const repo = repoOf(item);
      if (OWN_ORGS.includes(repo.split("/")[0] ?? "") || (perRepo.get(repo) ?? 0) >= PER_REPO) continue;
      if (picks.some((p) => p.id === `${repo}#${item.number}`)) continue;
      const m = await meta(repo);
      if (!m.public || m.archived || m.stars < MIN_STARS) continue;
      if ((await agentPrs(repo, scan.query)) < MIN_AGENT_PRS) continue;
      perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
      return pick(item, "public", scan.agent);
    }
    return null;
  }

  // Equal quotas first; an agent whose pool runs out hands its share round-robin to the others.
  const quota = Math.floor((TOTAL - own.length) / AGENTS.length);
  for (const scan of scans) {
    while (scan.got < quota) {
      const p = await next(scan);
      if (p === null) break;
      picks.push(p);
      scan.got += 1;
    }
  }
  for (let open = scans.filter((s) => s.queue.length > 0); picks.length < TOTAL && open.length > 0; open = open.filter((s) => s.queue.length > 0)) {
    for (const scan of open) {
      if (picks.length === TOTAL) break;
      const p = await next(scan);
      if (p === null) continue;
      picks.push(p);
      scan.got += 1;
    }
  }
  for (const s of scans) console.error(`${s.agent}: pool ${s.pool}, picked ${s.got}`);

  const file = {
    frozen: new Date().toISOString().slice(0, 10),
    seed: SEED,
    window: WINDOW,
    rules: {
      total: TOTAL,
      own: "author:abhaymettu, public repos, description of 40+ characters outside HTML comments",
      public: `per agent query, 50 newest per week in the window, seeded shuffle; repo public, not archived, ${MIN_STARS}+ stars, ${MIN_AGENT_PRS}+ PRs from that agent in the window; at most ${PER_REPO} per repo; Dependabot and Renovate excluded; equal quotas, an agent short of its quota hands the rest round-robin to the others`,
      agents: AGENTS.map((a) => ({ agent: a.agent, query: a.query })),
    },
    counts: Object.fromEntries([...new Set(picks.map((p) => p.agent))].map((g) => [g, picks.filter((p) => p.agent === g).length])),
    prs: picks,
  };
  const json = `${JSON.stringify(file, null, 1)}\n`;
  writeFileSync(new URL("../data/prs.json", import.meta.url), json);
  console.log(`${picks.length} PRs, sha256 ${createHash("sha256").update(json).digest("hex")}`);
}

await main();
