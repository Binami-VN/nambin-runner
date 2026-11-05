#!/usr/bin/env node
/**
 * NAMBIN Ops runner: the machine that holds the source code of one or more sites.
 *
 * Polls `/api/runner/v1` for code tasks, works on each in its own git worktree, sends the result
 * back for review. Nothing is pushed until an admin approves; approved tasks are then pushed
 * (and a PR opened if `createPr`).
 *
 *   code_fix           Cursor agent edits → project checks → commit on `ops/<site>/…` → diff
 *   code_review        Cursor agent reviews a commit range (read-only) → markdown
 *   dependency_update  outdated + update (bun / npm / pnpm / composer) → checks → diff
 *   security_scan      audit + secret scan of tracked files → report
 *
 *   nambin-runner                 poll forever
 *   nambin-runner --once          handle what is queued, then exit
 *   nambin-runner ping            check URL, token and which local repos match the sites
 *   --config <file>               default ./runner.config.json
 */
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECK_OUTPUT_MAX,
  DIFF_MAX,
  PM,
  SECRET_PATTERNS,
  branchName,
  countSeverities,
  declaredPackages,
  forbiddenChanges,
  forbiddenPaths,
  head,
  isAgentBranch,
  isSafeRef,
  loadEnvFile,
  makeRedactor,
  projectsFor,
  readConfig,
  repoRelative,
  resolveProject,
  tail,
} from './lib.mjs';

const VERSION = '0.1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CancelledError extends Error {
  constructor() {
    super('Tác vụ đã bị huỷ trên dashboard');
  }
}

export const SECRET_ENV = ['NAMBIN_OPS_URL', 'OPS_REPOS', 'RUNNER_ENV', 'RUNNER_CONFIG', 'NAMBIN_OPS_RUNNER_TOKEN', 'CURSOR_API_KEY', 'AGENT_LLM_API_KEY', 'GIT_PUSH_TOKEN', 'REPOS_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
/**
 * GitHub Actions hands every step files that end up on the (public) run page or steer later
 * steps (step summary, outputs, env, PATH), plus runtime/OIDC tokens. Nothing the runner starts
 * (agents, checks, installs) gets them.
 */
const CI_ENV = /^(GITHUB_(STEP_SUMMARY|OUTPUT|ENV|PATH|STATE)|ACTIONS_(RUNTIME_TOKEN|RUNTIME_URL|ID_TOKEN_REQUEST_\w+|CACHE_URL|RESULTS_URL))$/;
export const isHiddenEnv = (key) => SECRET_ENV.includes(key) || CI_ENV.test(key);

/** Child processes never see the runner's own secrets. */
function childEnv(extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (isHiddenEnv(key)) delete env[key];
  return { ...env, ...extra };
}

/** Applied to every log line sent to Ops; set in main() from the secrets it was given. */
let redact = (t) => t;

/** What this process did, for `--once` runs (exit code 1 when something failed). */
const stats = { tasks: 0, failed: 0, applied: 0, applyFailed: 0, errors: 0 };

/**
 * GitHub token (`GIT_PUSH_TOKEN`, e.g. on GitHub Actions): only `git` and `gh` started by the
 * runner get it, never the coding agent, project checks or installs. Set once in main().
 * Passed in the environment (GIT_CONFIG_*), not on the command line: /proc/<pid>/cmdline is
 * readable by every user of the machine, the environment only by the same user.
 */
const auth = { gitEnv: undefined, ghEnv: undefined };
export function setGitToken(token) {
  if (!token) return;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  auth.gitEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
  auth.ghEnv = { GH_TOKEN: token };
}

/**
 * Sandbox (cfg.sandbox, CI): everything except git/gh runs as another user. Worktrees are shared
 * with that user through ACLs, and git always gets the worktree's git dir explicitly (GIT_DIR),
 * so an agent that rewrites the worktree's `.git` file cannot point the runner's git at a
 * config/hooks of its own. Hooks are off for the runner's git in any case.
 */
const sandbox = { cfg: null, worktrees: new Map() };
export function setSandbox(cfg) {
  sandbox.cfg = cfg ?? null;
  sandbox.worktrees.clear();
}

/** Process-state variables of the runner: the sandboxed command gets its own (PWD would make
 *  tools like OpenCode work in the runner's directory instead of the worktree). */
const DROP_FOR_SANDBOX = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'XDG_RUNTIME_DIR', 'USER', 'LOGNAME', 'MAIL', 'SUDO_USER', 'SUDO_UID', 'SUDO_GID', 'SUDO_COMMAND']);

/** [cmd, args, env] to start an untrusted command (agent, check, install). */
function untrusted(cmd, args, env) {
  const sb = sandbox.cfg;
  if (!sb) return [cmd, args, env];
  // sudo resets the environment and some (sudo-rs on hosted Ubuntu) refuse `-E`, so the command
  // gets exactly its environment through `env -i NAME=value…`. `env` is the scrubbed child
  // environment (no runner secrets), meant for the agent anyway. CI images point XDG_* into the
  // runner's closed home; the agent gets its own dirs.
  const dirs = { HOME: sb.home, XDG_CONFIG_HOME: `${sb.home}/.config`, XDG_DATA_HOME: `${sb.home}/.local/share`, XDG_CACHE_HOME: `${sb.home}/.cache`, XDG_STATE_HOME: `${sb.home}/.local/state` };
  const vars = { PATH: env.PATH ?? process.env.PATH ?? '', ...dirs };
  const ownHome = process.env.HOME || '/nonexistent';
  for (const [k, v] of Object.entries(env)) {
    if (v == null || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || DROP_FOR_SANDBOX.has(k) || k === 'PATH' || k === 'HOME') continue;
    // Keep XDG dirs a caller chose (OpenCode's own), never ones inside the runner's home.
    if (k in dirs && (String(v) === ownHome || String(v).startsWith(ownHome + '/'))) continue;
    vars[k] = String(v);
  }
  const assign = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  return [sb.sudo, ['-n', '-u', sb.user, '--', '/usr/bin/env', '-i', ...assign, cmd, ...args], { PATH: process.env.PATH ?? '' }];
}

function gitEnv(cwd) {
  const env = { ...childEnv(), ...auth.gitEnv };
  if (!sandbox.cfg) return env;
  const abs = cwd ? path.resolve(cwd) : '';
  for (const [dir, gitDir] of sandbox.worktrees) {
    if (abs === dir || abs.startsWith(dir + path.sep)) return { ...env, GIT_DIR: gitDir, GIT_WORK_TREE: dir };
  }
  return env;
}

