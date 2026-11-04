import { z } from "zod";
import type { PullRef } from "../client.ts";

/** One pull request to check at one head commit, through one installation of the App. */
export interface Target {
  readonly installationId: number;
  readonly pull: PullRef;
  readonly sha: string;
}

const PULL_ACTIONS = new Set(["opened", "edited", "synchronize", "reopened"]);

const Installation = z.object({ id: z.number().int() });
const Repository = z.object({ id: z.number().int(), name: z.string(), owner: z.object({ login: z.string() }) });
const SuitePull = z.object({ number: z.number().int(), base: z.object({ repo: z.object({ id: z.number().int() }) }) });
const App = z.object({ id: z.number().int() }).nullable();

const PullRequestEvent = z.object({
  action: z.string(),
  installation: Installation,
  repository: Repository,
  pull_request: z.object({ number: z.number().int(), head: z.object({ sha: z.string() }) }),
});

const CheckSuiteEvent = z.object({
  action: z.string(),
  installation: Installation,
  repository: Repository,
  check_suite: z.object({ app: App, head_sha: z.string(), pull_requests: z.array(SuitePull) }),
});

const CheckRunEvent = z.object({
  action: z.string(),
  installation: Installation,
  repository: Repository,
  check_run: z.object({ app: App, head_sha: z.string(), pull_requests: z.array(SuitePull) }),
});

/**
 * What a webhook delivery asks the App to check. A pull request is checked when it opens or changes, again each time
 * another app's check suite finishes on its head (so verdicts see CI's final results), and when someone re-runs
 * the App's own check run. Everything else, including the App's own suites finishing, is nothing to do.
 */
export function targets(event: string, payload: unknown, appId: number): Target[] {
  switch (event) {
    case "pull_request": {
      const e = PullRequestEvent.parse(payload);
      if (!PULL_ACTIONS.has(e.action)) return [];
      return [{ installationId: e.installation.id, pull: pullOf(e.repository, e.pull_request.number), sha: e.pull_request.head.sha }];
    }
    case "check_suite": {
      const e = CheckSuiteEvent.parse(payload);
      if (e.action !== "completed" || e.check_suite.app?.id === appId) return [];
      return fromSuite(e.installation.id, e.repository, e.check_suite);
    }
    case "check_run": {
      const e = CheckRunEvent.parse(payload);
      if (e.action !== "rerequested" || e.check_run.app?.id !== appId) return [];
      return fromSuite(e.installation.id, e.repository, e.check_run);
    }
    default:
      return [];
  }
}

function pullOf(repository: z.infer<typeof Repository>, number: number): PullRef {
  return { owner: repository.owner.login, repo: repository.name, number };
}

/** A suite lists pull requests from any repository whose branch holds the commit; keep this repository's own. */
function fromSuite(
  installationId: number,
  repository: z.infer<typeof Repository>,
  suite: { head_sha: string; pull_requests: readonly z.infer<typeof SuitePull>[] },
): Target[] {
  return suite.pull_requests
    .filter((pull) => pull.base.repo.id === repository.id)
    .map((pull) => ({ installationId, pull: pullOf(repository, pull.number), sha: suite.head_sha }));
}
