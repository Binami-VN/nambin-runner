#!/usr/bin/env node
/**
 * CI: sends the outcome of a runner run to Ops, so the (public) GitHub run page can stay empty.
 *
 *   node src/report.mjs <log file> <exit code> <.env file>
 *
 * The .env file (the RUNNER_ENV secret) gives NAMBIN_OPS_URL and the token; every one of its
 * values, plus token-shaped strings, is removed from the log before it leaves. Prints nothing;
 * exit 1 when Ops could not be reached.
 */
import { existsSync, readFileSync } from 'node:fs';
import { makeRedactor } from './lib.mjs';

const [file, codeArg, envFile] = process.argv.slice(2);
const exitCode = Number.parseInt(codeArg ?? '1', 10);
const fileEnv = {};
if (envFile && existsSync(envFile)) {
  for (const raw of readFileSync(envFile, 'utf8').split('\n')) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    fileEnv[line.slice(0, eq).trim()] = value;
  }
}
const env = { ...process.env, ...fileEnv };
const url = String(env.NAMBIN_OPS_URL || '').replace(/\/+$/, '');
const token = env.NAMBIN_OPS_RUNNER_TOKEN || '';
if (!url || !token) process.exit(1);

// Everything the workflow passes from secrets, plus anything else that looks like a credential.
const SECRETS = ['NAMBIN_OPS_URL', 'NAMBIN_OPS_RUNNER_TOKEN', 'REPOS_TOKEN', 'GIT_PUSH_TOKEN', 'CURSOR_API_KEY', 'AGENT_LLM_API_KEY', 'AGENT_LLM_BASE_URL', 'OPS_REPOS'];
const isSecret = (k) => SECRETS.includes(k) || (/(TOKEN|KEY|SECRET|PASSWORD)/.test(k) && !/^(GITHUB|ACTIONS|RUNNER)_/.test(k));
// Every value of the .env file counts as secret (URLs, model, repo names included).
const parts = (v) => [v, ...String(v).split(/\s+/), ...String(v).split(/\s+/).map((x) => x.split('=').pop()), ...(/^https?:\/\//.test(v) ? [new URL(v).host] : [])];
const redact = makeRedactor([...Object.values(fileEnv).flatMap(parts), ...Object.entries(env).filter(([k]) => isSecret(k)).map(([, v]) => v)]);

let raw = '';
try {
  raw = readFileSync(file, 'utf8');
} catch {
  raw = '(không có log)';
}
const all = raw.split('\n').map((l) => l.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trimEnd());
const summaryLine = [...all].reverse().find((l) => l.startsWith('RUN_SUMMARY '));
let summary = null;
try {
  summary = summaryLine ? JSON.parse(summaryLine.slice('RUN_SUMMARY '.length)) : null;
} catch {
  summary = null;
}
const lines = all
  .filter((l) => l.trim())
  .slice(-400)
  .map((l) => redact(l).slice(0, 2000));
const runUrl = env.GITHUB_SERVER_URL === 'https://github.com' && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;

try {
  const res = await fetch(`${url}/api/runner/v1/report`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ok: exitCode === 0, exitCode: Number.isFinite(exitCode) ? exitCode : 1, summary, lines, runUrl, trigger: String(env.REASON || env.GITHUB_EVENT_NAME || '').slice(0, 100) || null }),
    signal: AbortSignal.timeout(30_000),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
