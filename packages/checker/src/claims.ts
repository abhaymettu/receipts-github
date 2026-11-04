/**
 * Claims a pull request makes about its own work, pulled from its title, description and commit messages.
 *
 * The regex prefilter is ported from receipts (github.com/abhaymettu/receipts, receipts/claims.py) and must
 * extract exactly what that module extracts from the same text.
 */

export type Kind =
  | "test_pass"
  | "typecheck_pass"
  | "lint_pass"
  | "build_pass"
  | "pr"
  | "push"
  | "commit"
  | "deployed"
  | "installed"
  | "works"
  | "verified"
  | "ran"
  | "file_change";

/** The labelling rubric's families: the category a human labeller gives a claim. */
export type Family = "tests" | "build" | "files" | "git" | "ship" | "ran" | "verified" | "works";

export const FAMILY = {
  test_pass: "tests",
  typecheck_pass: "build",
  lint_pass: "build",
  build_pass: "build",
  pr: "git",
  push: "git",
  commit: "git",
  deployed: "ship",
  installed: "ship",
  works: "works",
  verified: "verified",
  ran: "ran",
  file_change: "files",
} as const satisfies Record<Kind, Family>;

export interface Claim {
  readonly kind: Kind;
  /** The sentence, at most 400 code points. */
  readonly text: string;
  /** Files and directories the sentence names. */
  readonly files: readonly string[];
  /** A commit sha the sentence names, for git claims only. */
  readonly sha: string | null;
}

export function extract(_report: string): Claim[] {
  return [];
}
