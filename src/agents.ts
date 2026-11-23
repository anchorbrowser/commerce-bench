import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { type AgentResult, parseAgentResult } from './agent-result.ts';
import { isStage, STAGES } from './stages.ts';
import type { AgentTask } from './tasks.ts';
import { describeError, readJson, redact, secretsInUrl } from './util.ts';

export type AgentSpec = {
  name: string;
  track: 'observed' | 'reported';
  adapter: 'command' | 'http' | 'manual';
  command?: string;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  notes?: string;
};

export type AgentRun = { result: AgentResult | null; timedOut: boolean; error: string | null };

export function loadAgent(location: string, root: string): AgentSpec {
  const candidates = [location, path.join(root, 'agents', `${location}.json`)];
  const file = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!file) throw new Error(`Agent file not found: ${location}`);
  const spec = readJson<AgentSpec>(file);
  const problems: string[] = [];
  if (!spec.name || !/^[a-z0-9][a-z0-9._-]*$/i.test(spec.name)) problems.push('name must be a short slug');
  if (spec.track !== 'observed' && spec.track !== 'reported') problems.push('track must be observed or reported');
  if (!['command', 'http', 'manual'].includes(spec.adapter)) problems.push('adapter must be command, http or manual');
  if (spec.adapter === 'command' && !spec.command) problems.push('command adapter needs "command"');
  if (spec.adapter === 'http' && !spec.url) problems.push('http adapter needs "url"');
  if (spec.adapter === 'manual' && spec.track !== 'observed') problems.push('manual adapter is observed only');
  if (problems.length > 0) throw new Error(`Invalid agent file ${file}: ${problems.join('; ')}`);
  return { ...spec, cwd: spec.cwd ? path.resolve(path.dirname(file), spec.cwd) : root };
}

function resolveHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value.startsWith('env:')) {
      resolved[key] = value;
      continue;
    }
    const variable = value.slice(4);
    const fromEnv = process.env[variable];
    if (!fromEnv) throw new Error(`Header ${key} needs environment variable ${variable}`);
    resolved[key] = fromEnv;
  }
  return resolved;
}

async function runCommand(spec: AgentSpec, task: AgentTask, logFile: string, secrets: string[]): Promise<AgentRun> {
  return new Promise((resolve) => {
    const child = spawn(spec.command!, { shell: true, cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const onExit = () => killGroup('SIGKILL');
    const onSignal = (signal: NodeJS.Signals) => {
      killGroup('SIGKILL');
      process.kill(process.pid, signal);
    };
    process.once('exit', onExit);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const deadline = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5_000).unref();
    }, task.deadline_s * 1_000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(task));
    let finished = false;
    const finish = (error: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      process.off('exit', onExit);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      killGroup('SIGKILL');
      fs.writeFileSync(logFile, redact(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`, secrets));
      const result = parseAgentResult(stdout);
      resolve({ result, timedOut, error: error ?? (result ? null : 'agent printed no result JSON') });
    };
    child.on('error', (error) => finish(describeError(error)));
    child.on('close', (code) => finish(code === 0 || timedOut ? null : `agent exited with code ${code}`));
  });
}

async function runHttp(spec: AgentSpec, task: AgentTask, logFile: string, secrets: string[]): Promise<AgentRun> {
  try {
    const headers = resolveHeaders(spec.headers);
    secrets.push(...Object.values(headers));
    const response = await fetch(spec.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(task.deadline_s * 1_000),
    });
    const body = await response.text();
    fs.writeFileSync(logFile, redact(`HTTP ${response.status}\n${body}\n`, secrets));
    if (!response.ok) return { result: null, timedOut: false, error: `agent endpoint returned HTTP ${response.status}` };
    const result = parseAgentResult(body);
    return { result, timedOut: false, error: result ? null : 'agent endpoint returned no result JSON' };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { result: null, timedOut, error: describeError(error) };
  }
}

async function runManual(task: AgentTask): Promise<AgentRun> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nManual run. Drive the browser window yourself.\n  Goal: ${task.goal}\n  Start: ${task.start_url}`);
    console.log(`  Shopper: ${task.shopper.email}, ${task.shopper.address.line1}, ${task.shopper.address.postal_code}`);
    await readline.question('Press Enter when you have stopped. ');
    const stage = (await readline.question(`Furthest stage you reached (${STAGES.join('/')}, blank for none): `)).trim();
    const total = (await readline.question('Order total shown on the page (blank to skip): ')).trim();
    return {
      result: parseAgentResult(
        JSON.stringify({
          status: isStage(stage) ? 'completed' : 'failed',
          claimed_stage: isStage(stage) ? stage : undefined,
          reported_total: total || undefined,
        })
      ),
      timedOut: false,
      error: null,
    };
  } finally {
    readline.close();
  }
}

export async function runAgent(spec: AgentSpec, task: AgentTask, logFile: string): Promise<AgentRun> {
  const secrets = task.browser ? secretsInUrl(task.browser.cdp_url) : [];
  if (spec.adapter === 'command') return runCommand(spec, task, logFile, secrets);
  if (spec.adapter === 'http') return runHttp(spec, task, logFile, secrets);
  return runManual(task);
}
