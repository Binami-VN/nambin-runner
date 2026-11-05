#!/usr/bin/env node
/**
 * Runs one Cursor SDK agent for the runner (see withCursorAgent in runner.mjs), in its own
 * process and, on CI, as the unprivileged sandbox user. JSON lines on stdin/stdout:
 *   in:  {type:'key', apiKey}  first, then {type:'send', prompt} | {type:'cancel'} | {type:'close'}
 *   out: {type:'ready'|'fatal'}, then per turn {type:'text'|'tool'}… and {type:'done'|'error'}
 */
import { createInterface } from 'node:readline';

const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const opts = JSON.parse(process.env.CURSOR_WORKER_OPTS ?? '{}');
delete process.env.CURSOR_WORKER_OPTS;

let agent = null;
let current = null;
const rl = createInterface({ input: process.stdin });

async function start(apiKey) {
  try {
    const { Agent } = await import('@cursor/sdk');
    agent = await Agent.create({ apiKey, model: { id: opts.model }, local: { cwd: opts.cwd, settingSources: [] } });
    out({ type: 'ready', agentId: agent.agentId ?? null });
  } catch (err) {
    out({ type: 'fatal', message: String(err?.message ?? err).slice(0, 1000) });
    process.exit(1);
  }
}

async function send(prompt) {
  try {
    current = await agent.send(prompt);
    let text = '';
    let pending = '';
    const flush = () => {
      if (pending.trim()) out({ type: 'text', text: pending.trim() });
      pending = '';
    };
    for await (const event of current.stream()) {
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type !== 'text' || !block.text) continue;
          text += block.text;
          pending += block.text;
          if (pending.includes('\n') || pending.length > 800) flush();
        }
      } else if (event.type === 'tool_call' && event.status === 'running') {
        flush();
        const args = event.args && typeof event.args === 'object' ? event.args : {};
        const hint = args.command ?? args.path ?? args.target_file ?? args.pattern ?? '';
        out({ type: 'tool', name: event.name, hint: String(hint).slice(0, 200) });
      }
    }
    flush();
    const result = await current.wait();
    out({ type: 'done', status: result.status, id: result.id ?? null, text: (typeof result.result === 'string' && result.result.trim()) || text });
  } catch (err) {
    out({ type: 'error', message: String(err?.message ?? err).slice(0, 1000) });
  } finally {
    current = null;
  }
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'key' && !agent) void start(String(msg.apiKey ?? ''));
  else if (msg.type === 'send' && agent) void send(String(msg.prompt ?? ''));
  else if (msg.type === 'cancel' && current?.supports?.('cancel')) current.cancel().catch(() => {});
  else if (msg.type === 'close') {
    rl.close();
    Promise.resolve(agent?.[Symbol.asyncDispose]?.())
      .catch(() => {})
      .finally(() => process.exit(0));
  }
});
