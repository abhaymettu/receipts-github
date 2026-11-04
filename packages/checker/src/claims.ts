/**
 * Claims a pull request makes about its own work, pulled from its title, description and commit messages.
 *
 * The regex prefilter is ported from receipts (github.com/abhaymettu/receipts, receipts/claims.py) and must
 * extract exactly what that module extracts from the same text.
 *
 * A claim is one sentence (or bullet, or table row) asserting, as done or true, something a receipt could
 * back. Plans, hedges, questions and admissions ("I did not run the tests") are not claims. One sentence can
 * carry claims from different groups ("fixed the parser and tests pass"), but at most one per group.
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

// Python's str-pattern classes, which are Unicode-aware where JavaScript's \w \d \b are ASCII. \s differs in
// both directions: Python counts U+001C to U+001F and U+0085, JavaScript counts U+FEFF.
const WORD = String.raw`\p{L}\p{N}_`;
const DIGIT = String.raw`\p{Nd}`;
const SPACE = String.raw`\t-\r\x1c-\x20\x85\xa0  -     　`;
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
// Non-ASCII characters Python's re.IGNORECASE matches to an ASCII letter. The JS i flag is never used: under
// /iu a class like [\p{L}] also matches U+0345, which case-folds to a letter but is not a Python \w.
const FOLDS: Readonly<Record<string, string>> = { i: "İı", k: "K", s: "ſ" };
const SYNTAX = "^$\\.*+?()[]{}|/";

type PyFlag = "I" | "M" | "S";

function caseless(letter: string): string {
  const lower = letter.toLowerCase();
  return lower + lower.toUpperCase() + (FOLDS[lower] ?? "");
}

function isLetter(c: string): boolean {
  return /^[A-Za-z]$/.test(c);
}

function escaped(e: string, inClass: boolean): string {
  switch (e) {
    case "b":
      return inClass ? "\\x08" : BOUNDARY;
    case "w":
      return inClass ? WORD : `[${WORD}]`;
    case "d":
      return inClass ? DIGIT : `[${DIGIT}]`;
    case "s":
      return inClass ? SPACE : `[${SPACE}]`;
    case "Z":
      if (inClass) break;
      return "$";
    case "n":
    case "t":
    case "r":
      return "\\" + e;
    default:
      if (SYNTAX.includes(e) || (inClass && e === "-")) return "\\" + e;
      if (!/[A-Za-z0-9]/.test(e)) return e;
  }
  throw new Error(`unsupported escape \\${e}`);
}

/**
 * Compiles a Python `re` pattern with Python's str semantics into a JavaScript RegExp. Covers the syntax
 * claims.py uses and throws on anything else, so a pattern is never silently given a different meaning.
 */
function py(source: string, ...flags: PyFlag[]): RegExp {
  const ignoreCase = flags.includes("I");
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    if (c === "\\") {
      out += escaped(source.charAt(++i), inClass);
    } else if (inClass) {
      if (c === "]") {
        inClass = false;
        out += c;
      } else if (ignoreCase && isLetter(c) && source.charAt(i + 1) === "-" && isLetter(source.charAt(i + 2))) {
        const end = source.charAt(i + 2);
        let folds = "";
        for (let code = c.toLowerCase().charCodeAt(0); code <= end.toLowerCase().charCodeAt(0); code++) {
          folds += FOLDS[String.fromCharCode(code)] ?? "";
        }
        out += `${c.toLowerCase()}-${end.toLowerCase()}${c.toUpperCase()}-${end.toUpperCase()}${folds}`;
        i += 2;
      } else {
        out += ignoreCase && isLetter(c) ? caseless(c) : c;
      }
    } else if (c === "[") {
      inClass = true;
      out += c;
      if (source.charAt(i + 1) === "^") out += source.charAt(++i);
      if (source.charAt(i + 1) === "]") throw new Error("unsupported leading ] in a class");
    } else if (c === "(" && source.charAt(i + 1) === "?") {
      const group = /^\(\?(?::|=|!|<=|<!)/.exec(source.slice(i));
      if (!group) throw new Error(`unsupported group ${source.slice(i, i + 4)}`);
      out += group[0];
      i += group[0].length - 1;
    } else if (c === ".") {
      out += flags.includes("S") ? "[\\s\\S]" : "[^\\n]";
    } else if (c === "^") {
      out += flags.includes("M") ? "(?:^|(?<=\\n))" : "^";
    } else if (c === "$") {
      out += flags.includes("M") ? "(?=\\n|$)" : "(?=\\n?$)";
    } else {
      out += ignoreCase && isLetter(c) ? `[${caseless(c)}]` : c;
    }
  }
  return new RegExp(out, "u");
}

