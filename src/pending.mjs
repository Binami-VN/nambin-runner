#!/usr/bin/env node
/**
 * CI: asks Ops whether any runner task is waiting, before anything gets installed.
 *
 *   node src/pending.mjs <.env file>
 *
 * Exit 10: nothing queued or approved (the run can stop here). Exit 0: there is work, or Ops
 * could not answer (an older Ops without `/pending`, network trouble): run normally then.
 * Prints nothing. Node built-ins only, so it runs before `npm install`.
 */
import { existsSync, readFileSync } from 'node:fs';

const IDLE = 10;
const envFile = process.argv[2];
const env = {};
if (envFile && existsSync(envFile)) {
  for (const raw of readFileSync(envFile, 'utf8').split('\n')) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    env[line.slice(0, eq).trim()] = value;
  }
}
const url = String(env.NAMBIN_OPS_URL || '').replace(/\/+$/, '');
const token = env.NAMBIN_OPS_RUNNER_TOKEN || '';
if (!url || !token) process.exit(0);

try {
  const res = await fetch(`${url}/api/runner/v1/pending`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) process.exit(0);
  const body = await res.json();
  const queued = Number(body?.queued);
  const approved = Number(body?.approved);
  if (!Number.isFinite(queued) || !Number.isFinite(approved)) process.exit(0);
  process.exit(queued + approved > 0 ? 0 : IDLE);
} catch {
  process.exit(0);
}
