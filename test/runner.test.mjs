import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PM, agentEngines, branchName, llmConfig, forbiddenChanges, forbiddenPaths, isAgentBranch, isSafeRef, readConfig, repoRelative, resolveProject } from '../src/lib.mjs';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runner.mjs');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'nambin-runner-'));
}

function gitRepo(files) {
  const dir = tmp();
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 't');
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('readConfig: sites, projects, defaults, env secrets', () => {
  const dir = tmp();
  const file = path.join(dir, 'runner.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      opsUrl: 'http://ops.local/',
      defaults: { baseBranch: 'develop' },
      sites: { demo: { createPr: true, projects: { api: { path: './api', checks: [['bun', 'test'], { name: 'tc', cmd: 'tsc', args: ['--noEmit'] }] } } } },
    }),
  );
  const cfg = readConfig(file, { NAMBIN_OPS_RUNNER_TOKEN: 'tok', RUNNER_KINDS: 'security_scan,bogus' });
  assert.equal(cfg.opsUrl, 'http://ops.local');
  assert.equal(cfg.token, 'tok');
  assert.deepEqual(cfg.kinds, ['security_scan']);
  const api = cfg.sites.demo.projects.api;
  assert.equal(api.path, path.join(dir, 'api'));
  assert.equal(api.baseBranch, 'develop');
  assert.equal(cfg.sites.demo.createPr, true);
  assert.deepEqual(api.checks.map((c) => c.name), ['check1', 'tc']);
  assert.throws(() => readConfig(path.join(dir, 'nope.json'), {}));
});

test('readConfig: workspace folder of repos', () => {
  const dir = tmp();
  const ws = path.join(dir, 'ws');
  const mk = (name, files = {}) => {
    const d = path.join(ws, name);
    mkdirSync(path.join(d, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    for (const [f, c] of Object.entries(files)) writeFileSync(path.join(d, f), c);
  };
  mk('svc-a', { 'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }), 'yarn.lock': '' });
  mk('svc-b', { 'build.gradle.kts': '' });
  mk('web-ng', { 'package.json': JSON.stringify({ scripts: { test: 'ng test', lint: 'vitest run' } }) });
  writeFileSync(path.join(ws, 'svc-b', '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/dev\n');
  mk('svc-deploy');
  mkdirSync(path.join(ws, 'not-a-repo'));
  const file = path.join(dir, 'runner.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      sites: { warp: { workspace: './ws', exclude: ['*-deploy'], projects: { 'svc-b': { checks: [['./gradlew', 'test']] } } } },
    }),
  );
  const { projects } = readConfig(file, {}).sites.warp;
  assert.deepEqual(Object.keys(projects).sort(), ['svc-a', 'svc-b', 'web-ng']);
  assert.deepEqual(projects['web-ng'].checks.map((c) => c.name), ['lint']);
  assert.equal(projects['svc-a'].packageManager, 'yarn');
  assert.deepEqual(projects['svc-a'].checks.map((c) => `${c.cmd} ${c.args.join(' ')}`), ['yarn run lint', 'yarn run test']);
  assert.equal(projects['svc-a'].baseBranch, 'main');
  assert.equal(projects['svc-b'].packageManager, 'gradle');
  assert.equal(projects['svc-b'].baseBranch, 'dev');
  assert.equal(projects['svc-b'].checks[0].cmd, './gradlew');
});

test('project resolution and path helpers', () => {
  const siteCfg = { slug: 'demo', projects: { api: {}, web: {} } };
  const info = { projects: [{ name: 'api', pathPrefixes: ['nambin-api/'] }, { name: 'web', pathPrefixes: ['nambin-web/'] }] };
  assert.equal(resolveProject(siteCfg, info, { files: ['nambin-web/src/a.ts'] }), 'web');
  assert.equal(resolveProject(siteCfg, info, { project: 'api' }), 'api');
  assert.equal(resolveProject(siteCfg, info, {}), 'api');
  assert.throws(() => resolveProject(siteCfg, info, { project: 'x' }));
  assert.equal(repoRelative('nambin-web/src/a.ts', ['nambin-web/']), 'src/a.ts');
});

test('safety guards', () => {
  const b = branchName({ site: { slug: 'demo' }, kind: 'code_fix', id: '0123456789abcdef' });
  assert.equal(b, 'ops/demo/code-fix-89abcdef');
  assert.ok(isAgentBranch(b));
  assert.ok(!isAgentBranch('main'));
  assert.ok(!isAgentBranch('ops/demo/../main'));
  assert.ok(isSafeRef('HEAD~3..HEAD'));
  assert.ok(!isSafeRef('--upload-pack=x'));
  assert.ok(!isSafeRef('a;rm -rf /'));
  assert.deepEqual(forbiddenPaths(['.env', '.env.example', 'a/.env.local', 'wp-config.php', 'src/x.ts', 'k.pem']), ['.env', 'a/.env.local', 'wp-config.php', 'k.pem']);
  // Agent changes never touch the CI/deploy pipeline (it holds the deploy secrets); a scan of tracked files does not flag it.
  assert.deepEqual(forbiddenChanges(['.github/workflows/release.yml', '.github/deploy/activate.sh', '.github/CODEOWNERS', 'src/x.ts', '.env']), ['.github/workflows/release.yml', '.github/deploy/activate.sh', '.env']);
  assert.deepEqual(forbiddenPaths(['.github/workflows/ci.yml']), []);
});

test('readConfig: publishBranch, merge (only with createPr), git token from env', () => {
  const dir = tmp();
  const file = path.join(dir, 'runner.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      sites: {
        ci: { createPr: true, publishBranch: true, merge: true, projects: { api: { path: './api', install: false } } },
        nopr: { merge: true, projects: { api: { path: './api', install: false } } },
      },
    }),
  );
  const cfg = readConfig(file, { GIT_PUSH_TOKEN: 'ghp_x' });
  assert.equal(cfg.gitToken, 'ghp_x');
  assert.deepEqual([cfg.sites.ci.publishBranch, cfg.sites.ci.merge], [true, true]);
  assert.deepEqual([cfg.sites.nopr.publishBranch, cfg.sites.nopr.merge], [false, false]);
});