/** A copy that `matchAll` and `replace` walk through the whole string. */
function every(rx: RegExp): RegExp {
  return new RegExp(rx.source, "gu");
}

const FENCE = every(py(String.raw`\`\`\`.*?(?:\`\`\`|\Z)`, "S"));
const QUOTE = every(py(String.raw`^\s*>.*$`, "M"));
const SPLIT = every(py(String.raw`(?<=[.!?])\s+(?=[A-Z\`*\"(\[])|\n+`));
const MARKUP = every(py(String.raw`^\s*(?:[-*+]|\d+[.)]|#+)\s+|\*\*|__`));
const EDGES = /^[ |\t]+|[ |\t]+$/gu;
const QUESTION = py(String.raw`\?\s*\Z`);
const UNTICKED = py(String.raw`^\[ \]`);
const FIRST_PERSON = py(String.raw`^\s*I\b`);

const HEDGE = py(
  String.raw`\b(?:will|I'll|you'll|going to|should|would|could|might|may|probably|likely|perhaps|` +
    String.raw`maybe|plan(?:ned)? to|need(?:s|ed)? to|want(?:s|ed)? to|next step|todo|to do|` +
    String.raw`if|unless|once|when you|let me|can you|you can|try|hopefully|expect(?:ed)?|` +
    String.raw`in case|whether|needs?|pending|remaining|left to|propose[sd]?|suggest(?:s|ed)?|recommend(?:s|ed)?|consider|option)\b`,
  "I",
);
const NEGATION = py(
  String.raw`\b(?:not|never|no longer|unverified|untested|unable|cannot|nothing (?:was|has been))\b|n't\b|` +
    String.raw`\bwithout (?:running|testing|verifying|checking)\b`,
  "I",
);
const REPORTED = py(
  String.raw`\b(?:the (?:lane|subagent|agent|worker|report|readme|docs?|issue|user|ticket|log)|you|they|he|she)` +
    String.raw`\s+(?:says?|said|claims?|claimed|reports?|reported|mentioned|noted|wrote)\b`,
  "I",
);

const OK_WORDS = String.raw`pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|clean(?:ly)?|OK|all good`;
const OK = `(?:${OK_WORDS})`;

/** claims.py's family: at most one claim per group per sentence. `FAMILY` maps a kind to the rubric. */
type Group = "test" | "typecheck" | "lint" | "build" | "git" | "ship" | "work";

interface Rule {
  readonly group: Group;
  readonly kind: Kind;
  readonly pattern: RegExp;
  /** "the format changed" is not a claim about the agent's own edit; "I changed" or "changed `a.py`" is. */
  readonly requires: "nothing" | "a named file or I";
}

