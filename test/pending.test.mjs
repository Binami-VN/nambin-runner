import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../src/pending.mjs', import.meta.url));

function exitCode(envText) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pending-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, envText);
  return new Promise((resolve) => execFile(process.execPath, [script, file], (err) => resolve(err ? err.code : 0)));
}

async function withOps(handler, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, method: req.method });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

const json = (body, status = 200) => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('pending: idle → 10, work → 0, token sent', async () => {
  await withOps(json({ queued: 0, approved: 0 }), async (url, seen) => {
    assert.equal(await exitCode(`NAMBIN_OPS_URL=${url}/\nNAMBIN_OPS_RUNNER_TOKEN="bor_x"\n`), 10);
    assert.deepEqual(seen[0], { url: '/api/runner/v1/pending', auth: 'Bearer bor_x', method: 'POST' });
  });
  await withOps(json({ queued: 1, approved: 0 }), async (url) => assert.equal(await exitCode(`NAMBIN_OPS_URL=${url}\nNAMBIN_OPS_RUNNER_TOKEN=bor_x\n`), 0));
  await withOps(json({ queued: 0, approved: 2 }), async (url) => assert.equal(await exitCode(`NAMBIN_OPS_URL=${url}\nNAMBIN_OPS_RUNNER_TOKEN=bor_x\n`), 0));
});

test('pending: when Ops cannot answer, the run goes on (exit 0)', async () => {
  await withOps(json({ error: 'not found' }, 404), async (url) => assert.equal(await exitCode(`NAMBIN_OPS_URL=${url}\nNAMBIN_OPS_RUNNER_TOKEN=bor_x\n`), 0));
  await withOps(json({ ok: true }), async (url) => assert.equal(await exitCode(`NAMBIN_OPS_URL=${url}\nNAMBIN_OPS_RUNNER_TOKEN=bor_x\n`), 0));
  assert.equal(await exitCode('NAMBIN_OPS_URL=http://127.0.0.1:9\nNAMBIN_OPS_RUNNER_TOKEN=bor_x\n'), 0);
  assert.equal(await exitCode(''), 0);
});