/** Runs a command without a shell. Never rejects: a non-zero exit is a result. */
export function run(cmd, args, { cwd, timeoutMs = 10 * 60_000 } = {}) {
  let env;
  if (cmd === 'git') {
    env = gitEnv(cwd);
    if (sandbox.cfg) args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args];
  } else if (cmd === 'gh') env = childEnv(auth.ghEnv);
  else [cmd, args, env] = untrusted(cmd, args, childEnv());
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim();
      if (!err) return resolve({ code: 0, out, stdout: stdout ?? '' });
      const code = typeof err.code === 'number' ? err.code : 1;
      const reason = err.killed ? `\n(bị dừng sau ${Math.round(timeoutMs / 1000)}s)` : err.code === 'ENOENT' ? `\n(không tìm thấy lệnh ${cmd})` : '';
      resolve({ code, out: `${out}${reason}`, stdout: stdout ?? '' });
    });
  });
}

async function git(cwd, args, opts) {
  const res = await run('git', args, { cwd, ...opts });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} thất bại: ${tail(res.out, 1500)}`);
  return res.stdout.trim();
}

const refExists = async (cwd, ref) => (await run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })).code === 0;

// ---- Ops API ---------------------------------------------------------------------------------

function apiClient(cfg) {
  const base = `${cfg.opsUrl}/api/runner/v1`;
  async function call(method, pathname, body) {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const err = new Error(`${method} ${pathname} → ${res.status}: ${json?.error?.message ?? head(text, 300)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  const scope = {
    sites: Object.keys(cfg.sites),
    // Lets the dashboard offer every local repo (e.g. a `workspace` folder) as a task target.
    projects: Object.fromEntries(Object.values(cfg.sites).map((s) => [s.slug, Object.keys(s.projects)])),
    ...(cfg.kinds ? { kinds: cfg.kinds } : {}),
    version: VERSION,
  };
  return {
    ping: () => call('GET', '/ping'),
    claim: () => call('POST', '/claim', scope),
    approved: () => call('POST', '/approved', scope),
    log: (id, lines) => call('POST', `/tasks/${id}/log`, { lines }),
    result: (id, result) => call('POST', `/tasks/${id}/result`, result),
    applied: (id, ok, note) => call('POST', `/tasks/${id}/applied`, { ok, note: head(note, 3900) }),
  };
}

/** Buffers log lines; each post renews the task lease and reports cancellation. */
class TaskLog {
  constructor(api, id) {
    this.api = api;
    this.id = id;
    this.lines = [];
    this.cancelled = false;
    this.lastPost = Date.now();
    this.chain = Promise.resolve();
    this.timer = setInterval(() => {
      if (this.lines.length || Date.now() - this.lastPost > 4 * 60_000) this.flush(true);
    }, 5000);
  }
  add(message) {
    for (const line of String(message).split('\n')) {
      const text = redact(line.trimEnd());
      if (!text.trim()) continue;
      console.log(`[${this.id.slice(-6)}] ${text}`);
      this.lines.push(head(text, 1990));
    }
    if (this.lines.length >= 40) this.flush();
  }
  flush(heartbeat = false) {
    this.chain = this.chain.then(async () => {
      while (this.lines.length || heartbeat) {
        const batch = this.lines.length ? this.lines.splice(0, 50) : ['… runner vẫn đang chạy'];
        heartbeat = false;
        try {
          const res = await this.api.log(this.id, batch);
          this.lastPost = Date.now();
          if (res?.cancelled) this.cancelled = true;
        } catch (err) {
          console.warn(`[${this.id.slice(-6)}] gửi log thất bại: ${err.message}`);
          return;
        }
      }
    });
    return this.chain;
  }
  throwIfCancelled() {
    if (this.cancelled) throw new CancelledError();
  }
  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}

// ---- worktrees -------------------------------------------------------------------------------

function projectCfg(cfg, task, name) {
  const site = cfg.sites[task.site?.slug];
  if (!site) throw new Error(`Máy runner không có repo nào của site ${task.site?.slug}`);
  const p = site.projects[name];
  if (!p) throw new Error(`Máy runner không có dự án ${name} của site ${site.slug}`);
  if (!existsSync(path.join(p.path, '.git'))) throw new Error(`${p.path} không phải git repo`);
  return p;
}

async function resolveBase(p, log) {
  const fetched = await run('git', ['fetch', '--quiet', p.remote, p.baseBranch], { cwd: p.path, timeoutMs: 120_000 });
  if (fetched.code !== 0) log.add(`Không fetch được ${p.remote}/${p.baseBranch}, dùng nhánh local: ${tail(fetched.out, 300)}`);
  const remoteRef = `${p.remote}/${p.baseBranch}`;
  return (await refExists(p.path, remoteRef)) ? remoteRef : p.baseBranch;
}

async function createWorktree(cfg, p, task, log, { branch = null, at = null, install = true } = {}) {
  const base = at ?? (await resolveBase(p, log));
  const baseSha = await git(p.path, ['rev-parse', `${base}^{commit}`]);
  const dir = path.join(cfg.worktreeDir, `${task.site.slug}-${p.name}-${task.id}`);
  mkdirSync(cfg.worktreeDir, { recursive: true });
  if (existsSync(dir)) await run('git', ['worktree', 'remove', '--force', dir], { cwd: p.path });
  await run('git', ['worktree', 'prune'], { cwd: p.path });
  await git(p.path, branch ? ['worktree', 'add', '-B', branch, dir, baseSha] : ['worktree', 'add', '--detach', dir, baseSha]);
  await shareWorktree(cfg, dir);
  log.add(`Worktree ${p.name} tại ${base} (${baseSha.slice(0, 10)})${branch ? ` → nhánh ${branch}` : ''}`);
  for (const file of p.copyFiles) {
    const from = path.join(p.path, file);
    if (existsSync(from)) copyFileSync(from, path.join(dir, file));
  }
  if (install && p.install) {
    log.add(`${p.install.join(' ')} (${p.name})…`);
    const res = await run(p.install[0], p.install.slice(1), { cwd: dir, timeoutMs: 10 * 60_000 });
    if (res.code !== 0) throw new Error(`Cài thư viện thất bại:\n${tail(res.out, 2000)}`);
  }
  return { p, dir, branch, base, baseSha };
}