/** Order within a group is priority. */
const RULES: readonly Rule[] = [
  {
    group: "test",
    kind: "test_pass",
    requires: "nothing",
    pattern: py(
      String.raw`\b(?:tests?|test suite|suites?|specs?|pytest|vitest|jest|unittest|cargo test|go test|` +
        String.raw`tests\.R|e2e|smoke tests?)\b[^.;]{0,60}?\b` +
        OK +
        String.raw`\b|` +
        String.raw`\b\d+\s*/\s*\d+\s+(?:\w+\s+)?(?:tests?\s+|checks?\s+)?pass|\b\d+\s+(?:\w+\s+)?(?:tests?\s+)?passed\b|` +
        String.raw`\ball\s+(?:\d+\s+)?(?:\w+\s+)?(?:tests?|checks|assertions)\s+(?:now\s+)?pass`,
      "I",
    ),
  },
  {
    group: "typecheck",
    kind: "typecheck_pass",
    requires: "nothing",
    pattern: py(
      String.raw`\b(?:typechecks?|typechecking|type-?check(?:s|ing)?|tsc|mypy|pyright|types)\b[^.;]{0,30}?` +
        String.raw`\b(?:` +
        OK_WORDS +
        String.raw`|no (?:type )?errors|0 errors)\b|\bno type errors\b`,
      "I",
    ),
  },
  {
    group: "lint",
    kind: "lint_pass",
    requires: "nothing",
    pattern: py(
      String.raw`\b(?:lint(?:s|er|ing)?|eslint|ruff|clippy|flake8|shellcheck|swiftlint)\b[^.;]{0,30}?` +
        String.raw`\b(?:` +
        OK_WORDS +
        String.raw`|no (?:errors|warnings|issues)|0 (?:errors|warnings))\b`,
      "I",
    ),
  },
  {
    group: "build",
    kind: "build_pass",
    requires: "nothing",
    pattern: py(
      String.raw`\b(?:build|builds|built|compiles?|compiled|compilation)\b[^.;]{0,40}?` +
        String.raw`\b(?:` +
        OK_WORDS +
        String.raw`|success(?:fully)?|without (?:errors|warnings)|fine)\b|` +
        String.raw`\b(?:it|everything|the (?:app|project|site|package|binary|paper|pdf)) (?:now )?(?:builds|compiles)\b`,
      "I",
    ),
  },
  {
    group: "git",
    kind: "pr",
    requires: "nothing",
    pattern: py(
      String.raw`\b(?:opened|created|filed|raised|merged)\s+(?:a\s+|the\s+|draft\s+)*(?:PR|pull request)\b|` +
        String.raw`\bPR\s+#?\d+\s+(?:is\s+)?(?:open|up|opened|created|merged)\b`,
      "I",
    ),
  },
  {
    group: "git",
    kind: "push",
    requires: "nothing",
    pattern: py(String.raw`\bpushed\b|\bpush(?:ed)? to (?:origin|main|master|remote)\b`, "I"),
  },
  {
    group: "git",
    kind: "commit",
    requires: "nothing",
    pattern: py(
      String.raw`\bcommitted\b|\bcommit(?:ted)? (?:as|in)\b|\bin commit\b|\bnew commit\b|` +
        String.raw`\bcommit\s+\`?[0-9a-f]{7,40}\b|\b(?:landed|lands) (?:in|as)\b`,
      "I",
    ),
  },
  {
    group: "ship",
    kind: "deployed",
    requires: "nothing",
    pattern: py(String.raw`\b(?:deployed|is (?:now )?live|went live|published)\b`, "I"),
  },
  {
    group: "ship",
    kind: "installed",
    requires: "nothing",
    pattern: py(
      String.raw`(?<!the )(?<!an )(?<!a )\b(?:installed|reinstalled)\b(?!\s+(?:version|copy|engine|base|build|binary|app|cli|command)\b)`,
      "I",
    ),
  },
  {
    group: "work",
    kind: "works",
    requires: "nothing",
    pattern: py(
      String.raw`\b(?:now works|works now|works (?:correctly|as expected|end[- ]to[- ]end)|is working|are working|` +
        String.raw`(?:it|this|that|everything|all of (?:it|them)) works|` +
        String.raw`(?:is|are|was|were|now|has been|have been|got) (?:fixed|resolved)|` +
        String.raw`\bI (?:fixed|resolved)\b|^(?:Fixed|Resolved)\b|\((?:fixed|resolved)\)|(?:fixed|resolved):)`,
      "I",
    ),
  },
  {
    group: "work",
    kind: "verified",
    requires: "nothing",
    pattern: py(
      String.raw`\b(?:verified|confirmed|double-checked|validated|smoke-tested|sanity-checked|tested)\b`,
      "I",
    ),
  },
  {
    group: "work",
    kind: "ran",
    requires: "nothing",
    pattern: py(
      String.raw`\bI\s+(?:just\s+|also\s+|then\s+|first\s+)?(?:ran|re-?ran|executed|invoked)\b|` +
        String.raw`^(?:Ran|Re-?ran|Executed)\b`,
      "I",
    ),
  },
  {
    group: "work",
    kind: "file_change",
    requires: "a named file or I",
    pattern: py(
      String.raw`\b(?:updated|edited|modified|changed|created|added|wrote|rewrote|removed|deleted|renamed|` +
        String.raw`moved|refactored|replaced|patched)\b`,
      "I",
    ),
  },
];

