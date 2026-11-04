# Fixtures

Real public pull requests written by coding agents, recorded once in `RawReceipts` shape (see `packages/checker/src/receipts.ts`).
Each file holds the pull request, its files and commits (without patches, repository objects or user profiles), the check runs and statuses of the head commit and up to 20 recent commits, and the `##[group]Run` lines of up to 30 Actions job logs.

Regenerate with `node --conditions=source scripts/fetch-fixtures.ts` (this README is written from the same list). The pull requests keep changing on GitHub, so a fresh fetch can change verdicts.

| Fixture | Pull request | Agent | What it exercises |
|---|---|---|---|
| [`hyperledger__fabric-x-orderer__1413.json`](hyperledger__fabric-x-orderer__1413.json) | https://github.com/hyperledger/fabric-x-orderer/pull/1413 | Claude Code | Plainly passing CI on the head commit; claims `make unit-tests-batcher` passes and names `docs/batcher.md`. |
| [`dorogoy__zipline-mcp__299.json`](dorogoy__zipline-mcp__299.json) | https://github.com/dorogoy/zipline-mcp/pull/299 | Jules | Plainly passing CI; claims tests, lint and build pass, so the claimed commands can be matched to the Actions logs. |
| [`kody-hq__kody__4840.json`](kody-hq__kody__4840.json) | https://github.com/kody-hq/kody/pull/4840 | Devin | Passing CI; the body names five specific files and claims typecheck and related tests pass. |
| [`databricks__unity-gateway__1338.json`](databricks__unity-gateway__1338.json) | https://github.com/databricks/unity-gateway/pull/1338 | OpenAI Codex | Several failing check runs on the head commit; claims `just lint` passes. |
| [`LayerNorm__overlay-web__390.json`](LayerNorm__overlay-web__390.json) | https://github.com/LayerNorm/overlay-web/pull/390 | Devin | A failing check on the head commit beside claims that build, tests and typecheck passed on the current head. |
| [`can1357__oh-my-pi__15391.json`](can1357__oh-my-pi__15391.json) | https://github.com/can1357/oh-my-pi/pull/15391 | OpenAI Codex | No check runs or statuses on any commit, while the body claims `bun check` and named test suites pass. |
| [`Open-MBEE__OpenSysML__1908.json`](Open-MBEE__OpenSysML__1908.json) | https://github.com/Open-MBEE/OpenSysML/pull/1908 | Devin | Checks ran only on the older commit (cancelled when the head was pushed), none on the head; claims `make test` and `make lint` pass and names files. |
| [`kzarzycki__dotagents__88.json`](kzarzycki__dotagents__88.json) | https://github.com/kzarzycki/dotagents/pull/88 | Claude Code | A commit-sha claim: `mise run check` at `a249731` passed all 10 checks, and `a249731` is not one of the PR's commits. |
| [`ricadoHuang__BMItest__12.json`](ricadoHuang__BMItest__12.json) | https://github.com/ricadoHuang/BMItest/pull/12 | Copilot coding agent | The body names specific files (`bmi_logic.py`, `app.py`, a deploy workflow); passing checks on the head. |
| [`YOKEN21__grok-bot-cursor__20.json`](YOKEN21__grok-bot-cursor__20.json) | https://github.com/YOKEN21/grok-bot-cursor/pull/20 | Cursor background agent | Claims `npm ci` and `npm run check` pass with a test count, and names the config file it changed. |