async function removeWorktree(wt) {
  if (!wt) return;
  await run('git', ['worktree', 'remove', '--force', wt.dir], { cwd: wt.p.path });
  sandbox.worktrees.delete(path.resolve(wt.dir));
}

/** Read-write ACL for `user` on dir (and everything created in it later, by either user). */
async function shareDir(dir, { recursive = true } = {}) {
  const sb = sandbox.cfg;
  if (!sb?.acl) return;
  const me = os.userInfo().username;
  const res = await new Promise((resolve) =>
    execFile('setfacl', [...(recursive ? ['-R'] : []), '-m', `u:${sb.user}:rwX,d:u:${sb.user}:rwX,d:u:${me}:rwX`, dir], (err, _o, stderr) => resolve(err ? stderr || err.message : null)),
  );
  if (res) throw new Error(`setfacl ${dir} thất bại: ${res}`);
}

/** Sandbox: remember the worktree's git dir (read now, before any agent ran) and share the files. */
async function shareWorktree(cfg, dir) {
  if (!sandbox.cfg) return;
  const abs = path.resolve(dir);
  const gitDir = await git(abs, ['rev-parse', '--absolute-git-dir']);
  sandbox.worktrees.set(abs, gitDir);
  if (sandbox.cfg.acl) {
    // The sandbox user may enter the worktree folder but not list or change the others.
    await new Promise((resolve) => execFile('setfacl', ['-m', `u:${sandbox.cfg.user}:x`, path.resolve(cfg.worktreeDir)], () => resolve()));
  }
  await shareDir(abs);
}

async function runChecks(cfg, wt, log) {
  const checks = [];
  if (!wt.p.checks.length) log.add(`⚠️ ${wt.p.name}: chưa khai báo "checks" trong runner.config.json, không kiểm chứng được thay đổi`);
  for (const check of wt.p.checks) {
    log.throwIfCancelled();
    log.add(`▶ ${wt.p.name} ${check.name}: ${check.cmd} ${check.args.join(' ')}`);
    const started = Date.now();
    const res = await run(check.cmd, check.args, { cwd: wt.dir, timeoutMs: cfg.checkTimeoutMs });
    const ok = res.code === 0;
    log.add(`${ok ? '✔' : '✘'} ${wt.p.name} ${check.name} (${Math.round((Date.now() - started) / 1000)}s)`);
    checks.push({ name: `${wt.p.name} ${check.name}`, ok, output: tail(res.out, CHECK_OUTPUT_MAX) });
  }
  return checks;
}

async function commitChanges(wt, message) {
  await git(wt.dir, ['add', '-A']);
  const names = (await git(wt.dir, ['diff', '--cached', '--name-only', wt.baseSha])).split('\n').filter(Boolean);
  if (!names.length) return null;
  const bad = forbiddenChanges(names);
  if (bad.length) throw new Error(`Thay đổi chạm vào file nhạy cảm hoặc pipeline CI/deploy, bỏ: ${bad.join(', ')}`);
  const prefix = [`--src-prefix=a/${wt.p.name}/`, `--dst-prefix=b/${wt.p.name}/`];
  const diff = await git(wt.dir, ['diff', '--cached', ...prefix, wt.baseSha]);
  const stat = await git(wt.dir, ['diff', '--cached', '--stat', wt.baseSha]);
  const identity = (await run('git', ['config', 'user.email'], { cwd: wt.dir })).stdout.trim() ? [] : ['-c', 'user.name=NAMBIN Ops Agent', '-c', 'user.email=ops-agent@nambin.local'];
  await git(wt.dir, [...identity, 'commit', '--no-verify', '-q', '-m', message]);
  return { diff: `${diff}\n`, stat, files: names };
}

/**
 * `publishBranch` (machines that do not keep their disk, e.g. GitHub Actions): the review branch
 * is pushed right away so the run that handles the approval can fetch it. It is only a branch:
 * nothing is merged or deployed until the diff is approved.
 */
async function publishBranch(cfg, task, wt, log) {
  if (!cfg.sites[task.site.slug]?.publishBranch || !wt.branch) return;
  log.add(`git push ${wt.p.remote} ${wt.branch} (nhánh chờ duyệt, chưa merge)`);
  await git(wt.dir, ['push', '--force', wt.p.remote, `${wt.branch}:${wt.branch}`], { timeoutMs: 180_000 });
}

// ---- coding agents ---------------------------------------------------------------------------
//
// `cursor`: Cursor SDK (CURSOR_API_KEY, Cursor's models and quota).
// `opencode`: OpenCode CLI on any OpenAI-compatible API (AGENT_LLM_BASE_URL / _API_KEY / _MODEL):
//             OpenRouter free models, Groq, Gemini, a local Ollama…
// cfg.engines is the order to try; when one fails (quota, rate limit, outage) the worktree is
// reset and the next one gets the same task.

async function withAgent(cfg, cwd, log, fn) {
  const engines = cfg.engines;
  if (!engines.length) throw new Error('Chưa có agent sửa code: cần CURSOR_API_KEY, hoặc AGENT_LLM_BASE_URL + AGENT_LLM_MODEL (+ AGENT_LLM_API_KEY) trong .env của runner');
  for (let i = 0; ; i++) {
    const engine = engines[i];
    try {
      return engine === 'opencode' ? await withOpenCode(cfg, cwd, log, fn) : await withCursorAgent(cfg, cwd, log, fn);
    } catch (err) {
      if (err instanceof CancelledError || log.cancelled || i + 1 >= engines.length) throw err;
      log.add(`⚠️ Agent ${engine} lỗi (${head(String(err.message), 300)}), chuyển sang ${engines[i + 1]}`);
      // The next agent starts from the base commit, not from a half-done edit.
      await run('git', ['reset', '--hard', '-q'], { cwd });
      await run('git', ['clean', '-fdq'], { cwd });
    }
  }
}

/** OpenCode permissions: no git writes, no secrets, no network tools, nothing outside the worktree. */
export const OPENCODE_PERMISSION = {
  '*': 'allow',
  external_directory: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  question: 'deny',
  doom_loop: 'deny',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow', '*.pem': 'deny', '*.key': 'deny' },
  edit: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '.github/*': 'deny' },
  bash: {
    '*': 'allow',
    'git commit*': 'deny',
    'git push*': 'deny',
    'git config*': 'deny',
    'git remote*': 'deny',
    'git checkout -b*': 'deny',
    'git branch*': 'deny',
    'env': 'deny',
    'env *': 'deny',
    'printenv*': 'deny',
    'export*': 'deny',
    'set': 'deny',
    'cat /proc*': 'deny',
    'curl*': 'deny',
    'wget*': 'deny',
  },
};

