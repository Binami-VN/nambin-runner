/**
 * Pure logic of the NAMBIN Ops runner (no I/O except reading the config file), so it can be
 * unit-tested: config, project resolution, branch/ref safety, package-manager output parsers.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RUNNER_KINDS = ['code_fix', 'code_review', 'dependency_update', 'security_scan'];
export const DIFF_MAX = 1_000_000;
export const CHECK_OUTPUT_MAX = 20_000;

export const head = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
export const tail = (s, n) => (s.length > n ? `…${s.slice(-n)}` : s);

// ---- config ----------------------------------------------------------------------------------

export function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const PM_FILES = [
  ['bun', ['bun.lock', 'bun.lockb']],
  ['pnpm', ['pnpm-lock.yaml']],
  ['yarn', ['yarn.lock']],
  ['npm', ['package-lock.json']],
  ['composer', ['composer.lock', 'composer.json']],
  ['pip', ['requirements.txt', 'pyproject.toml']],
  ['gradle', ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']],
  ['maven', ['pom.xml']],
];

/** Reads a regular file; refuses symlinks (a sandboxed install script could point one at a secret). */
export function readRegular(file) {
  if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} là symlink`);
  return readFileSync(file, 'utf8');
}

/** Shell-free check commands derived from package.json scripts (typecheck → lint → test). */
export function autoChecks(dir, pm) {
  const file = path.join(dir, 'package.json');
  if (!['bun', 'pnpm', 'yarn', 'npm'].includes(pm) || !existsSync(file)) return [];
  let scripts = {};
  try {
    scripts = JSON.parse(readRegular(file)).scripts ?? {};
  } catch {
    return [];
  }
  // Scripts that watch or open a browser would hang a headless runner; declare those by hand.
  const interactive = /no test specified|\bng test\b|karma|nodemon|--watch(?!=false)|\bvitest(?!\s+run)\b|\bjest\b.*--watch/;
  return ['typecheck', 'lint', 'test']
    .filter((s) => typeof scripts[s] === 'string' && !interactive.test(scripts[s]))
    .map((s) => ({ name: s, cmd: pm, args: ['run', s] }));
}

/** Default branch of `remote` as recorded by `git clone` (`.git/refs/remotes/<remote>/HEAD`). */
export function remoteDefaultBranch(dir, remote = 'origin') {
  try {
    const m = /^ref: refs\/remotes\/[^/]+\/(.+)$/m.exec(readFileSync(path.join(dir, '.git', 'refs', 'remotes', remote, 'HEAD'), 'utf8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Every git repo directly inside `dir` (a folder holding many repos), filtered by
 * `include` / `exclude` (folder names; `*` wildcards allowed).
 */
export function discoverRepos(dir, { include, exclude } = {}) {
  if (!existsSync(dir)) throw new Error(`workspace không tồn tại: ${dir}`);
  const toRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const inc = (include ?? []).map(toRe);
  const exc = (exclude ?? []).map(toRe);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && existsSync(path.join(dir, d.name, '.git')))
    .map((d) => d.name)
    .filter((n) => (!inc.length || inc.some((r) => r.test(n))) && !exc.some((r) => r.test(n)))
    .sort();
}

/** Guess the package manager from lockfiles. */
export function detectPackageManager(dir) {
  for (const [pm, files] of PM_FILES) if (files.some((f) => existsSync(path.join(dir, f)))) return pm;
  return existsSync(path.join(dir, 'package.json')) ? 'npm' : null;
}

/** Default install command per package manager (lockfile-exact, like CI). */
export function defaultInstall(pm) {
  switch (pm) {
    case 'bun':
      return ['bun', 'install', '--frozen-lockfile'];
    case 'pnpm':
      return ['pnpm', 'install', '--frozen-lockfile'];
    case 'yarn':
      return ['yarn', 'install', '--frozen-lockfile'];
    case 'npm':
      return ['npm', 'ci'];
    case 'composer':
      return ['composer', 'install', '--no-interaction', '--no-progress'];
    default:
      return null;
  }
}

function normCheck(c, i) {
  if (Array.isArray(c)) return { name: `check${i + 1}`, cmd: c[0], args: c.slice(1) };
  if (!c || typeof c.cmd !== 'string') throw new Error(`check #${i + 1}: cần { name, cmd, args }`);
  return { name: String(c.name ?? c.cmd), cmd: c.cmd, args: Array.isArray(c.args) ? c.args.map(String) : [] };
}

