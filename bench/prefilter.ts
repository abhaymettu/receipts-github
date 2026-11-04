/**
 * Compares the TypeScript claim prefilter with receipts' Python one, and scores both against the human labels.
 *
 *   RECEIPTS_SRC=<receipts clone> RECEIPTS_DATA=<labelled data> RECEIPTS_SCRATCH=<private dir> npm run bench:prefilter
 *
 * Reads what bench/prefilter.py wrote to the scratch directory. Writes per-item mismatches there, and only
 * aggregates to bench/results/prefilter.json.
 */
import { createReadStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { extract, FAMILY, type Family, type Kind } from "../packages/checker/src/claims.ts";

const SCRATCH = process.env["RECEIPTS_SCRATCH"];
if (!SCRATCH) throw new Error("set RECEIPTS_SCRATCH to the directory bench/prefilter.py wrote");
const RESULTS = join(import.meta.dirname, "results", "prefilter.json");

const FAMILIES = ["tests", "build", "files", "git", "ship", "ran", "verified", "works"] as const satisfies readonly Family[];

const DEFINITIONS = {
  inputs: {
    labels: "labelled claim spans: gold labels on test-split turns plus rater A labels on dev-split turns",
    reports: "the REPORT section of each sampled turn's dossier",
    sessions: "end-of-turn reports from the frame's non-excluded sessions still on disk, at most 5,000",
    synthetic: "random strings over the patterns' vocabulary and the Unicode hazards, seed 20261104",
    codepoints: "every code point below U+30000 but surrogates, placed in each of 9 probe sentences",
  },
  M1: "share of inputs whose ordered claims {kind, text, files, sha} equal the Python output exactly",
  M2: "share of labelled claims whose span yields at least one claim",
  M3: "share of labelled claims whose family is among the families extracted from the span",
  M4: "M3 count over M2 count",
  M5: "share of distinct (turn, span) pairs whose extracted families equal the labelled families on that span",
  intervals: "Wilson score, 95%",
};

const ClaimLine = z.object({
  kind: z.custom<Kind>((v) => typeof v === "string" && Object.hasOwn(FAMILY, v)),
  text: z.string(),
  files: z.array(z.string()),
  sha: z.string().nullable(),
});
const Input = z.discriminatedUnion("set", [
  z.object({ set: z.literal("labels"), id: z.string(), text: z.string(), turn: z.string(), family: z.enum(FAMILIES) }),
  z.object({ set: z.enum(["reports", "sessions", "synthetic"]), id: z.string(), text: z.string() }),
  z.object({ set: z.literal("codepoints"), id: z.string(), text: z.string(), assigned: z.boolean() }),
]);
const PythonLine = z.object({ set: z.string(), id: z.string(), claims: z.array(ClaimLine) });
const Meta = z.object({ python: z.string(), unicode: z.string() });

type Input = z.infer<typeof Input>;
type ClaimLine = z.infer<typeof ClaimLine>;
type Labelled = Extract<Input, { set: "labels" }>;

async function* lines(file: string): AsyncGenerator<unknown> {
  for await (const line of createInterface({ input: createReadStream(join(SCRATCH ?? "", file)) })) {
    yield JSON.parse(line);
  }
}

/** Wilson score interval at 95%. */
function rate(k: number, n: number) {
  const z = 1.959963984540054;
  const p = k / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = ((z / (1 + (z * z) / n)) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n)));
  const round = (x: number) => Math.round(x * 10000) / 10000;
  return { k, n, rate: round(p), ci95: [round(centre - half), round(centre + half)] };
}

function families(claims: readonly ClaimLine[]): Set<Family> {
  return new Set(claims.map((c) => FAMILY[c.kind]));
}