const FILE_EXT =
  String.raw`(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|rs|go|swift|java|kt|rb|php|c|h|cc|cpp|hpp|m|cs|r|R|sql|sh|` +
  String.raw`css|scss|html|vue|svelte|astro|json|toml|yaml|yml|md|mdx|txt|tex|bib|ipynb|lock|cfg|ini|env|xml|plist)`;
const FILE = every(
  py(
    String.raw`\`([^\`\s]+?\.` +
      FILE_EXT +
      String.raw`)\`|(?<![\w/.])((?:[\w.~-]+/)*[\w-]+\.` +
      FILE_EXT +
      String.raw`)\b`,
  ),
);
const PATH = every(py(String.raw`\`((?:[\w.~-]+/)+[\w.-]*)\``));
const SHA = py(String.raw`(?<![\w-])([0-9a-f]{7,40})(?![\w-])`);

/** Python's `s[:n]` and `len(s)`, which count code points, not UTF-16 units. */
function codePoints(s: string): string[] {
  return Array.from(s);
}

function sentences(report: string): string[] {
  const text = report.replace(FENCE, " ").replace(QUOTE, " ");
  const pieces: string[] = [];
  let start = 0;
  for (const m of text.matchAll(SPLIT)) {
    pieces.push(text.slice(start, m.index));
    start = m.index + m[0].length;
  }
  pieces.push(text.slice(start));
  return pieces
    .map((raw) => raw.replace(MARKUP, "").replace(EDGES, ""))
    .filter((s) => codePoints(s).length >= 8);
}

function isAssertion(s: string): boolean {
  return ![QUESTION, UNTICKED, HEDGE, NEGATION, REPORTED].some((rx) => rx.test(s));
}

function namedFiles(s: string): string[] {
  const files = Array.from(s.matchAll(FILE), (m) => m[1] ?? m[2] ?? "");
  return files.concat(Array.from(s.matchAll(PATH), (m) => m[1] ?? ""));
}

function namedSha(s: string): string | null {
  const sha = SHA.exec(s)?.[1];
  return sha !== undefined && /[0-9]/.test(sha) ? sha : null;
}

export function extract(report: string): Claim[] {
  const claims: Claim[] = [];
  for (const s of sentences(report)) {
    if (!isAssertion(s)) continue;
    const files = namedFiles(s);
    const seen = new Set<Group>();
    for (const rule of RULES) {
      if (seen.has(rule.group) || !rule.pattern.test(s)) continue;
      if (rule.requires === "a named file or I" && files.length === 0 && !FIRST_PERSON.test(s)) continue;
      seen.add(rule.group);
      claims.push({
        kind: rule.kind,
        text: codePoints(s).slice(0, 400).join(""),
        files,
        sha: rule.group === "git" ? namedSha(s) : null,
      });
    }
  }
  return claims;
}
