// Bundles the Action and the CLI into dist/ with zod inlined, so neither needs an install step.
import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  conditions: ["source"],
  legalComments: "none",
  logLevel: "warning",
};

await Promise.all([
  build({ ...shared, entryPoints: ["packages/github/src/bin/action.ts"], outfile: "dist/action.js" }),
  build({ ...shared, entryPoints: ["packages/github/src/bin/cli.ts"], outfile: "dist/cli.js" }),
]);
await chmod("dist/cli.js", 0o755);
