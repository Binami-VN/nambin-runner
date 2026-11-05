# NAMBIN Ops runner

Worker for [NAMBIN Ops](https://nambin.com): takes code tasks (fix, review, dependency update,
security scan) from an Ops server, works in a git worktree, runs the project's checks and sends
the diff back for review. Nothing is merged until a person approves it on Ops.

Coding agents: [OpenCode](https://opencode.ai) on any OpenAI-compatible API, and/or the Cursor SDK.

## Run it

- **On your machine**: `cp runner.config.example.json runner.config.json`, fill `.env` (see
  `.env.example`), then `node src/runner.mjs ping` and `node src/runner.mjs`.
- **On GitHub Actions** (`.github/workflows/run.yml`): set two repository secrets, `RUNNER_ENV`
  (dotenv, see `.env.example` plus `GIT_PUSH_TOKEN` and `OPS_REPOS="name=owner/repo …"`) and
  `RUNNER_CONFIG` (`runner.config.json`).

## Security model (GitHub Actions)

- The run page shows only "succeeded" / "failed". Logs go to Ops with every secret value redacted.
- All configuration is in secrets; nothing in repository variables (those are printed).
- `permissions: {}`, actions pinned by commit, no `pull_request` triggers, never runs in forks.
- The runner process holds the tokens and only runs `git`/`gh` (hooks off, git dir pinned).
  Agents, installs and checks run as a separate user without sudo, which cannot read the
  runner's environment, memory or home. The GitHub token reaches git through its environment.
- Agents may not touch `.github/`, `.env*`, keys; such diffs are refused.

## Tests

`npm test`
