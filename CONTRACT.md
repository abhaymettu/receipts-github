# Contract

What receipts-github checks, against which receipts, and how its accuracy will be measured. Written before the
labelled set exists, so the measures below cannot be tuned to the result.

## Verdicts

Every claim gets one of three verdicts.

| Verdict | Meaning | Basis |
|---|---|---|
| **verified** | A receipt on the pull request backs the claim. | |
| **unbacked** | The pull request could carry a receipt for the claim, and none backs it. | `contradicted`: the check failed on the head commit. `stale`: it passed only on an older commit. `missing`: no such check ran. |
| **unverifiable** | Nothing a pull request carries could back the claim (a command run on the author's machine), or the check that would decide it had not finished. | |

Receipts' session verdicts map onto these. Supported becomes verified, contradicted becomes unbacked/contradicted, and
unbacked becomes unbacked/stale or unbacked/missing. Unverifiable is new. A session records every command an agent
ran, and a pull request records only what CI ran.

## Claim types

The families are receipts' labelling rubric families
([rubric](https://github.com/abhaymettu/receipts/blob/main/receipts/rubric.md)). The count column is how many of
receipts' 2,082 labelled claims carry that family, read from its labelled set (`bench/label.py` output, gold
labels on the test split plus rater A on the dev split). Each example is a real labelled span from that set.

| Family | Prefilter kinds | Labelled | Example from receipts' labels | Receipt that can back it in a PR | Rule |
|---|---|---|---|---|---|
| tests | `test_pass` | 151 | "46 tests pass." | A check run or status on the head commit that runs tests, by name or by an Actions `Run` step matching receipts' `TEST` command pattern | Every such check on the head commit passed. Failed: contradicted. Only on older commits: stale. None: missing. Pending: unverifiable. |
| build | `build_pass`, `typecheck_pass`, `lint_pass` | 33 | "`claude plugin validate .` now passes." | A check that builds, type-checks or lints, by name or `Run` step (`BUILD`, `TYPECHECK`, `LINT`) | As tests. A build claim falls back to a passing test check and a type-check claim to a passing build check, as receipts does. |
| files | `file_change` | 698 | "Added a top-level README." | `pulls/{n}/files` | Every file or directory the claim names is in the diff, by path, suffix or basename, renames included. No file named: verified when the diff is not empty, as receipts does. |
| git | `commit`, `push`, `pr` | 153 | "Done. Committed as `9dff3d8`." | `pulls/{n}/commits` | A named sha must prefix a commit in the PR. A push is the PR's head. A PR number other than this one is unverifiable. |
| ship | `deployed`, `installed` | 70 | "Python 3.14.7 plus all three deps install clean." | A deploy check or status (`DEPLOY` pattern or a deploy name) on the head commit | Deploy as tests, but no deploy check is unverifiable, since deploys often run after merge. Installs are unverifiable. |
| ran | `ran` | 404 | "I sent you two screenshots." | An Actions `Run` step or check name on the head commit that names what the claim names | Found: verified. Otherwise unverifiable. |
| verified | `verified` | 391 | "I looked at the screenshots." | As ran, or a passing test check on the head commit | Otherwise unverifiable. |
| works | `works` | 182 | "Phase A discovery is complete." | A passing test check on the head commit. Changed test files are listed as supporting evidence. | As tests. A build or lint check alone does not exercise behaviour. |

Claims are read from the pull request's title, its description with HTML comments removed, and each commit message
with trailers (`Co-authored-by`, `Signed-off-by`) removed. The same claim repeated across those parts is checked once.

Out of scope for the prefilter, left to the model extractor planned for the App: claims the regex layer has no kind for
("no behaviour change", "backwards compatible", "handles the empty case"). Findings an agent reads off output (a
results table, a measured value) are not claims, as in the rubric.

## Receipt sources

Every field the checker reads, and nothing else. All are GitHub REST v3 (`X-GitHub-Api-Version: 2022-11-28`).

| Receipt | Endpoint | Fields |
|---|---|---|
| Pull request | `GET /repos/{o}/{r}/pulls/{n}` | `number`, `html_url`, `title`, `body`, `user.login`, `user.type`, `head.sha` |
| Diff | `GET /repos/{o}/{r}/pulls/{n}/files` | `filename`, `previous_filename`, `status`, `additions`, `deletions` |
| Commits | `GET /repos/{o}/{r}/pulls/{n}/commits` | `sha`, `commit.message` |
| Check runs | `GET /repos/{o}/{r}/commits/{sha}/check-runs`, head plus up to 20 PR commits | `id`, `name`, `head_sha`, `status`, `conclusion`, `html_url`, `app.slug` |
| Statuses | `GET /repos/{o}/{r}/commits/{sha}/status` | `statuses[].context`, `state`, `target_url` |
| Actions logs | `GET /repos/{o}/{r}/actions/jobs/{id}/logs`, Actions check runs only, at most 30 | the first line of each `##[group]Run <command>` |

A check run's conclusion maps to a state. `success` and `neutral` are success. `skipped`, `cancelled` and `stale` are
skipped, because a run cancelled by a newer push never judged the code. `action_required` and anything not completed
are pending. Any other conclusion (`failure`, `timed_out`) is failure. A status maps `success` and `pending` to
themselves, and `error` and `failure` to failure.

Permissions: read-only access to contents, pull requests, checks, statuses and Actions, plus `checks: write` to post
the one check run. The Action posts on repositories that install it. The hosted App, when it exists, stays on
Abhay's own repositories until the labelled set below has measured its precision.

## The labelled set

Preregistered 2026-11-04. The protocol and the frozen ids below are fixed before any pull request is labelled.

**Pull requests.** [`data/prs.json`](data/prs.json) holds 200 pull request ids, frozen by
[`scripts/freeze-corpus.ts`](scripts/freeze-corpus.ts) and recorded with its rules. They come from two sources. The
first is Abhay's own pull requests in public repositories, most of them written by his coding agents. The second is
public pull requests from seven agent sources (Copilot coding agent, Devin, Jules, Cursor, the Claude GitHub app,
Claude Code, OpenAI Codex), drawn in equal quotas (an agent short of its quota hands the rest round-robin to the others) from repositories with 10 or more stars and 3 or more pull requests
from that agent in the window, at most 3 per repository, Dependabot and Renovate excluded. The window runs from
2026-09-01 to 2026-10-31. Laneproof's lanes have opened no pull requests on GitHub
(`gh pr list -R abhaymettu/laneproof --state all` returns none on 2026-11-03), so that source is empty and its
share went to the public sources.

sha256 of `data/prs.json`: `59889f2f1a19b7977ab8fe25b1e0dc428d5e86e7fe394c6257de6749ba1c0b5e`

Counts: 8 of his own, then Copilot 46, Claude Code 43, Claude app 38, Devin 34, Cursor 16, Jules 10, Codex 5.

**Split.** The set divides into dev and test halves by a hash of the repository name, so no repository spans both.
Rules are tuned on dev only. Test is scored once, after the rules are frozen and tagged.

**Dossier.** Each labeller sees one file per pull request. It holds the title, the description, every commit
message, the changed file list with statuses, every check run and status on every fetched commit with its state,
and the Actions `Run` lines. It is the `RawReceipts` this package fetches, rendered as text. No labeller sees the
checker's verdicts.

**Labellers.** Two, blind to each other.

- **H**: Abhay Mettu, by hand.
- **M**: a model given the same dossier and the rubric. The model and prompt are fixed in `bench/` before labelling
  starts.

**Task.** It follows receipts' rubric, step for step. Step 1 lists each claim in the title, description and commit
messages with its family. Step 2 gives each claim a verdict (verified, unbacked, unverifiable) and a basis
(contradicted, stale, missing), using the definitions at the top of this file.

**Matching.** Two claims match when one span contains the other or their token Jaccard is 0.5 or more. Pairs are made
greedily, same family first. This is receipts' `bench/score.py` rule.

**Agreement.** It is reported before adjudication: the claim-set F1 between H and M, Cohen's kappa on the
three-way verdict for matched claims, and kappa on the flag (unbacked versus not).

**Gold.** H adjudicates every disagreement after both have finished and records a one-line reason. The adjudicated
labels are gold.

**What is scored.** On the test half, against gold: extraction precision and recall, flag precision and recall for
unbacked, and verdict kappa. Each has a Wilson 95% interval, plus a bootstrap interval that resamples repositories.
The unbacked rate by agent is also reported, with intervals, and only for agents with 20 or more gold claims.

## Prefilter reproduction

The bar for the ported prefilter is that it reproduces receipts' category on receipts' own claims at 90% or better.
It is measured by `npm run bench:prefilter` over the 2,082 labelled claims. Only aggregates leave the private data
directory, in [`bench/results/prefilter.json`](bench/results/prefilter.json). The measures were defined before the
port ran:

- **M1, port fidelity**: the share of inputs where the TypeScript prefilter's output (kind, sentence, files, sha, in
  order) equals receipts' Python prefilter's output exactly. This is the reproduction bar.
- **M2, detection**: the share of labelled claims whose span yields at least one claim.
- **M3, category agreement**: the share of labelled claims whose labelled family is among the families extracted from
  the span.
- **M4, conditional category agreement**: M3 divided by M2, the category accuracy when the prefilter fires.
- **M5, exact span agreement**: the share of distinct spans whose extracted family set equals the labelled family set.

M2 to M5 compare the regex layer with human labels. Receipts' README already says that layer misses most claims,
which is why the App adds a model extractor where the regex misses.
