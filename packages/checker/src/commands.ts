/**
 * Which checks run tests, builds, linters, type checkers or deploys.
 *
 * A check counts when its name says so or when its Actions log shows it ran such a command. The command
 * patterns are receipts' rules.py (TEST, BUILD, LINT, TYPECHECK, DEPLOY), with package-manager flags
 * allowed before the script name (`pnpm -r test`).
 */

export const GATES = ["tests", "build", "typecheck", "lint", "deploy"] as const;

export type Gate = (typeof GATES)[number];

const PM = String.raw`(?:npm|pnpm|yarn|bun|deno)\s+(?:-\S+\s+)*(?:run\s+)?`;

export const COMMAND: Readonly<Record<Gate, RegExp>> = {
  tests: new RegExp(
    String.raw`\b(?:pytest|py\.test|unittest|nosetests|tox|nox|vitest|jest|mocha|ava|playwright test|` +
      String.raw`cypress run|rspec|phpunit|ctest|bats|` +
      PM + String.raw`test(?::\S+)?|` +
      String.raw`(?:cargo|go|swift|dotnet|mix|zig|gradle|gradlew|mvn|sbt|stack|cabal)\s+test|` +
      String.raw`xcodebuild\b[^|;&]*\btest\b|make\s+(?:test|check)\w*|` +
      String.raw`(?:Rscript|R\s+-e|python3?|node|bash|sh|uv run|poetry run)\s+[^|;&]*\btests?[\w./-]*|` +
      String.raw`\btest_[\w./-]*\.py|[\w./-]*_test\.\w+|run_tests?\b|\bverify(?:\.sh|\.py)?\b)`,
    "i",
  ),
  build: new RegExp(
    String.raw`\b(?:` + PM + String.raw`(?:build|compile)\b|` +
      String.raw`(?:cargo|go|swift|dotnet|zig|stack|cabal)\s+build|cargo\s+check|xcodebuild|` +
      String.raw`tsc\b|vite\s+build|next\s+build|webpack|esbuild|rollup|` +
      String.raw`gradle\w*\s+\w*(?:build|assemble)|mvn\s+\w*(?:package|compile|install)|` +
      String.raw`make\b(?!\s+(?:test|check|clean))|cmake\s+--build|ninja\b|bazel\s+build|` +
      String.raw`python3?\s+-m\s+(?:py_compile|compileall|build)|pip\s+install\s+-e|` +
      String.raw`tectonic|latexmk|pdflatex|xelatex|hugo\b|jekyll\s+build|astro\s+build)`,
    "i",
  ),
  lint: new RegExp(
    String.raw`\b(?:eslint|ruff|flake8|pylint|black\s+--check|prettier\s+--check|clippy|golangci-lint|` +
      String.raw`swiftlint|shellcheck|` + PM + String.raw`lint|biome\s+(?:check|lint)|stylelint)\b`,
    "i",
  ),
  typecheck: new RegExp(
    String.raw`\b(?:tsc\b|mypy|pyright|basedpyright|` + PM + String.raw`(?:typecheck|type-check|check-types|tsc)|` +
      String.raw`cargo\s+check|flow\s+check|vue-tsc|svelte-check)\b`,
    "i",
  ),
  deploy: new RegExp(
    String.raw`\b(?:vercel|netlify|wrangler|fly\s+deploy|flyctl|firebase\s+deploy|heroku|railway\s+up|` +
      String.raw`npm\s+publish|twine\s+upload|gh\s+release|kubectl\s+apply|terraform\s+apply|` +
      String.raw`docker\s+push|gh-pages|deploy\S*)\b`,
    "i",
  ),
};

export const NAME: Readonly<Record<Gate, RegExp>> = {
  tests: /\b(?:tests?|specs?|unit|integration|e2e|pytest|jest|vitest|mocha|rspec|ctest)\b/i,
  build: /\b(?:build|builds|compile|bundle)\b/i,
  typecheck: /\b(?:typecheck|type-check|types|tsc|mypy|pyright)\b/i,
  lint: /\b(?:lint|linter|eslint|ruff|clippy|flake8|prettier|format|biome|golangci-lint|shellcheck)\b/i,
  deploy: /\b(?:deploy|deployment|vercel|netlify|cloudflare pages|preview|release|publish)\b/i,
};