const LLM_PROVIDER = 'llm';

/** OpenCode config: one custom provider pointing at the configured endpoint; key read from env. */
export function opencodeConfig(llm) {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    provider: {
      [LLM_PROVIDER]: {
        npm: llm.api === 'responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible',
        name: 'Runner LLM',
        options: { baseURL: llm.baseUrl, ...(llm.apiKey ? { apiKey: '{env:AGENT_LLM_API_KEY}' } : {}) },
        models: { [llm.model]: { name: llm.model, tool_call: true } },
      },
    },
    model: `${LLM_PROVIDER}/${llm.model}`,
  };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

async function withOpenCode(cfg, cwd, log, fn) {
  const llm = cfg.llm;
  if (!llm) throw new Error('Thiếu AGENT_LLM_BASE_URL / AGENT_LLM_MODEL');
  // Own config/data dir per task: no global config, and `--continue` resumes exactly this session.
  const home = path.join(cfg.worktreeDir, `.opencode-${path.basename(cwd)}`);
  mkdirSync(home, { recursive: true });
  await shareDir(home);
  const bin = cfg.opencodeBin;
  const env = {
    ...childEnv(),
    // OpenCode calls the model itself, so it needs the key: use a key with a spending limit.
    AGENT_LLM_API_KEY: llm.apiKey,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(llm)),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    OPENCODE_PERMISSION: JSON.stringify(OPENCODE_PERMISSION),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  };
  log.add(`OpenCode agent (model ${llm.model} @ ${new URL(llm.baseUrl).host})`);
  let turn = 0;
  const send = (prompt) =>
    new Promise((resolve, reject) => {
      const args = ['run', '--auto', '--pure', '-m', `${LLM_PROVIDER}/${llm.model}`, ...(turn++ ? ['--continue'] : []), prompt];
      const [c, a, e] = untrusted(bin, args, env);
      const child = spawn(c, a, { cwd, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let pending = '';
      const onData = (chunk) => {
        const text = stripAnsi(chunk.toString());
        out += text;
        pending += text;
        const cut = pending.lastIndexOf('\n');
        if (cut >= 0) {
          for (const line of pending.slice(0, cut).split('\n')) if (line.trim()) log.add(head(line.trim(), 500));
          pending = pending.slice(cut + 1);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const deadline = Date.now() + cfg.agentTimeoutMs;
      let stopReason = null;
      const watch = setInterval(() => {
        if (log.cancelled) stopReason = 'cancelled';
        else if (Date.now() > deadline) stopReason = 'timeout';
        if (stopReason) child.kill('SIGTERM');
      }, 3000);
      child.on('error', (err) => {
        clearInterval(watch);
        reject(new Error(err.code === 'ENOENT' ? `Không tìm thấy lệnh ${bin} (npm i -g opencode-ai)` : err.message));
      });
      child.on('close', (code) => {
        clearInterval(watch);
        if (pending.trim()) log.add(head(pending.trim(), 500));
        if (stopReason === 'cancelled') return reject(new CancelledError());
        if (stopReason === 'timeout') return reject(new Error(`OpenCode quá ${Math.round(cfg.agentTimeoutMs / 60_000)} phút`));
        if (code !== 0) return reject(new Error(`OpenCode thoát mã ${code}: ${tail(out.trim(), 800)}`));
        // Rate limit / auth errors are printed while the process still exits 0 on some versions.
        if (/\b(429|rate.?limit|insufficient credits|unauthorized|401)\b/i.test(tail(out, 2000)) && out.trim().length < 4000) {
          return reject(new Error(`API model từ chối: ${tail(out.trim(), 500)}`));
        }
        resolve(tail(out.trim(), 6000));
      });
    });
  try {
    return await fn(send);
  } finally {
    await reapSandbox();
  }
}

/**
 * Cursor SDK in a child process (src/cursor-worker.mjs), as the sandbox user when there is one:
 * the SDK's shell/file tools run in that process, so they never share memory or environment
 * with the runner. The API key goes over stdin, not the environment.
 */
async function withCursorAgent(cfg, cwd, log, fn) {
  if (!cfg.cursorApiKey) throw new Error('Thiếu CURSOR_API_KEY trong .env của runner (cần cho code_fix / code_review)');
  const worker = fileURLToPath(new URL('./cursor-worker.mjs', import.meta.url));
  const [c, a, e] = untrusted(process.execPath, [worker], childEnv({ CURSOR_WORKER_OPTS: JSON.stringify({ model: cfg.model, cwd }) }));
  const child = spawn(c, a, { cwd, env: e, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = [];
  let stderr = '';
  let buf = '';
  let exited = null;
  const fail = (err) => {
    while (waiters.length) waiters.shift().reject(err);
  };
  child.stderr.on('data', (d) => (stderr = tail(stderr + d.toString(), 4000)));
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log.add(head(line, 500));
        continue;
      }
      if (msg.type === 'text') log.add(head(String(msg.text), 1500));
      else if (msg.type === 'tool') log.add(`🔧 ${msg.name}${msg.hint ? ` ${head(String(msg.hint), 200)}` : ''}`);
      else if (msg.type === 'ready') log.add(`Cursor agent ${msg.agentId ?? ''} (model ${cfg.model})`);
      else waiters.shift()?.resolve(msg);
    }
  });
  child.on('error', (err) => fail(err));
  child.on('close', (code) => {
    exited = code;
    fail(new Error(`Cursor agent dừng (mã ${code}): ${tail(stderr.trim(), 800)}`));
  });
  const next = () => new Promise((resolve, reject) => (exited !== null ? reject(new Error(`Cursor agent dừng: ${tail(stderr.trim(), 800)}`)) : waiters.push({ resolve, reject })));
  const sendMsg = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);

  sendMsg({ type: 'key', apiKey: cfg.cursorApiKey });
  const started = await next();
  if (started.type === 'fatal') throw new Error(`Không khởi động được Cursor agent: ${started.message}`);

  const send = async (prompt) => {
    const deadline = Date.now() + cfg.agentTimeoutMs;
    let stopReason = null;
    const watch = setInterval(() => {
      if (stopReason) return;
      if (log.cancelled) stopReason = 'cancelled';
      else if (Date.now() > deadline) stopReason = 'timeout';
      if (stopReason) sendMsg({ type: 'cancel' });
    }, 3000);
    try {
      const done = next();
      sendMsg({ type: 'send', prompt });
      const result = await done;
      if (stopReason === 'cancelled') throw new CancelledError();
      if (stopReason === 'timeout') throw new Error(`Cursor agent quá ${Math.round(cfg.agentTimeoutMs / 60_000)} phút`);
      if (result.type === 'error') throw new Error(`Cursor agent lỗi: ${result.message}`);
      if (result.status === 'error') throw new Error(`Cursor agent lỗi (run ${result.id})`);
      return result.text ?? '';
    } finally {
      clearInterval(watch);
    }
  };
  try {
    return await fn(send);
  } finally {
    if (exited === null) {
      sendMsg({ type: 'close' });
      const t = setTimeout(() => child.kill('SIGKILL'), 15_000);
      await new Promise((r) => (exited !== null ? r() : child.once('close', r)));
      clearTimeout(t);
    }
    await reapSandbox();
  }
}