test('package manager output parsers', () => {
  const npm = PM.npm.parseOutdated(JSON.stringify({ express: { current: '4.18.0', wanted: '4.21.0', latest: '5.0.0' } }));
  assert.equal(npm[0].name, 'express');
  assert.equal(npm[0].major, true);
  const audit = PM.npm.parseAudit(JSON.stringify({ vulnerabilities: { lodash: { severity: 'high', via: [{ title: 'Proto pollution', url: 'u', range: '<4.17.21' }] } } }));
  assert.equal(audit[0].severity, 'high');
  assert.equal(audit[0].package, 'lodash');
});

/** Minimal stand-in for `/api/runner/v1` that records what the runner sends. */
function fakeOps(queue, approved = []) {
  const seen = { results: [], logs: [], applied: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      const send = (o, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.headers.authorization !== 'Bearer tok') return send({ error: { message: 'unauthorized' } }, 401);
      const url = req.url.replace('/api/runner/v1', '');
      if (url === '/ping') return send({ runner: { id: 'r1', name: 'test' }, sites: [{ slug: 'demo', name: 'Demo', projects: ['app'] }] });
      if (url === '/approved') return send({ items: approved.splice(0) });
      if (url === '/claim') return send({ task: queue.shift() ?? null });
      let m = url.match(/^\/tasks\/(\w+)\/(log|result|applied)$/);
      if (m) {
        if (m[2] === 'log') seen.logs.push(...json.lines);
        if (m[2] === 'result') seen.results.push({ id: m[1], ...json });
        if (m[2] === 'applied') seen.applied.push({ id: m[1], ...json });
        return send(m[2] === 'log' ? { cancelled: false } : { task: { id: m[1] } });
      }
      send({ error: { message: 'not found' } }, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function runRunner(configFile, env, expectCode = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, '--once', '--config', configFile], { env: { ...process.env, ...env, CURSOR_API_KEY: '' } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === expectCode ? resolve(out) : reject(new Error(`runner exit ${code}\n${out}`));
    });
  });
}

const site = { slug: 'demo', name: 'Demo', siteUrl: 'https://demo.test', projects: [{ name: 'app', pathPrefixes: [] }] };