/**
 * `runner.config.json`:
 * {
 *   "opsUrl": "https://ops.example.com",
 *   "name": "build-mac",
 *   "sites": {
 *     "nambin": {
 *       "projects": {
 *         "api": { "path": "~/src/nambin/nambin-api", "checks": [{ "name": "test", "cmd": "bun", "args": ["test"] }] },
 *         "web": { "path": "~/src/nambin/nambin-web", "baseBranch": "develop" }
 *       }
 *     }
 *   }
 * }
 * Secrets stay in env: NAMBIN_OPS_RUNNER_TOKEN, CURSOR_API_KEY.
 */
export function readConfig(file, env = process.env) {
  if (!existsSync(file)) throw new Error(`Không thấy file cấu hình ${file} (xem runner.config.example.json)`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const base = path.dirname(path.resolve(file));
  const expand = (p) => path.resolve(base, String(p).replace(/^~(?=$|\/)/, os.homedir()));
  const defaults = raw.defaults ?? {};
  const sites = {};
  for (const [slug, s] of Object.entries(raw.sites ?? {})) {
    if (!/^[a-z0-9-]{1,50}$/.test(slug)) throw new Error(`slug site không hợp lệ: ${slug}`);
    const projects = {};
    // `workspace`: a folder of repos — each git repo inside becomes a project named after its
    // folder. Entries in `projects` with the same name override (or add) settings.
    const declared = { ...(s.projects ?? {}) };
    if (s.workspace) {
      const root = expand(s.workspace);
      for (const name of discoverRepos(root, s)) {
        declared[name] = { path: path.join(root, name), ...(s.projectDefaults ?? {}), ...(declared[name] ?? {}) };
      }
    }
    for (const [name, p] of Object.entries(declared)) {
      if (!p?.path) throw new Error(`${slug}/${name}: thiếu "path"`);
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error(`${slug}: tên dự án không hợp lệ: ${name}`);
      const dir = expand(p.path);
      const pm = p.packageManager ?? detectPackageManager(dir);
      const auto = p.autoChecks ?? s.autoChecks ?? Boolean(s.workspace);
      projects[name] = {
        name,
        path: dir,
        baseBranch:
          p.baseBranch ?? s.baseBranch ?? remoteDefaultBranch(dir, p.remote ?? s.remote ?? defaults.remote ?? 'origin') ?? defaults.baseBranch ?? 'main',
        remote: p.remote ?? s.remote ?? defaults.remote ?? 'origin',
        packageManager: pm,
        install: p.install === false ? null : Array.isArray(p.install) ? p.install.map(String) : defaultInstall(pm),
        checks: p.checks ? p.checks.map(normCheck) : auto ? autoChecks(dir, pm) : [],
        copyFiles: (p.copyFiles ?? []).map(String).filter((f) => !f.includes('..') && !path.isAbsolute(f)),
      };
    }
    const createPr = Boolean(s.createPr ?? defaults.createPr ?? false);
    sites[slug] = {
      slug,
      projects,
      createPr,
      // Push the review branch as soon as the diff is ready (runner without a persistent disk).
      publishBranch: Boolean(s.publishBranch ?? defaults.publishBranch ?? false),
      // After approval: wait for the PR's CI and squash-merge when green. Needs createPr.
      merge: createPr && Boolean(s.merge ?? defaults.merge ?? false),
    };
  }
  if (!Object.keys(sites).length) throw new Error('Cấu hình chưa có site nào trong "sites"');
  const kinds = (env.RUNNER_KINDS ?? raw.kinds ?? []).toString().split(',').map((k) => k.trim()).filter((k) => RUNNER_KINDS.includes(k));
  return {
    opsUrl: String(env.NAMBIN_OPS_URL || raw.opsUrl || 'http://localhost:4100').replace(/\/+$/, ''),
    token: env.NAMBIN_OPS_RUNNER_TOKEN || '',
    name: String(env.RUNNER_NAME || raw.name || os.hostname()).slice(0, 100),
    worktreeDir: expand(raw.worktreeDir ?? path.join(os.homedir(), '.nambin-ops-runner', 'worktrees')),
    pollMs: Math.max(3000, Number(env.POLL_MS ?? raw.pollMs) || 15_000),
    kinds: kinds.length ? kinds : undefined,
    cursorApiKey: env.CURSOR_API_KEY || '',
    /** GitHub token for fetch/push/PR/merge when the machine has no git credentials of its own. */
    gitToken: env.GIT_PUSH_TOKEN || '',
    /** Any OpenAI-compatible API (OpenRouter, Groq, Gemini, Ollama, vLLM…) driven by OpenCode. */
    llm: llmConfig(env, raw),
    opencodeBin: String(env.OPENCODE_BIN || raw.opencodeBin || 'opencode'),
    engines: agentEngines(env.AGENT_ENGINES ?? raw.engines, { cursor: Boolean(env.CURSOR_API_KEY), opencode: Boolean(llmConfig(env, raw)) }),
    model: env.CURSOR_MODEL || raw.model || 'composer-2.5',
    sandbox: sandboxConfig(env),
    fixAttempts: Math.max(0, Number(env.FIX_ATTEMPTS ?? raw.fixAttempts ?? 1)),
    checkTimeoutMs: Number(raw.checkTimeoutMs) || 15 * 60_000,
    agentTimeoutMs: Number(raw.agentTimeoutMs) || 45 * 60_000,
    sites,
  };
}

/**
 * RUNNER_SANDBOX_USER (CI): agents, project checks and installs run as this unprivileged user
 * (`sudo -u`), so code written by an agent can never read the runner's memory, environment or
 * files (Ops token, GitHub token). Only git/gh run as the runner itself. Needs sudoers
 * `<runner> ALL=(<user>) NOPASSWD:SETENV: ALL` and `setfacl`.
 */
export function sandboxConfig(env) {
  const user = String(env.RUNNER_SANDBOX_USER || '').trim();
  if (!user) return null;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error(`RUNNER_SANDBOX_USER không hợp lệ: ${user}`);
  return {
    user,
    home: String(env.RUNNER_SANDBOX_HOME || `/home/${user}`),
    sudo: String(env.RUNNER_SANDBOX_SUDO || 'sudo'),
    /** `0`: skip setfacl (tests on machines without ACLs). */
    acl: env.RUNNER_SANDBOX_ACL !== '0',
  };
}

/**
 * OpenAI-compatible endpoint for the OpenCode agent: AGENT_LLM_BASE_URL (…/v1), AGENT_LLM_API_KEY,
 * AGENT_LLM_MODEL (the id the API expects, e.g. `qwen/qwen3-coder:free`). null when incomplete.
 * The key may be empty for local servers (Ollama, vLLM) but the URL and model are required.
 */
export function llmConfig(env, raw = {}) {
  const baseUrl = String(env.AGENT_LLM_BASE_URL || raw.llm?.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(env.AGENT_LLM_MODEL || raw.llm?.model || '').trim();
  if (!baseUrl || !model) return null;
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error(`AGENT_LLM_BASE_URL không hợp lệ: ${baseUrl}`);
  // `responses`: endpoints that only speak /v1/responses (OpenAI's newest models); default chat/completions.
  const api = String(env.AGENT_LLM_API || raw.llm?.api || 'chat').trim() === 'responses' ? 'responses' : 'chat';
  return { baseUrl, model, apiKey: String(env.AGENT_LLM_API_KEY || ''), api };
}

/**
 * Which coding agents to try, in order. Default: OpenCode (custom API) first, Cursor
 * as fallback. Engines without a key are dropped.
 */
export function agentEngines(order, has) {
  const wanted = (order ? String(Array.isArray(order) ? order.join(',') : order) : 'opencode,cursor')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e, i, all) => (e === 'cursor' || e === 'opencode') && all.indexOf(e) === i);
  return wanted.filter((e) => has[e]);
}