/** Sandbox: kill whatever the sandbox user left running (dev servers, watchers, anything spawned by an agent). */
async function reapSandbox() {
  const sb = sandbox.cfg;
  if (!sb) return;
  await new Promise((resolve) => execFile(sb.sudo, ['-n', '-u', sb.user, '--', '/bin/kill', '-KILL', '-1'], () => resolve()));
}

const AGENT_RULES = `Rules:
- You are working in a git worktree of the project. Do NOT commit, push, create branches, or change git config.
- Do NOT read, create, or edit .env files, wp-config.php, keys, or credentials. Do NOT run deploys, migrations or anything against real databases or external services.
- Keep the change minimal and in the style of the surrounding code. Do not add dependencies unless the task needs it.
- Add or update a test when it is practical.`;

function siteIntro(task, name) {
  const s = task.site ?? {};
  const declared = (s.projects ?? []).find((p) => p.name === name);
  return [
    `Site: ${s.name ?? s.slug} (${s.siteUrl ?? ''})${s.stack ? `, stack: ${s.stack}` : ''}.`,
    s.brief ? `About the site: ${s.brief}` : '',
    `Project: ${name}${declared?.description ? ` — ${declared.description}` : ''}.`,
  ].filter(Boolean);
}

function fixPrompt(task, p) {
  const input = task.input ?? {};
  const declared = (task.site?.projects ?? []).find((x) => x.name === p.name);
  const files = (input.files ?? []).map((f) => repoRelative(f, declared?.pathPrefixes));
  const checks = p.checks.map((c) => `\`${c.cmd} ${c.args.join(' ')}\``).join(', ');
  return [
    ...siteIntro(task, p.name),
    `Task: ${task.title}`,
    '',
    String(input.prompt ?? ''),
    files.length ? `\nFiles to look at first (repo-relative): ${files.join(', ')}` : '',
    input.reviewerNote ? `\nThe reviewer rejected a previous attempt with this note, address it: ${input.reviewerNote}` : '',
    '',
    'Find the root cause in the source code and fix it.',
    checks ? `The change must pass ${checks}; run them before you finish.` : 'There are no automated checks configured; verify your change carefully.',
    AGENT_RULES,
    '',
    'End with a short summary in Vietnamese (markdown): **Nguyên nhân**, **Thay đổi**, **Cách kiểm chứng**.',
  ].join('\n');
}

// ---- handlers --------------------------------------------------------------------------------

async function handleCodeFix(cfg, task, log) {
  const name = resolveProject(cfg.sites[task.site.slug], task.site, task.input);
  const p = projectCfg(cfg, task, name);
  const wt = await createWorktree(cfg, p, task, log, { branch: branchName(task) });
  try {
    let checks = [];
    const agentSummary = await withAgent(cfg, wt.dir, log, async (send) => {
      let summary = await send(fixPrompt(task, p));
      for (let attempt = 0; ; attempt++) {
        log.throwIfCancelled();
        checks = await runChecks(cfg, wt, log);
        const failed = checks.filter((c) => !c.ok);
        if (!failed.length || attempt >= cfg.fixAttempts) break;
        log.add(`Kiểm tra thất bại (${failed.map((c) => c.name).join(', ')}), yêu cầu agent sửa tiếp…`);
        summary = await send(
          `These checks fail after your change:\n\n${failed.map((c) => `### ${c.name}\n\`\`\`\n${tail(c.output, 6000)}\n\`\`\``).join('\n\n')}\n\nFix them (if a failure is unrelated to your change and also fails on the base branch, say so instead). End with the same Vietnamese summary.`,
        );
      }
      return summary;
    });
    const change = await commitChanges(wt, `fix(ops): ${head(task.title, 60)}\n\nNAMBIN Ops task ${task.id}`);
    if (!change) return { status: 'done', summary: `Agent không thay đổi code.\n\n${agentSummary}`, checks, data: { project: name } };
    if (change.diff.length > DIFF_MAX) throw new Error(`Diff quá lớn (${change.diff.length} ký tự)`);
    await publishBranch(cfg, task, wt, log);
    const failed = checks.filter((c) => !c.ok);
    return {
      status: 'needs_review',
      summary: [
        failed.length ? `⚠️ Còn ${failed.length} bước kiểm tra lỗi: ${failed.map((c) => c.name).join(', ')}` : checks.length ? '✅ Các bước kiểm tra đều qua.' : '⚠️ Dự án chưa có bước kiểm tra tự động.',
        '',
        agentSummary,
        '',
        '```',
        change.stat,
        '```',
      ].join('\n'),
      diff: change.diff,
      branch: wt.branch,
      baseRef: wt.baseSha,
      checks,
      data: { project: name, files: change.files },
    };
  } finally {
    await removeWorktree(wt);
  }
}

