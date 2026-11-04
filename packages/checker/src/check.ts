import { extract, type Claim } from "./claims.ts";
import type { Check, PullRequest, Sha } from "./receipts.ts";
import { judge, type Status, type Verdict } from "./verdict.ts";

export type Where = { readonly part: "title" } | { readonly part: "body" } | { readonly part: "commit"; readonly sha: Sha };

export interface Finding {
  readonly claim: Claim;
  readonly where: Where;
  readonly verdict: Verdict;
}

export interface Report {
  readonly pr: Pick<PullRequest, "number" | "url" | "headSha">;
  readonly findings: readonly Finding[];
}

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const TRAILER = /^(?:Co-authored-by|Signed-off-by|Change-Id):.*$/gim;

/** PR templates hide instructions in HTML comments, and commit trailers are metadata, not claims. */
const prose = (text: string): string => text.replace(HTML_COMMENT, " ").replace(TRAILER, " ");

export function checkPullRequest(pr: PullRequest, options: { ignoreCheck?: (c: Check) => boolean } = {}): Report {
  const ignore = options.ignoreCheck;
  const seen: PullRequest = ignore === undefined ? pr : { ...pr, checks: pr.checks.filter((c) => !ignore(c)) };
  const parts: [Where, string][] = [
    [{ part: "title" }, pr.title],
    [{ part: "body" }, pr.body],
    ...pr.commits.map((c): [Where, string] => [{ part: "commit", sha: c.sha }, c.message]),
  ];
  const said = new Set<string>();
  const findings: Finding[] = [];
  for (const [where, text] of parts) {
    for (const claim of extract(prose(text))) {
      const key = `${claim.kind}\n${claim.text.toLowerCase()}`;
      if (said.has(key)) continue;
      said.add(key);
      findings.push({ claim, where, verdict: judge(claim, seen) });
    }
  }
  return { pr: { number: pr.number, url: pr.url, headSha: pr.headSha }, findings };
}

const ORDER: readonly Status[] = ["unbacked", "unverifiable", "verified"];
const MARK: Readonly<Record<Status, string>> = { unbacked: "✗", unverifiable: "?", verified: "✓" };

export type Conclusion = "success" | "neutral" | "failure";

export interface Summary {
  readonly title: string;
  readonly conclusion: Conclusion;
  readonly markdown: string;
  readonly text: string;
}

function counts(report: Report): Record<Status, number> {
  const n: Record<Status, number> = { unbacked: 0, unverifiable: 0, verified: 0 };
  for (const f of report.findings) n[f.verdict.status] += 1;
  return n;
}

const cell = (s: string, max = 200): string => {
  const one = s.replace(/\s+/g, " ").trim();
  const cut = [...one].length > max ? `${[...one].slice(0, max - 1).join("")}…` : one;
  return cut.replace(/\|/g, "\\|");
};

function whereMarkdown(report: Report, where: Where): string {
  switch (where.part) {
    case "title":
      return "title";
    case "body":
      return "description";
    case "commit":
      return `[${where.sha.slice(0, 7)}](${report.pr.url}/commits/${where.sha})`;
  }
}

function receiptMarkdown(report: Report, v: Verdict): string {
  if (v.status === "unverifiable") return cell(v.reason, 300);
  const links = v.evidence.flatMap((e) => {
    switch (e.kind) {
      case "check":
        return e.check.url === null ? [] : [`[${cell(e.check.name, 60)}](${e.check.url})`];
      case "file":
        return [];
      case "commit":
        return [`[${e.commit.sha.slice(0, 7)}](${report.pr.url}/commits/${e.commit.sha})`];
    }
  });
  const files = v.evidence.some((e) => e.kind === "file") ? [`[diff](${report.pr.url}/files)`] : [];
  const more = [...new Set([...links, ...files])].slice(0, 4);
  return [cell(v.reason, 300), ...more].join(" · ");
}

const sorted = (report: Report): Finding[] =>
  [...report.findings].sort((a, b) => ORDER.indexOf(a.verdict.status) - ORDER.indexOf(b.verdict.status));

export function summarize(report: Report, failOn: "unbacked" | "never"): Summary {
  const n = counts(report);
  const total = report.findings.length;
  const title =
    total === 0
      ? "No checkable claims"
      : `${n.unbacked} unbacked, ${n.unverifiable} unverifiable, ${n.verified} verified of ${total} claim${total === 1 ? "" : "s"}`;
  const conclusion: Conclusion = total === 0 ? "neutral" : n.unbacked === 0 ? "success" : failOn === "unbacked" ? "failure" : "neutral";

  const head = report.pr.headSha.slice(0, 7);
  const rows = sorted(report).map(
    (f) =>
      `| ${MARK[f.verdict.status]} ${f.verdict.status} | ${cell(f.claim.text)} | ${whereMarkdown(report, f.where)} | ${receiptMarkdown(report, f.verdict)} |`,
  );
  const markdown = [
    total === 0
      ? `No claim in the title, description or commit messages of this pull request names something a receipt could back (head ${head}).`
      : `Each claim in this pull request's title, description and commit messages, checked against its diff, checks and commits at head ${head}.`,
    ...(total === 0 ? [] : ["", "| Verdict | Claim | Where | Receipt |", "|---|---|---|---|", ...rows]),
    "",
    "**verified**: a receipt on this pull request backs it. **unbacked**: the pull request could carry a receipt for it and none does (a check failed, passed only on an older commit, or never ran). **unverifiable**: nothing a pull request carries could back it, or its check had not finished.",
  ].join("\n");

  const text = [
    ...sorted(report).flatMap((f) => [
      `${f.where.part === "commit" ? `commit ${f.where.sha.slice(0, 7)}` : f.where.part}`.padEnd(15) +
        `${f.verdict.status.toUpperCase()}`.padEnd(14) +
        f.claim.kind.padEnd(16) +
        cell(f.claim.text, 100),
      `${" ".repeat(15)}-> ${f.verdict.reason}`,
    ]),
    `${report.pr.url} @ ${head}: ${title}`,
  ].join("\n");

  return { title, conclusion, markdown, text };
}