// ---- projects --------------------------------------------------------------------------------

/**
 * Which local project a code task targets: explicit `input.project`, else the project whose
 * path prefixes (declared on the site in Ops) match the files, else the first one configured.
 */
export function resolveProject(siteCfg, siteInfo, input = {}) {
  const local = Object.keys(siteCfg.projects);
  if (!local.length) throw new Error(`Runner chưa cấu hình dự án nào cho site ${siteCfg.slug}`);
  if (input.project && input.project !== 'all') {
    if (!siteCfg.projects[input.project]) throw new Error(`Máy runner không có dự án "${input.project}" của site ${siteCfg.slug} (có: ${local.join(', ')})`);
    return input.project;
  }
  const declared = siteInfo?.projects ?? [];
  for (const f of input.files ?? []) {
    const hit = declared.find((p) => local.includes(p.name) && (p.pathPrefixes ?? []).some((pre) => f.startsWith(pre)));
    if (hit) return hit.name;
  }
  return local[0];
}

/** Projects for multi-project tasks (`dependency_update`, `security_scan`). */
export function projectsFor(siteCfg, input = {}) {
  if (input.project && input.project !== 'all') return siteCfg.projects[input.project] ? [input.project] : [];
  return Object.keys(siteCfg.projects);
}

/** Strips a declared prefix so the agent sees repo-relative paths. */
export function repoRelative(file, prefixes = []) {
  const p = prefixes.find((pre) => file.startsWith(pre));
  return p ? file.slice(p.length) : file;
}