async function handleCodeReview(cfg, task, log) {
  const input = task.input ?? {};
  const name = resolveProject(cfg.sites[task.site.slug], task.site, input);
  const p = projectCfg(cfg, task, name);
  const range = input.ref || 'HEAD~1..HEAD';
  if (!isSafeRef(range)) throw new Error(`Ref không hợp lệ: ${range}`);
  await run('git', ['fetch', '--quiet', p.remote], { cwd: p.path, timeoutMs: 120_000 });
  const headRef = range.includes('..') ? range.split(/\.{2,3}/)[1] || 'HEAD' : range;
  const diffArgs = range.includes('..') ? [range] : [`${range}~1`, range];
  // CI clones are shallow: fetch the whole history when the range reaches past it.
  const ends = range.includes('..') ? range.split(/\.{2,3}/).filter(Boolean) : [`${range}~1`];
  if (existsSync(path.join(p.path, '.git', 'shallow'))) {
    let missing = false;
    for (const ref of ends) if (!(await refExists(p.path, ref))) missing = true;
    if (missing) {
      log.add('Lấy thêm lịch sử git (clone nông)…');
      await run('git', ['fetch', '--quiet', '--unshallow', p.remote], { cwd: p.path, timeoutMs: 300_000 });
    }
  }
  const diff = await git(p.path, ['diff', ...diffArgs]);
  if (!diff.trim()) return { status: 'done', summary: `Không có thay đổi trong \`${range}\`.`, data: { project: name, ref: range } };
  const stat = await git(p.path, ['diff', '--stat', ...diffArgs]);
  const wt = await createWorktree(cfg, p, task, log, { at: headRef, install: false });
  try {
    const review = await withAgent(cfg, wt.dir, log, (send) =>
      send(
        [
          ...siteIntro(task, name),
          `Review this change (range \`${range}\`). The working tree is checked out at the new version; read the surrounding code to judge it.`,
          input.focus ? `Focus on: ${input.focus}` : '',
          '',
          '```diff',
          head(diff, 150_000),
          '```',
          '',
          'Do NOT modify any file. Look for bugs, regressions, security issues (auth, injection, secrets, data exposure), missing validation, performance problems and missing tests.',
          'Answer in Vietnamese markdown with these sections: **Tóm tắt**, **Vấn đề** (each: mức độ cao/trung bình/thấp, `file:line`, mô tả, đề xuất sửa), **Bảo mật**, **Test còn thiếu**, **Kết luận** (merge được / cần sửa).',
        ].join('\n'),
      ),
    );
    return { status: 'done', summary: `${review}\n\n\`\`\`\n${stat}\n\`\`\``, data: { project: name, ref: range } };
  } finally {
    await removeWorktree(wt);
  }
}

async function handleDependencyUpdate(cfg, task, log) {
  const input = task.input ?? {};
  const wanted = Array.isArray(input.packages) ? input.packages.map(String) : [];
  const branch = branchName(task);
  const reports = [];
  const checks = [];
  const diffs = [];
  let baseRef = null;
  for (const name of projectsFor(cfg.sites[task.site.slug], input)) {
    log.throwIfCancelled();
    const p = projectCfg(cfg, task, name);
    const pm = PM[p.packageManager];
    if (!pm) {
      reports.push({ project: name, outdated: [], note: `Chưa hỗ trợ trình quản lý gói "${p.packageManager ?? 'không rõ'}"` });
      continue;
    }
    const outdated = pm.parseOutdated((await run(pm.outdated[0], pm.outdated.slice(1), { cwd: p.path, timeoutMs: 120_000 })).out);
    const declared = declaredPackages(p.path, p.packageManager);
    const targets = wanted.filter((x) => declared.has(x));
    const inRange = outdated.filter((o) => o.update !== o.current);
    reports.push({ project: name, outdated });
    log.add(`${name}: ${outdated.length} gói có bản mới, ${inRange.length} cập nhật được trong phạm vi`);
    if (wanted.length ? !targets.length : !inRange.length) continue;

    const wt = await createWorktree(cfg, p, task, log, { branch });
    try {
      const cmd = pm.update(targets);
      log.add(cmd.join(' '));
      const res = await run(cmd[0], cmd.slice(1), { cwd: wt.dir, timeoutMs: 10 * 60_000 });
      if (res.code !== 0) throw new Error(`${cmd.join(' ')} thất bại:\n${tail(res.out, 2000)}`);
      checks.push(...(await runChecks(cfg, wt, log)));
      const change = await commitChanges(wt, `chore(deps): ${targets.length ? `update ${targets.join(', ')}` : 'update dependencies in range'}\n\nNAMBIN Ops task ${task.id}`);
      if (change) {
        await publishBranch(cfg, task, wt, log);
        diffs.push(change.diff);
        baseRef = baseRef ?? wt.baseSha;
      }
    } finally {
      await removeWorktree(wt);
    }
  }

  const lines = ['## Thư viện có bản mới', ''];
  for (const r of reports) {
    lines.push(`### ${r.project}`, '');
    if (r.note) lines.push(r.note, '');
    else if (!r.outdated.length) lines.push('Tất cả đã mới nhất.', '');
    else {
      lines.push('| Gói | Hiện tại | Trong phạm vi | Mới nhất |', '|---|---|---|---|');
      for (const o of r.outdated) lines.push(`| ${o.name} | ${o.current} | ${o.update} | ${o.latest}${o.major ? ' ⚠️ major' : ''} |`);
      lines.push('');
    }
  }
  const failed = checks.filter((c) => !c.ok);
  if (diffs.length) lines.push(failed.length ? `⚠️ Kiểm tra lỗi sau khi cập nhật: ${failed.map((c) => c.name).join(', ')}` : '✅ Đã cập nhật, các bước kiểm tra đều qua.');
  const diff = diffs.join('\n');
  if (diff.length > DIFF_MAX) throw new Error(`Diff quá lớn (${diff.length} ký tự)`);
  return { status: diffs.length ? 'needs_review' : 'done', summary: lines.join('\n'), diff: diffs.length ? diff : null, branch: diffs.length ? branch : null, baseRef, checks, data: { projects: reports } };
}

async function scanSecrets(repo) {
  const findings = [];
  for (const p of SECRET_PATTERNS) {
    const res = await run('git', ['grep', '-nIE', '--no-color', '-e', p.re, '--', '.', ':!*.lock', ':!*lock.json', ':!**/*.test.*', ':!test/**', ':!tests/**'], { cwd: repo });
    for (const line of res.stdout.split('\n').filter(Boolean).slice(0, 20)) {
      const [file, lineNo] = line.split(':');
      findings.push({ type: p.name, file, line: Number(lineNo) || 0 });
    }
  }
  const tracked = (await run('git', ['ls-files'], { cwd: repo })).stdout.split('\n').filter(Boolean);
  for (const file of forbiddenPaths(tracked)) findings.push({ type: 'file nhạy cảm bị commit', file, line: 0 });
  return findings;
}

