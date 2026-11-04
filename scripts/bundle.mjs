// Bundles the Action, the CLI and the App's Worker into dist/ with zod inlined, so none needs an install step.
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
  build({ ...shared, platform: "neutral", target: "es2023", minify: true, entryPoints: ["packages/github/src/bin/worker.ts"], outfile: "dist/worker.js" }),
]);
await chmod("dist/cli.js", 0o755);