// ---- safety ----------------------------------------------------------------------------------

export function branchName(task) {
  const site = String(task.site?.slug ?? 'site').replace(/[^a-z0-9-]/g, '');
  return `ops/${site}/${task.kind.replace(/_/g, '-')}-${task.id.slice(-8)}`;
}

/** Only branches the runner creates; anything else coming back from the server is refused. */
export function isAgentBranch(name) {
  return typeof name === 'string' && /^ops\/[a-z0-9-]+\/[a-z0-9-]+$/.test(name);
}

/** A git ref or range from task input; must not be mistaken for an option. */
export function isSafeRef(ref) {
  return typeof ref === 'string' && ref.length <= 200 && !ref.startsWith('-') && /^[\w./~^@{}-]+$/.test(ref) && !ref.includes('..-');
}

const FORBIDDEN_PATH = [
  /(^|\/)\.env(\.(?!example$)[^/]*)?$/,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /(^|\/)wp-config\.php$/,
];
// CI/deploy pipelines hold the deploy secrets: an agent change never touches them.
const PIPELINE_PATH = [/^\.github\/(workflows|deploy)\//];

/** Files an agent change may not touch: secrets and the CI/deploy pipeline. */
export function forbiddenChanges(files) {
  return files.filter((f) => [...FORBIDDEN_PATH, ...PIPELINE_PATH].some((re) => re.test(f)));
}

export function forbiddenPaths(files) {
  return files.filter((f) => FORBIDDEN_PATH.some((re) => re.test(f)));
}

export const SECRET_PATTERNS = [
  { name: 'private key', re: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
  { name: 'AWS access key', re: 'AKIA[0-9A-Z]{16}' },
  { name: 'GitHub token', re: 'gh[pousr]_[A-Za-z0-9]{36,}' },
  { name: 'Slack token', re: 'xox[abposr]-[A-Za-z0-9-]{10,}' },
  { name: 'OpenAI-style key', re: 'sk-[A-Za-z0-9_-]{32,}' },
  { name: 'NAMBIN Ops secret', re: 'bo[sr]_[A-Za-z0-9_-]{30,}' },
  { name: 'Mongo URI with password', re: 'mongodb(\\+srv)?://[^:/\\s"\'`]+:[^@\\s"\'`]{3,}@' },
];

// ---- package managers ------------------------------------------------------------------------

const RANK = { critical: 0, high: 1, moderate: 2, medium: 2, low: 3 };
const sortAdvisories = (items) => items.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));
const major = (v) => Number(String(v ?? '').replace(/^[^\d]*/, '').split('.')[0]) || 0;