async function handleSecurityScan(cfg, task, log) {
  const projects = [];
  for (const name of projectsFor(cfg.sites[task.site.slug], task.input ?? {})) {
    log.throwIfCancelled();
    const p = projectCfg(cfg, task, name);
    const pm = PM[p.packageManager];
    let advisories = [];
    if (pm) {
      log.add(`${pm.audit.join(' ')} (${name})…`);
      advisories = pm.parseAudit((await run(pm.audit[0], pm.audit.slice(1), { cwd: p.path, timeoutMs: 120_000 })).out);
    } else log.add(`${name}: chưa hỗ trợ audit cho "${p.packageManager ?? 'không rõ'}", chỉ quét bí mật`);
    const secrets = await scanSecrets(p.path);
    const counts = countSeverities(advisories);
    log.add(`${name}: ${advisories.length} cảnh báo thư viện (critical ${counts.critical}, high ${counts.high}), ${secrets.length} nghi vấn lộ bí mật`);
    projects.push({ project: name, packageManager: p.packageManager, counts, advisories, secrets });
  }
  const lines = ['## Kết quả quét bảo mật', ''];
  for (const p of projects) {
    const c = p.counts;
    lines.push(`### ${p.project}`, '', `Thư viện: **${c.critical} critical**, **${c.high} high**, ${c.moderate} moderate, ${c.low} low.`, '');
    if (p.advisories.length) {
      lines.push('| Mức | Gói | Lỗ hổng | Phiên bản bị ảnh hưởng |', '|---|---|---|---|');
      for (const a of p.advisories.slice(0, 30)) lines.push(`| ${a.severity} | ${a.package} | ${a.url ? `[${a.title.replace(/\|/g, '/')}](${a.url})` : a.title.replace(/\|/g, '/')} | ${a.vulnerableVersions} |`);
      if (p.advisories.length > 30) lines.push(`| … | | còn ${p.advisories.length - 30} mục | |`);
      lines.push('', 'Tạo tác vụ "Cập nhật thư viện" cho các gói trên để agent đề xuất bản vá.', '');
    }
    if (p.secrets.length) {
      lines.push('**Nghi vấn lộ bí mật trong code đã commit** (giá trị không hiển thị):', '');
      for (const s of p.secrets) lines.push(`- ${s.type}: \`${s.file}${s.line ? `:${s.line}` : ''}\``);
      lines.push('');
    } else lines.push('Không thấy bí mật bị commit.', '');
  }
  const urgent = projects.reduce((n, p) => n + p.counts.critical + p.counts.high + p.secrets.length, 0);
  lines.unshift(urgent ? `⚠️ Có ${urgent} vấn đề mức cao cần xử lý.\n` : '✅ Không có vấn đề mức cao.\n');
  return { status: 'done', summary: lines.join('\n'), data: { projects: projects.map((p) => ({ ...p, advisories: p.advisories.slice(0, 100) })), urgent } };
}

const HANDLERS = { code_fix: handleCodeFix, code_review: handleCodeReview, dependency_update: handleDependencyUpdate, security_scan: handleSecurityScan };

async function handleTask(cfg, api, task) {
  try {
    await handleTaskInner(cfg, api, task);
  } finally {
    await reapSandbox();
  }
}

async function handleTaskInner(cfg, api, task) {
  const log = new TaskLog(api, task.id);
  log.add(`Bắt đầu ${task.kind} cho ${task.site?.slug}: ${task.title}`);
  try {
    if (!task.site || !cfg.sites[task.site.slug]) throw new Error(`Máy runner không cấu hình site ${task.site?.slug}`);
    const handler = HANDLERS[task.kind];
    if (!handler) throw new Error(`Runner không hỗ trợ loại tác vụ ${task.kind}`);
    const result = await handler(cfg, task, log);
    log.throwIfCancelled();
    log.add(`Xong: ${result.status}`);
    await log.close();
    await api.result(task.id, result);
    stats.tasks += 1;
    if (result.status === 'failed') stats.failed += 1;
  } catch (err) {
    if (err instanceof CancelledError || log.cancelled) {
      log.add('Đã dừng vì tác vụ bị huỷ.');
      await log.close();
      return;
    }
    stats.tasks += 1;
    stats.failed += 1;
    log.add(`Lỗi: ${err.message}`);
    await log.close();
    await api.result(task.id, { status: 'failed', summary: `Runner gặp lỗi khi chạy ${task.kind}.`, error: head(String(err.message), 3900) }).catch((e) => console.error(`Không gửi được kết quả lỗi: ${e.message}`));
  }
}

/**
 * `merge` (after an admin approved the diff): wait for the PR's CI, squash-merge only if every
 * check passes. The merge commit on the base branch is what starts the repo's own release/deploy.
 */
async function mergeWhenGreen(p, branch, log) {
  for (let attempt = 0; ; attempt++) {
    // Checks show up a few seconds after the PR is opened or the branch is pushed.
    await sleep(15_000);
    log.add(`Chờ CI của PR ${branch} (${p.name})…`);
    const res = await run('gh', ['pr', 'checks', branch, '--watch', '--interval', '20', '--fail-fast'], { cwd: p.path, timeoutMs: 40 * 60_000 });
    if (res.code === 0) break;
    if (/no checks reported/i.test(res.out) && attempt < 5) continue;
    throw new Error(`CI của PR không qua, không merge:\n${tail(res.out, 1500)}`);
  }
  log.add(`✔ CI xanh, merge ${branch} vào ${p.baseBranch} (${p.name})`);
  const merged = await run('gh', ['pr', 'merge', branch, '--squash', '--delete-branch'], { cwd: p.path, timeoutMs: 120_000 });
  if (merged.code !== 0) throw new Error(`Merge thất bại: ${tail(merged.out, 1000)}`);
}

