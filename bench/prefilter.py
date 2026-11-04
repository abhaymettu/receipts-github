"""Runs receipts' Python claim prefilter over the fidelity inputs, for bench/prefilter.ts to compare against.

  RECEIPTS_SRC=<receipts clone> RECEIPTS_DATA=<labelled data> RECEIPTS_SCRATCH=<private dir> npm run bench:prefilter

Writes <scratch>/inputs.jsonl ({set, id, text, ...}) and <scratch>/python.jsonl ({set, id, claims}). Both hold
private text, so the scratch directory must sit outside the repository.
"""

import json
import os
import random
import sys
import unicodedata

SRC, DATA, SCRATCH = (os.environ[k] for k in ("RECEIPTS_SRC", "RECEIPTS_DATA", "RECEIPTS_SCRATCH"))
sys.path.insert(0, SRC)
from receipts.claims import extract  # noqa: E402
from receipts.session import load  # noqa: E402

LABEL = os.path.join(DATA, "label")
VERDICTS = ("supported", "unbacked", "contradicted")
MAX_SESSION_REPORTS = 5000
REPORT_HEAD = "\nREPORT\n" + "=" * 20 + "\n"
RECEIPTS_HEAD = "\n\nRECEIPTS\n" + "=" * 20 + "\n"


def labelled():
    """Gold labels on test-split turns plus rater A labels on dev-split turns, cleaned as bench/score.py does."""
    for line in open(os.path.join(LABEL, "sample.jsonl")):
        row = json.loads(line)
        rater = "gold" if row["split"] == "test" else "A"
        labels = json.load(open(os.path.join(LABEL, "rater_" + rater, row["id"] + ".json")))["labels"]
        for j, g in enumerate(labels or []):
            if isinstance(g, dict) and g.get("span") and g.get("verdict") in VERDICTS:
                yield {"set": "labels", "id": "%s:%d" % (row["id"], j), "turn": row["id"],
                       "family": g.get("family", ""), "text": g["span"]}


def reports():
    for name in sorted(os.listdir(os.path.join(LABEL, "dossiers"))):
        text = open(os.path.join(LABEL, "dossiers", name)).read()
        start = text.index(REPORT_HEAD) + len(REPORT_HEAD)
        yield {"set": "reports", "id": name[:-4], "text": text[start:text.index(RECEIPTS_HEAD, start)]}


def session_reports():
    n = 0
    for line in open(os.path.join(DATA, "frame.jsonl")):
        row = json.loads(line)
        if row["excluded"] or not os.path.exists(row["path"]):
            continue
        for t in load(row["path"]).turns:
            if t.report:
                yield {"set": "sessions", "id": "s%05d" % n, "text": t.report}
                n += 1
                if n == MAX_SESSION_REPORTS:
                    return


# Each probe puts one code point where a Python-vs-JavaScript regex difference would change the claims.
PROBES = {
    "word": "I edited a{c}b.py today",
    "space": "All{c}tests pass here",
    "digit": "{c} tests passed here",
    "line": "Done here{c}> Tests pass now.",
    "split": "Tests pass.{c}Build is fine.",
    "fold-i": "The bug is f{c}xed here",
    "fold-s": "Pu{c}hed the branch",
    "fold-k": "It now wor{c}s here",
    "dot": "```{c}tests pass\nAll tests pass here.",
}


def codepoints():
    for cp in range(0x30000):
        if 0xD800 <= cp <= 0xDFFF:
            continue
        c = chr(cp)
        assigned = unicodedata.category(c) != "Cn"
        for probe, template in PROBES.items():
            yield {"set": "codepoints", "id": "%s:%x" % (probe, cp), "assigned": assigned,
                   "text": template.replace("{c}", c)}


VOCAB = ("I", "we", "tests", "test suite", "pass", "passed", "passes", "green", "OK", "all", "12", "3/4", "the",
         "build", "builds", "compiles", "fine", "tsc", "mypy", "no type errors", "lint", "ruff", "0 warnings",
         "opened", "a", "PR", "#12", "pull request", "pushed", "to origin", "committed", "as", "in commit",
         "a41c9e2", "deadbeef", "1234567abc", "deployed", "is live", "installed", "the installed", "version",
         "now works", "it works", "is fixed", "Fixed", "(fixed)", "resolved:", "verified", "confirmed", "ran",
         "Ran", "executed", "updated", "changed", "removed", "`config.py`", "src/app.ts", "`docs/`", "a.R",
         "should", "will", "not", "n't", "never", "if", "you", "the user says", "says", "?", "[ ]", "[x]",
         "- ", "* ", "1. ", "## ", "**", "__", "|", "> ", "```", "\n", "\n\n", ". ", "! ", "; ", ".", "\t",
         "\r", " ", " ", "\u0085", "\x1c", "﻿", "İ", "ı", "ſ", "K",
         "ͅ", "é", "é", "\U0001F600", "\U0001D7CE", "٣", "²", "café.py",
         "über.ts", "\ud800", "x" * 30, "y" * 420)


def synthetic():
    rng = random.Random(20261104)
    for i in range(20000):
        words = [rng.choice(VOCAB) for _ in range(rng.randint(1, 40))]
        yield {"set": "synthetic", "id": "y%05d" % i, "text": "".join(w + rng.choice(("", " ", " ", " ")) for w in words)}


def claims(text):
    return [{"kind": c.kind, "text": c.text, "files": c.files, "sha": c.sha or None} for c in extract(text)]


def main():
    os.makedirs(SCRATCH, exist_ok=True)
    counts = {}
    with open(os.path.join(SCRATCH, "inputs.jsonl"), "w") as inputs, \
            open(os.path.join(SCRATCH, "python.jsonl"), "w") as out:
        for source in (labelled, reports, session_reports, synthetic, codepoints):
            for item in source():
                inputs.write(json.dumps(item) + "\n")
                out.write(json.dumps({"set": item["set"], "id": item["id"], "claims": claims(item["text"])}) + "\n")
                counts[item["set"]] = counts.get(item["set"], 0) + 1
    with open(os.path.join(SCRATCH, "python-meta.json"), "w") as fh:
        json.dump({"python": sys.version.split()[0], "unicode": unicodedata.unidata_version}, fh)
    print("python prefilter:", ", ".join("%s %d" % kv for kv in counts.items()))


if __name__ == "__main__":
    main()