function jsonFrom(output, open = '{') {
  const start = output.indexOf(open);
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
}

/** Commands and parsers per package manager. `null` = not supported for that step. */
export const PM = {
  bun: {
    outdated: ['bun', 'outdated'],
    audit: ['bun', 'audit', '--json'],
    update: (pkgs) => (pkgs.length ? ['bun', 'update', '--latest', ...pkgs] : ['bun', 'update']),
    parseOutdated(output) {
      const rows = [];
      for (const line of output.split('\n')) {
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        if (cells.length < 4 || cells[0] === 'Package' || /^-+$/.test(cells[0])) continue;
        const [name, current, update, latest] = cells;
        rows.push({ name: name.replace(/\s*\((dev|peer|optional)\)$/, ''), current, update, latest, major: major(latest) > major(current) });
      }
      return rows;
    },
    parseAudit(output) {
      const data = jsonFrom(output) ?? {};
      const items = [];
      for (const [pkg, advisories] of Object.entries(data)) {
        if (!Array.isArray(advisories)) continue;
        for (const a of advisories) items.push({ package: pkg, severity: String(a.severity ?? 'unknown'), title: String(a.title ?? ''), url: String(a.url ?? ''), vulnerableVersions: String(a.vulnerable_versions ?? '') });
      }
      return sortAdvisories(items);
    },
  },
  npm: {
    outdated: ['npm', 'outdated', '--json'],
    audit: ['npm', 'audit', '--json'],
    update: (pkgs) => (pkgs.length ? ['npm', 'install', ...pkgs.map((p) => `${p}@latest`)] : ['npm', 'update']),
    parseOutdated(output) {
      const data = jsonFrom(output) ?? {};
      return Object.entries(data).map(([name, o]) => ({ name, current: String(o.current ?? '-'), update: String(o.wanted ?? '-'), latest: String(o.latest ?? '-'), major: major(o.latest) > major(o.current) }));
    },
    parseAudit(output) {
      const data = jsonFrom(output) ?? {};
      const items = [];
      for (const [pkg, v] of Object.entries(data.vulnerabilities ?? {})) {
        const via = (v.via ?? []).find((x) => typeof x === 'object') ?? {};
        items.push({ package: pkg, severity: String(v.severity ?? 'unknown'), title: String(via.title ?? `qua ${(v.via ?? []).filter((x) => typeof x === 'string').join(', ')}`), url: String(via.url ?? ''), vulnerableVersions: String(v.range ?? '') });
      }
      return sortAdvisories(items);
    },
  },
  composer: {
    outdated: ['composer', 'outdated', '--direct', '--format=json', '--no-interaction'],
    audit: ['composer', 'audit', '--format=json', '--no-interaction'],
    update: (pkgs) => ['composer', 'update', ...pkgs, '--with-dependencies', '--no-interaction'],
    parseOutdated(output) {
      const data = jsonFrom(output) ?? {};
      return (data.installed ?? []).map((p) => ({ name: p.name, current: String(p.version ?? '-'), update: p['latest-status'] === 'semver-safe-update' ? String(p.latest) : String(p.version), latest: String(p.latest ?? '-'), major: major(p.latest) > major(p.version) }));
    },
    parseAudit(output) {
      const data = jsonFrom(output) ?? {};
      const items = [];
      for (const [pkg, list] of Object.entries(data.advisories ?? {})) {
        for (const a of Array.isArray(list) ? list : Object.values(list)) items.push({ package: pkg, severity: String(a.severity ?? 'unknown'), title: String(a.title ?? ''), url: String(a.link ?? ''), vulnerableVersions: String(a.affectedVersions ?? '') });
      }
      return sortAdvisories(items);
    },
  },
};
PM.pnpm = { ...PM.npm, outdated: ['pnpm', 'outdated', '--format', 'json'], audit: ['pnpm', 'audit', '--json'], update: (pkgs) => (pkgs.length ? ['pnpm', 'update', '--latest', ...pkgs] : ['pnpm', 'update']) };