/** After approval: push the branch from whichever project of the site has it; optional PR (and merge). */
async function applyTask(cfg, api, task) {
  const log = new TaskLog(api, task.id);
  try {
    if (!isAgentBranch(task.branch)) throw new Error(`Nhánh không hợp lệ hoặc không có: ${task.branch ?? '(trống)'}`);
    const site = cfg.sites[task.site?.slug];
    if (!site) throw new Error(`Máy runner không cấu hình site ${task.site?.slug}`);
    const notes = [];
    for (const p of Object.values(site.projects)) {
      if (!existsSync(path.join(p.path, '.git'))) continue;
      if (!(await refExists(p.path, `refs/heads/${task.branch}`))) {
        // Made by another run (publishBranch): fetch it, if this repo has it at all.
        if (!site.publishBranch) continue;
        const fetched = await run('git', ['fetch', '--quiet', p.remote, `+refs/heads/${task.branch}:refs/heads/${task.branch}`], { cwd: p.path, timeoutMs: 120_000 });
        if (fetched.code !== 0) continue;
      }
      log.add(`git push ${p.remote} ${task.branch} (${p.name})`);
      await git(p.path, ['push', '-u', p.remote, `${task.branch}:${task.branch}`], { timeoutMs: 180_000 });
      let note = `${p.name}: đã đẩy nhánh ${task.branch} lên ${p.remote}`;
      if (site.createPr) {
        const body = `Tạo bởi NAMBIN Ops (tác vụ ${task.id}, site ${site.slug}).${task.reviewNote ? `\n\nGhi chú duyệt: ${task.reviewNote}` : ''}`;
        // Idempotent: a re-run after a lost "applied" report reuses the PR it opened.
        let url = (await run('gh', ['pr', 'view', task.branch, '--json', 'url,state', '-q', 'select(.state=="OPEN").url'], { cwd: p.path, timeoutMs: 60_000 })).stdout.trim();
        if (!url) {
          const pr = await run('gh', ['pr', 'create', '--head', task.branch, '--base', p.baseBranch, '--title', head(task.title, 120), '--body', body], { cwd: p.path, timeoutMs: 120_000 });
          if (pr.code === 0) url = pr.stdout.trim().split('\n').pop();
          else note += ` (không tạo được PR: ${tail(pr.out, 300)})`;
        }
        if (url) note += `, PR: ${url}`;
        if (url && site.merge) {
          await mergeWhenGreen(p, task.branch, log);
          note += `, CI xanh → đã merge vào ${p.baseBranch} (deploy chạy tự động)`;
        }
      }
      notes.push(note);
    }
    if (!notes.length) throw new Error(`Không tìm thấy nhánh ${task.branch} ở repo nào của site ${site.slug} trên máy này`);
    await log.close();
    await api.applied(task.id, true, notes.join('\n'));
    stats.applied += 1;
  } catch (err) {
    stats.applyFailed += 1;
    log.add(`Áp dụng thất bại: ${err.message}`);
    await log.close();
    await api.applied(task.id, false, String(err.message)).catch((e) => console.error(`Không báo được kết quả áp dụng: ${e.message}`));
  }
}

// ---- main ------------------------------------------------------------------------------------

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const configFile = path.resolve(argValue('--config') ?? process.env.RUNNER_CONFIG ?? 'runner.config.json');
  loadEnvFile(path.join(path.dirname(configFile), '.env'));
  const cfg = readConfig(configFile);
  setGitToken(cfg.gitToken);
  setSandbox(cfg.sandbox);
  redact = makeRedactor([cfg.token, cfg.gitToken, cfg.cursorApiKey, cfg.llm?.apiKey, ...SECRET_ENV.map((k) => process.env[k])]);
  // The Cursor agent runs in this process and its tools inherit process.env: no secrets in it.
  for (const key of Object.keys(process.env)) if (isHiddenEnv(key)) delete process.env[key];
  if (!cfg.token) {
    console.error('Thiếu NAMBIN_OPS_RUNNER_TOKEN. Tạo runner trong NAMBIN Ops → Runner, rồi điền token vào .env cạnh runner.config.json');
    process.exit(1);
  }
  const api = apiClient(cfg);
  let ping;
  try {
    ping = await api.ping();
  } catch (err) {
    console.error(`Không kết nối được ${cfg.opsUrl}: ${err.message}`);
    process.exit(1);
  }
  const engineInfo = cfg.engines.map((e) => (e === 'opencode' ? `opencode/${cfg.llm.model}@${new URL(cfg.llm.baseUrl).host}` : `cursor/${cfg.model}`)).join(' → ');
  console.log(`Runner "${ping.runner.name}" → ${cfg.opsUrl} · agent ${engineInfo || '(chưa có: cần CURSOR_API_KEY hoặc AGENT_LLM_*)'}`);
  const remote = new Map(ping.sites.map((s) => [s.slug, s]));
  for (const site of Object.values(cfg.sites)) {
    const r = remote.get(site.slug);
    const status = !r ? '✘ token không có quyền với site này / site không tồn tại' : '✔';
    console.log(`  ${status} ${site.slug}`);
    for (const p of Object.values(site.projects)) {
      const repo = existsSync(path.join(p.path, '.git'));
      const known = r ? r.projects.includes(p.name) : false;
      console.log(`     ${repo ? '✔' : '✘'} ${p.name} → ${p.path} (${p.packageManager ?? '?'}, ${p.checks.length} check)${r && !known ? ' ⚠️ site chưa khai báo dự án này' : ''}`);
    }
  }
  if (process.argv[2] === 'ping') return;

  const once = process.argv.includes('--once');
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('Đang dừng sau tác vụ hiện tại (Ctrl+C lần nữa để thoát ngay)…');
  });
  let failures = 0;
  while (!stopping) {
    try {
      // Pushing is idempotent, so a task whose "applied" report got lost is simply pushed again.
      for (const task of (await api.approved()).items ?? []) await applyTask(cfg, api, task);
      const { task } = await api.claim();
      failures = 0;
      if (task) {
        await handleTask(cfg, api, task);
        continue;
      }
    } catch (err) {
      failures += 1;
      stats.errors += 1;
      if (once && failures >= 3) break;
      const wait = Math.min(cfg.pollMs * 2 ** failures, 5 * 60_000);
      console.warn(`Lỗi khi hỏi việc (${err.message}), thử lại sau ${Math.round(wait / 1000)}s`);
      if (err.status === 401) console.warn('Token runner không hợp lệ hoặc đã bị thu hồi.');
      await sleep(wait);
      continue;
    }
    if (once) break;
    await sleep(cfg.pollMs);
  }
  if (once) {
    // One machine-readable line for the CI reporter (src/report.mjs).
    console.log(`RUN_SUMMARY ${JSON.stringify(stats)}`);
    if (stats.failed || stats.applyFailed || stats.errors) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
