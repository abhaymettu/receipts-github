import { describe, expect, it } from "vitest";
import { extract, type Claim, type Kind } from "../src/claims.ts";

function claim(kind: Kind, text: string, files: string[] = [], sha: string | null = null): Claim {
  return { kind, text, files, sha };
}

describe("ported from receipts' test_receipts.py", () => {
  it.each([
    "I'll run the tests next.",
    "Tests should pass now.",
    "I did not run the tests.",
    "Do the tests pass?",
    "[ ] Tests pass",
    "The user says tests pass.",
  ])("does not extract a non-claim: %s", (text) => {
    expect(extract(text)).toEqual([]);
  });

  it.each<[string, Kind]>([
    ["All 12 tests pass.", "test_pass"],
    ["[x] Tests pass", "test_pass"],
    ["The build succeeds.", "build_pass"],
    ["Committed as `a41c9e2`.", "commit"],
    ["Pushed to origin.", "push"],
    ["I updated `config.py`.", "file_change"],
    ["The bug is fixed.", "works"],
    ["I verified the endpoint returns 200.", "verified"],
  ])("extracts %s as %s", (text, kind) => {
    expect(extract(text).map((c) => c.kind)).toEqual([kind]);
  });

  it("returns the sentence, named files and sha of each claim", () => {
    expect(extract("Committed as `a41c9e2`.")).toEqual([claim("commit", "Committed as `a41c9e2`.", [], "a41c9e2")]);
    expect(extract("I updated `config.py`.")).toEqual([claim("file_change", "I updated `config.py`.", ["config.py"])]);
  });
});

describe("each kind", () => {
  it.each<[string, Claim[]]>([
    ["tsc: 0 errors.", [claim("typecheck_pass", "tsc: 0 errors.")]],
    ["ruff is clean.", [claim("lint_pass", "ruff is clean.")]],
    ["Opened a PR for the fix.", [claim("pr", "Opened a PR for the fix.")]],
    ["Pushed `src/` to origin.", [claim("push", "Pushed `src/` to origin.", ["src/"])]],
    ["The site is now live.", [claim("deployed", "The site is now live.")]],
    ["Installed the hook.", [claim("installed", "Installed the hook.")]],
    ["The installed version is old.", []],
    ["I ran the migration script.", [claim("ran", "I ran the migration script.")]],
    [
      "Updated `config.py` with the new port.",
      [claim("file_change", "Updated `config.py` with the new port.", ["config.py"])],
    ],
    ["The format changed in March.", []],
  ])("%s", (text, claims) => {
    expect(extract(text)).toEqual(claims);
  });

  it("keeps one claim per group, in table order", () => {
    expect(extract("I fixed the parser and verified it.")).toEqual([
      claim("works", "I fixed the parser and verified it."),
    ]);
    const text = "Fixed it and pushed, all tests pass.";
    expect(extract(text)).toEqual([claim("test_pass", text), claim("push", text), claim("works", text)]);
  });
});

describe("where Python and JavaScript regexes differ", () => {
  it("treats non-ASCII letters as word characters for \\b and \\w", () => {
    expect(extract("The tests passé here.")).toEqual([]);
    expect(extract("I edited café.py today.")).toEqual([claim("file_change", "I edited café.py today.", ["café.py"])]);
  });

  it("treats non-ASCII decimal digits as \\d", () => {
    expect(extract("٣ tests passed here.")).toEqual([claim("test_pass", "٣ tests passed here.")]);
  });

  it("uses Python's whitespace set, which has U+001C and U+0085 but not U+FEFF", () => {
    expect(extract("All\x1ctests pass here.")).toEqual([claim("test_pass", "All\x1ctests pass here.")]);
    expect(extract("Do the tests pass?\x85")).toEqual([]);
    expect(extract("Do the tests pass?﻿")).toEqual([claim("test_pass", "Do the tests pass?﻿")]);
  });

  it("matches ASCII letters case-insensitively the way re.IGNORECASE does", () => {
    expect(extract("The bug is fıxed here.")).toEqual([claim("works", "The bug is fıxed here.")]);
    expect(extract("Puſhed the branch.")).toEqual([claim("push", "Puſhed the branch.")]);
    expect(extract("It now worKs here.")).toEqual([claim("works", "It now worKs here.")]);
  });

  it("runs an unclosed fence to the end of the text, as \\Z does", () => {
    expect(extract("All tests pass.\n```\nI pushed to origin.")).toEqual([claim("test_pass", "All tests pass.")]);
  });

  it("breaks lines only at \\n, for ^, $ and .", () => {
    expect(extract("Done here\r> Tests pass now.")).toEqual([claim("test_pass", "Done here\r> Tests pass now.")]);
    expect(extract("Done.\n> quoted\rAll tests pass now.")).toEqual([]);
  });

  it("splits sentences only before a capital, backtick, asterisk, quote or bracket", () => {
    expect(extract("Tests pass. build is fine.")).toEqual([
      claim("test_pass", "Tests pass. build is fine."),
      claim("build_pass", "Tests pass. build is fine."),
    ]);
    expect(extract("Tests pass. Build is fine.")).toEqual([
      claim("test_pass", "Tests pass."),
      claim("build_pass", "Build is fine."),
    ]);
  });

  it("counts the 8-character minimum in code points", () => {
    expect(extract("Ran 😀😀😀")).toEqual([]);
    expect(extract("Ran 😀😀😀😀")).toEqual([claim("ran", "Ran 😀😀😀😀")]);
  });

  it("cuts the text at 400 code points", () => {
    expect(extract("I pushed " + "😀".repeat(500))).toEqual([claim("push", "I pushed " + "😀".repeat(391))]);
  });

  it("strips only spaces, pipes and tabs from the ends", () => {
    expect(extract("| All tests pass |")).toEqual([claim("test_pass", "All tests pass")]);
    expect(extract(" All tests pass")).toEqual([claim("test_pass", " All tests pass")]);
  });

  it("reads a file change without a named file only from a sentence that starts with a capital I", () => {
    expect(extract("I updated the parser.")).toEqual([claim("file_change", "I updated the parser.")]);
    expect(extract("Then I updated the parser.")).toEqual([]);
    expect(extract("i updated the parser.")).toEqual([]);
  });

  it("finds every file and sha on every call, with no state left between matches", () => {
    const text = "Committed as a41c9e2.\nCommitted as b52d0f3.";
    const expected = [
      claim("commit", "Committed as a41c9e2.", [], "a41c9e2"),
      claim("commit", "Committed as b52d0f3.", [], "b52d0f3"),
    ];
    expect(extract(text)).toEqual(expected);
    expect(extract(text)).toEqual(expected);
    expect(extract("I updated `a.py` and `b.py`.")).toEqual([
      claim("file_change", "I updated `a.py` and `b.py`.", ["a.py", "b.py"]),
    ]);
  });

  it("takes only the first sha-shaped word, and only if it has a digit", () => {
    expect(extract("Committed deadbeef and 1234567.")).toEqual([claim("commit", "Committed deadbeef and 1234567.")]);
    expect(extract("Committed as A41C9E2.")).toEqual([claim("commit", "Committed as A41C9E2.")]);
  });
});