test('end to end: security_scan, apply approved branch, unsupported kind', async () => {
  const fakeKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  const repo = gitRepo({ 'index.js': `const key = "${fakeKey}";\n`, 'README.md': '# demo\n' });
  const remote = tmp();
  sh(remote, 'init', '-q', '--bare');
  sh(repo, 'remote', 'add', 'origin', remote);
  sh(repo, 'push', '-q', 'origin', 'main');
  sh(repo, 'branch', 'ops/demo/code-fix-aaaabbbb');

  const dir = tmp();
  const config = path.join(dir, 'runner.config.json');
  writeFileSync(config, JSON.stringify({ worktreeDir: path.join(dir, 'wt'), sites: { demo: { projects: { app: { path: repo, install: false } } } } }));

  const ops = await fakeOps(
    [
      { id: 'task0000000000000000000a', kind: 'security_scan', title: 'Quét', input: {}, site },
      { id: 'task0000000000000000000b', kind: 'seo_audit', title: 'Không hỗ trợ', input: {}, site },
    ],
    [{ id: 'task0000000000000000000c', kind: 'code_fix', title: 'Fix', branch: 'ops/demo/code-fix-aaaabbbb', site }],
  );
  try {
    // One task failed (unsupported kind): a --once run exits 1 and says so in RUN_SUMMARY.
    const out = await runRunner(config, { NAMBIN_OPS_URL: ops.url, NAMBIN_OPS_RUNNER_TOKEN: 'tok' }, 1);
    assert.match(out, /Runner "test"/);
    assert.match(out, /RUN_SUMMARY \{"tasks":2,"failed":1,"applied":1,"applyFailed":0,"errors":0\}/);

    const scan = ops.seen.results.find((r) => r.id === 'task0000000000000000000a');
    assert.equal(scan.status, 'done');
    assert.match(scan.summary, /AWS access key/i);
    assert.match(scan.summary, /index\.js:1/);
    assert.ok(!scan.summary.includes(fakeKey), 'secret value must not be reported');

    const bad = ops.seen.results.find((r) => r.id === 'task0000000000000000000b');
    assert.equal(bad.status, 'failed');

    assert.equal(ops.seen.applied.length, 1);
    assert.equal(ops.seen.applied[0].ok, true);
    assert.ok(sh(remote, 'branch', '--list', 'ops/demo/code-fix-aaaabbbb'), 'branch pushed to remote');
    assert.ok(ops.seen.logs.length > 0);
  } finally {
    ops.server.close();
  }
});

test('publishBranch: an approved branch made by another run is fetched from the remote and pushed', async () => {
  const remote = tmp();
  sh(remote, 'init', '-q', '--bare', '-b', 'main');
  // The run that made the diff (another machine) pushed the review branch.
  const maker = gitRepo({ 'a.txt': 'a\n' });
  sh(maker, 'remote', 'add', 'origin', remote);
  sh(maker, 'push', '-q', 'origin', 'main');
  sh(maker, 'checkout', '-q', '-b', 'ops/demo/code-fix-ccccdddd');
  writeFileSync(path.join(maker, 'a.txt'), 'fixed\n');
  sh(maker, 'commit', '-qam', 'fix');
  sh(maker, 'push', '-q', 'origin', 'ops/demo/code-fix-ccccdddd');

  // This run: a fresh clone without that branch.
  const repo = tmp();
  execFileSync('git', ['clone', '-q', remote, repo]);
  const dir = tmp();
  const config = path.join(dir, 'runner.config.json');
  writeFileSync(config, JSON.stringify({ worktreeDir: path.join(dir, 'wt'), sites: { demo: { publishBranch: true, projects: { app: { path: repo, install: false } } } } }));
  const ops = await fakeOps([], [{ id: 'task0000000000000000000d', kind: 'code_fix', title: 'Fix', branch: 'ops/demo/code-fix-ccccdddd', site }]);
  try {
    await runRunner(config, { NAMBIN_OPS_URL: ops.url, NAMBIN_OPS_RUNNER_TOKEN: 'tok' });
    assert.equal(ops.seen.applied.length, 1);
    assert.equal(ops.seen.applied[0].ok, true, ops.seen.applied[0].note);
    assert.equal(sh(repo, 'rev-parse', 'ops/demo/code-fix-ccccdddd'), sh(maker, 'rev-parse', 'HEAD'));
  } finally {
    ops.server.close();
  }
});

