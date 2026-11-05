#!/usr/bin/env bash
# GitHub Actions, first step: is there any work in Ops? Sets the step output `work` (true/false)
# so an idle run (the 6-hourly schedule, mostly) stops before installing anything.
# Prints one line, nothing private.
set -uo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
envfile="$(mktemp)"
printf '%s\n' "${RUNNER_ENV:-}" >"$envfile"
unset RUNNER_ENV
node "$HERE/src/pending.mjs" "$envfile"
rc=$?
rm -f "$envfile"
if [ "$rc" = 10 ]; then
  echo "work=false" >>"${GITHUB_OUTPUT:-/dev/null}"
  echo "💤 Không có việc"
else
  echo "work=true" >>"${GITHUB_OUTPUT:-/dev/null}"
  echo "▶ Có việc"
fi