export function countSeverities(advisories) {
  const counts = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const a of advisories) {
    const s = a.severity === 'medium' ? 'moderate' : a.severity;
    if (s in counts) counts[s] += 1;
  }
  return counts;
}

/** Declared dependency names (package.json / composer.json), to filter requested packages. */
export function declaredPackages(dir, pm) {
  try {
    if (pm === 'composer') {
      const c = JSON.parse(readRegular(path.join(dir, 'composer.json')));
      return new Set([...Object.keys(c.require ?? {}), ...Object.keys(c['require-dev'] ?? {})]);
    }
    const p = JSON.parse(readRegular(path.join(dir, 'package.json')));
    return new Set([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

// ---- redaction -------------------------------------------------------------------------------

const TOKEN_PATTERNS = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|bor_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g,
  /\b(authorization:\s*(basic|bearer)\s+)[A-Za-z0-9+/=._-]{8,}/gi,
  /\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
];

/**
 * Hides secret values (the exact strings in `values`, 6+ chars) and anything shaped like a
 * known token in text that leaves the machine (logs to Ops, CI report).
 */
export function makeRedactor(values = []) {
  const exact = [...new Set(values.map((v) => String(v ?? '').trim()).filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const v of exact) out = out.split(v).join('***');
    for (const re of TOKEN_PATTERNS) out = out.replace(re, (m, a, b) => (b !== undefined && typeof b === 'string' && /^(basic|bearer)$/i.test(b) ? `${a}***` : /^bearer\s+/i.test(m) ? `${a}***` : '***'));
    return out;
  };
}

// ---- CI of a PR --------------------------------------------------------------------------------

const CI_OK = new Set(['success', 'skipped', 'neutral']);

/**
 * State of the GitHub Actions runs of one commit (REST `actions/runs?head_sha=`; fine-grained
 * tokens cannot read check runs through GraphQL, which `gh pr checks` needs).
 * Latest attempt per workflow counts. → { state: 'none'|'pending'|'failed'|'passed', failed: [names] }
 */
export function ciState(runs = []) {
  const latest = new Map();
  for (const r of runs) {
    const key = r.workflow_id ?? r.name;
    const prev = latest.get(key);
    if (!prev || (r.run_attempt ?? 1) > (prev.run_attempt ?? 1) || ((r.run_attempt ?? 1) === (prev.run_attempt ?? 1) && Number(r.id) > Number(prev.id))) latest.set(key, r);
  }
  const all = [...latest.values()];
  if (!all.length) return { state: 'none', failed: [] };
  const failed = all.filter((r) => r.status === 'completed' && !CI_OK.has(r.conclusion)).map((r) => `${r.name} (${r.conclusion})`);
  if (failed.length) return { state: 'failed', failed };
  if (all.some((r) => r.status !== 'completed')) return { state: 'pending', failed: [] };
  return { state: 'passed', failed: [] };
}
