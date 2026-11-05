#!/usr/bin/env bash
# GitHub Actions entry point (.github/workflows/run.yml). Prints one line: succeeded or failed.
# All other output goes to $OPS/run.log (mode 600) and is sent to Ops, secrets redacted.
#
# Isolation: the runner (this user, holds the tokens) only runs git/gh. Agents, installs and
# project checks run as the unprivileged user `agent` (no sudo, no docker), which cannot read
# the runner's home, files, environment or memory.
set -uo pipefail
umask 077
OPS=/srv/ops
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ME="$(id -un)"

sudo mkdir -p "$OPS" && sudo chown "$ME:" "$OPS" && chmod 711 "$OPS"
LOG="$OPS/run.log"
: >"$LOG"

# Secrets → files only the runner can read; out of the environment of everything that follows.
printf '%s\n' "${RUNNER_ENV:-}" >"$OPS/.env"
printf '%s\n' "${RUNNER_CONFIG:-}" >"$OPS/runner.config.json"
chmod 600 "$OPS/.env" "$OPS/runner.config.json"
missing=$([ -n "${RUNNER_ENV:-}" ] && [ -n "${RUNNER_CONFIG:-}" ] || echo 1)
unset RUNNER_ENV RUNNER_CONFIG

# One value of the .env file, without running it through the shell (values may contain spaces).
envval() {
  local v
  v="$(grep -m1 "^$1=" "$OPS/.env" | cut -d= -f2-)" || true
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

setup() {
  set -e
  [ -z "$missing" ] || { echo "Thiếu secret RUNNER_ENV / RUNNER_CONFIG"; return 1; }
  local GIT_PUSH_TOKEN OPS_REPOS OPENCODE_BIN OPS_GIT_BASE
  GIT_PUSH_TOKEN="$(envval GIT_PUSH_TOKEN)"
  OPS_REPOS="$(envval OPS_REPOS | tr ',' ' ')"
  OPENCODE_BIN="$(envval OPENCODE_BIN)"
  OPS_GIT_BASE="$(envval OPS_GIT_BASE)"
  [ -n "$OPS_REPOS" ] || { echo "Thiếu OPS_REPOS"; return 1; }

  # Sandbox user. Home of the CI user (checkout, _temp files, runner diag logs) closed to others.
  command -v setfacl >/dev/null || sudo apt-get install -y -qq acl
  id agent >/dev/null 2>&1 || sudo useradd --create-home --home-dir "$OPS/agent-home" --shell /bin/bash agent
  sudo chmod 700 "$OPS/agent-home"
  # The runner hands the agent its environment as `sudo -u agent env -i NAME=value… cmd`: check it.
  [ "$(sudo -n -u agent -- /usr/bin/env -i X_OPS_PROBE=1 /usr/bin/env 2>&1)" = "X_OPS_PROBE=1" ] || { echo "sudo -u agent không chạy được"; return 1; }
  sudo chmod 700 "$HOME"
  # Tools the agent needs, outside the closed home.
  sudo install -m 755 "$(command -v bun)" /usr/local/bin/bun
  sudo ln -sf /usr/local/bin/bun /usr/local/bin/bunx

  # Runner code where the agent can read it (the Cursor worker runs as agent); no secrets in it.
  mkdir -p "$OPS/runner"
  cp -R "$HERE/src" "$HERE/package.json" "$OPS/runner/"
  (cd "$OPS/runner" && npm install --no-audit --no-fund --omit=dev)
  [ -n "${OPENCODE_BIN:-}" ] || npm install -g --no-audit --no-fund opencode-ai@1.19.5
  chmod -R go+rX "$OPS/runner"

  # Repos: OPS_REPOS="api=Owner/repo web=Owner/repo"; token only in git's environment.
  local basic
  basic="$(printf 'x-access-token:%s' "$GIT_PUSH_TOKEN" | base64 -w0)"
  mkdir -p "$OPS/repos"
  for pair in $OPS_REPOS; do
    echo "repo ${pair%%=*}"
    name="${pair%%=*}"; repo="${pair#*=}"
    [[ "$name" =~ ^[A-Za-z0-9._-]+$ && "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "OPS_REPOS sai: $pair"; return 1; }
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $basic" \
      git clone -q --filter=blob:none "${OPS_GIT_BASE:-https://github.com}/$repo.git" "$OPS/repos/$name"
    git -C "$OPS/repos/$name" config user.name "NAMBIN Ops Agent"
    git -C "$OPS/repos/$name" config user.email "ops-agent@nambin.com"
  done
  unset basic
  # The agent may read the repos (git status inside a worktree), never write them.
  chmod 711 "$OPS/repos"
  setfacl -R -m u:agent:rX "$OPS/repos"
  mkdir -p "$OPS/wt"
}

code=0
if ! (setup) >>"$LOG" 2>&1; then
  code=2
else
  # The runner reads $OPS/.env itself (next to its config).
  (cd "$OPS/runner" && RUNNER_SANDBOX_USER=agent RUNNER_SANDBOX_HOME="$OPS/agent-home" node src/runner.mjs --once --config "$OPS/runner.config.json") >>"$LOG" 2>&1 || code=$?
fi

# Report to Ops (redacts every value of .env first). Nothing of it reaches this page.
(cd "$HERE" && node src/report.mjs "$LOG" "$code" "$OPS/.env") >/dev/null 2>&1 || echo "⚠️ Không gửi được báo cáo về Ops"
sudo -n -u agent -- /bin/kill -KILL -1 >/dev/null 2>&1 || true
rm -f "$OPS/.env" "$OPS/runner.config.json" "$LOG"

if [ "$code" = 0 ]; then echo "✅ Thành công"; else echo "❌ Thất bại — chi tiết trên Ops (Quản trị → Runner)"; fi
exit "$code"