/** M2 to M5, the preregistered agreement measures, for one prefilter's output on the labelled spans. */
function agreement(labels: readonly Labelled[], found: ReadonlyMap<string, Set<Family>>) {
  const perFamily = Object.fromEntries(FAMILIES.map((f) => [f, { labelled: 0, detected: 0, agreed: 0 }]));
  const spans = new Map<string, { found: Set<Family>; labelled: Set<Family> }>();
  let detected = 0;
  let agreed = 0;
  for (const l of labels) {
    const f = found.get(l.id) ?? new Set<Family>();
    const counts = perFamily[l.family];
    if (!counts) throw new Error(`unknown family ${l.family}`);
    counts.labelled++;
    if (f.size > 0) {
      detected++;
      counts.detected++;
    }
    if (f.has(l.family)) {
      agreed++;
      counts.agreed++;
    }
    const key = JSON.stringify([l.turn, l.text]);
    const span = spans.get(key) ?? { found: f, labelled: new Set<Family>() };
    span.labelled.add(l.family);
    spans.set(key, span);
  }
  const exact = [...spans.values()].filter(
    (s) => s.found.size === s.labelled.size && [...s.found].every((f) => s.labelled.has(f)),
  ).length;
  return {
    M2_detection: rate(detected, labels.length),
    M3_category_agreement: rate(agreed, labels.length),
    M4_conditional_category_agreement: rate(agreed, detected),
    M5_exact_span_agreement: rate(exact, spans.size),
    per_family: perFamily,
  };
}

async function main() {
  const python = new Map<string, ClaimLine[]>();
  for await (const raw of lines("python.jsonl")) {
    const line = PythonLine.parse(raw);
    python.set(`${line.set}/${line.id}`, line.claims);
  }

  const sets = new Map<string, { n: number; equal: number }>();
  const residual = { unassigned_in_python: 0, other: 0 };
  const labels: Labelled[] = [];
  const found = { typescript: new Map<string, Set<Family>>(), python: new Map<string, Set<Family>>() };
  const mismatches: string[] = [];

  for await (const raw of lines("inputs.jsonl")) {
    const input = Input.parse(raw);
    const ours = extract(input.text).map(({ kind, text, files, sha }) => ({ kind, text, files: [...files], sha }));
    const theirs = python.get(`${input.set}/${input.id}`);
    if (!theirs) throw new Error(`no python output for ${input.set}/${input.id}`);
    const tally = sets.get(input.set) ?? { n: 0, equal: 0 };
    tally.n++;
    if (JSON.stringify(ours) === JSON.stringify(theirs)) {
      tally.equal++;
    } else {
      mismatches.push(JSON.stringify({ set: input.set, id: input.id, text: input.text, typescript: ours, python: theirs }));
      if (input.set === "codepoints" && !input.assigned) residual.unassigned_in_python++;
      else residual.other++;
    }
    sets.set(input.set, tally);
    if (input.set === "labels") {
      labels.push(input);
      found.typescript.set(input.id, families(ours));
      found.python.set(input.id, families(theirs));
    }
  }

  writeFileSync(join(SCRATCH ?? "", "mismatches.jsonl"), mismatches.map((m) => m + "\n").join(""));
  const meta = Meta.parse(JSON.parse(readFileSync(join(SCRATCH ?? "", "python-meta.json"), "utf8")));
  const results = {
    definitions: DEFINITIONS,
    runtimes: { node: process.version, node_unicode: process.versions.unicode, ...meta },
    M1_identical_output: Object.fromEntries([...sets].map(([set, t]) => [set, rate(t.equal, t.n)])),
    M1_residual: residual,
    agreement: { typescript: agreement(labels, found.typescript), python: agreement(labels, found.python) },
  };
  mkdirSync(join(import.meta.dirname, "results"), { recursive: true });
  writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");
  for (const [set, t] of sets) console.log(`M1 ${set}: ${t.equal}/${t.n}`);
  console.log(`residual: ${JSON.stringify(residual)}; ${mismatches.length} mismatches in ${SCRATCH}/mismatches.jsonl`);
}

await main();