test('llmConfig: URL + model required, key optional, responses API', () => {
  assert.equal(llmConfig({}), null);
  assert.equal(llmConfig({ AGENT_LLM_BASE_URL: 'https://x/v1' }), null);
  assert.deepEqual(llmConfig({ AGENT_LLM_BASE_URL: 'http://localhost:11434/v1/', AGENT_LLM_MODEL: 'qwen2.5-coder' }), { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder', apiKey: '', api: 'chat' });
  assert.equal(llmConfig({ AGENT_LLM_BASE_URL: 'https://api.openai.com/v1', AGENT_LLM_MODEL: 'gpt-5', AGENT_LLM_API: 'responses' }).api, 'responses');
  assert.throws(() => llmConfig({ AGENT_LLM_BASE_URL: 'ftp://x', AGENT_LLM_MODEL: 'm' }));
});

test('agentEngines: order, keys, normalisation', () => {
  assert.deepEqual(agentEngines(undefined, { cursor: true, opencode: true }), ['opencode', 'cursor']);
  assert.deepEqual(agentEngines('cursor, opencode', { cursor: true, opencode: true }), ['cursor', 'opencode']);
  assert.deepEqual(agentEngines(undefined, { cursor: true, opencode: false }), ['cursor']);
  assert.deepEqual(agentEngines('aider,opencode,opencode', { cursor: true, opencode: true }), ['opencode']);
  assert.deepEqual(agentEngines(undefined, { cursor: false, opencode: false }), []);
});

test('code_fix with OpenCode (custom OpenAI-compatible API): edits, checks, follow-up turn, secrets hidden', async () => {
  const repo = gitRepo({ 'value.txt': 'bad\n', 'check.sh': 'grep -q good value.txt\n' });
  const remote = tmp();
  sh(remote, 'init', '-q', '--bare', '-b', 'main');
  sh(repo, 'remote', 'add', 'origin', remote);
  sh(repo, 'push', '-q', 'origin', 'main');
  const dir = tmp();
  // Fake `opencode run`: 1st turn writes a wrong fix, 2nd (--continue) the right one; records what it saw.
  const bin = path.join(dir, 'opencode');
  const seen = path.join(dir, 'seen.txt');
  writeFileSync(
    bin,
    `#!/bin/sh
{ echo "args:$*"; echo "token:\${NAMBIN_OPS_RUNNER_TOKEN:-none}"; echo "gh:\${GIT_PUSH_TOKEN:-none}"; echo "key:\${AGENT_LLM_API_KEY:-none}"; echo "cfg:\$OPENCODE_CONFIG_CONTENT"; echo "perm:\${OPENCODE_PERMISSION:+set}"; } >> "${seen}"
case "$*" in *--continue*) echo good > value.txt ;; *) echo meh > value.txt ;; esac
echo "**Nguyên nhân** x"
`,
  );
  chmodSync(bin, 0o755);
  const config = path.join(dir, 'runner.config.json');
  writeFileSync(
    config,
    JSON.stringify({
      worktreeDir: path.join(dir, 'wt'),
      fixAttempts: 1,
      sites: { demo: { publishBranch: true, projects: { app: { path: repo, install: false, checks: [{ name: 'value', cmd: 'sh', args: ['check.sh'] }] } } } },
    }),
  );
  const ops = await fakeOps([{ id: 'task0000000000000000000e', kind: 'code_fix', title: 'Sửa value', input: { prompt: 'make it good' }, site }]);
  try {
    const out = await runRunner(config, { NAMBIN_OPS_URL: ops.url, NAMBIN_OPS_RUNNER_TOKEN: 'tok', AGENT_LLM_BASE_URL: 'https://llm.example.com/v1/', AGENT_LLM_API_KEY: 'sk-test', AGENT_LLM_MODEL: 'qwen/qwen3-coder:free', OPENCODE_BIN: bin, GIT_PUSH_TOKEN: '' });
    assert.match(out, /agent opencode\/qwen\/qwen3-coder:free@llm\.example\.com/);
    const r = ops.seen.results[0];
    assert.equal(r.status, 'needs_review', JSON.stringify(r));
    assert.match(r.diff, /\+good/);
    assert.ok(r.checks.every((c) => c.ok));
    assert.equal(r.branch, 'ops/demo/code-fix-0000000e');
    assert.ok(sh(remote, 'branch', '--list', r.branch), 'review branch published');
    const log = readFileSync(seen, 'utf8');
    assert.match(log, /args:run --auto --pure -m llm\/qwen\/qwen3-coder:free /);
    assert.match(log, /"baseURL":"https:\/\/llm\.example\.com\/v1"/);
    assert.match(log, /"apiKey":"\{env:AGENT_LLM_API_KEY\}"/);
    assert.ok(!/cfg:.*sk-test/.test(log), 'key is not inlined in the config');
    assert.match(log, /--continue/);
    assert.match(log, /token:none/);
    assert.match(log, /key:sk-test/);
    assert.match(log, /perm:set/);
  } finally {
    ops.server.close();
  }
});

test('sandbox: agent and checks run as the sandbox user, git ignores a rewritten .git file, CI files hidden', async () => {
  const repo = gitRepo({ 'value.txt': 'bad\n', 'check.sh': 'grep -q good value.txt\n' });
  const remote = tmp();
  sh(remote, 'init', '-q', '--bare', '-b', 'main');
  sh(repo, 'remote', 'add', 'origin', remote);
  sh(repo, 'push', '-q', 'origin', 'main');
  const dir = tmp();
  const sudoLog = path.join(dir, 'sudo.txt');
  const seen = path.join(dir, 'seen.txt');
  // Fake sudo: records the call, drops `-n -E -u agent --`, runs the rest (kill -1 is a no-op here).
  const sudo = path.join(dir, 'sudo');
  writeFileSync(
    sudo,
    `#!/bin/sh
echo "$*" >> "${sudoLog}"
case "$*" in *"/bin/kill"*) exit 0 ;; esac
[ "$1" = -n ] && [ "$2" = -u ] && [ "$3" = agent ] && [ "$4" = -- ] || exit 97
shift 4
exec "$@"
`,
  );
  chmodSync(sudo, 0o755);
  // The agent fixes the file, then tries to hijack the runner's git with its own .git pointer.
  const bin = path.join(dir, 'opencode');
  writeFileSync(
    bin,
    `#!/bin/sh
{ echo "home:$HOME"; echo "summary:\${GITHUB_STEP_SUMMARY:-none}"; echo "genv:\${GITHUB_ENV:-none}"; echo "token:\${NAMBIN_OPS_RUNNER_TOKEN:-none}"; } >> "${seen}"
echo good > value.txt
mkdir -p "${dir}/evil/hooks"; printf '#!/bin/sh\\ntouch "${dir}/pwned"\\n' > "${dir}/evil/hooks/pre-commit"; chmod +x "${dir}/evil/hooks/pre-commit"
echo "gitdir: ${dir}/evil" > .git
echo done
`,
  );
  chmodSync(bin, 0o755);
  const config = path.join(dir, 'runner.config.json');
  writeFileSync(
    config,
    JSON.stringify({
      worktreeDir: path.join(dir, 'wt'),
      fixAttempts: 0,
      sites: { demo: { publishBranch: true, projects: { app: { path: repo, install: false, checks: [{ name: 'value', cmd: 'sh', args: ['check.sh'] }] } } } },
    }),
  );
  const ops = await fakeOps([{ id: 'task0000000000000000000f', kind: 'code_fix', title: 'Sửa value', input: { prompt: 'make it good' }, site }]);
  try {
    await runRunner(config, {
      NAMBIN_OPS_URL: ops.url,
      NAMBIN_OPS_RUNNER_TOKEN: 'tok',
      AGENT_LLM_BASE_URL: 'https://llm.example.com/v1',
      AGENT_LLM_MODEL: 'm',
      OPENCODE_BIN: bin,
      GIT_PUSH_TOKEN: '',
      RUNNER_SANDBOX_USER: 'agent',
      RUNNER_SANDBOX_HOME: path.join(dir, 'agent-home'),
      RUNNER_SANDBOX_SUDO: sudo,
      RUNNER_SANDBOX_ACL: '0',
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
      GITHUB_ENV: path.join(dir, 'github-env'),
    });
    const r = ops.seen.results[0];
    assert.equal(r.status, 'needs_review', JSON.stringify(r));
    assert.match(r.diff, /\+good/);
    assert.ok(sh(remote, 'branch', '--list', r.branch), 'review branch published');
    assert.ok(!existsSync(path.join(dir, 'pwned')), "the agent's hook never ran");
    const calls = readFileSync(sudoLog, 'utf8');
    assert.match(calls, /-u agent -- \/usr\/bin\/env -i PATH=\S* HOME=\S*agent-home XDG_CONFIG_HOME=\S*agent-home\/\.config .*\S*opencode run/);
    assert.match(calls, /-u agent -- \/usr\/bin\/env -i PATH=\S* HOME=\S*agent-home .*sh check\.sh/);
    assert.match(calls, /\/bin\/kill -KILL -1/);
    assert.ok(!/HOME=\S+ git /.test(calls), 'git runs as the runner, not through sudo');
    const log = readFileSync(seen, 'utf8');
    assert.match(log, /home:\S*agent-home/);
    assert.match(log, /summary:none/);
    assert.match(log, /genv:none/);
    assert.match(log, /token:none/);
  } finally {
    ops.server.close();
  }
});
