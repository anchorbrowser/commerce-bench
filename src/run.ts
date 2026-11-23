import fs from 'node:fs';
import path from 'node:path';
import type { AgentResult } from './agent-result.ts';
import { type AgentRun, type AgentSpec, runAgent } from './agents.ts';
import { type BrowserOptions, openBrowser } from './browser.ts';
import { classifyObserved, classifyReported, formatOutcome, harnessError, type TotalCheck, type Verdict } from './outcomes.ts';
import { Probe, type ProbeResult } from './probe.ts';
import { type Stage, STAGES } from './stages.ts';
import { buildAgentTask, compilePatterns, loadShopper, type TaskFile } from './tasks.ts';
import { describeError, nowIso, redactDeep, secretsInUrl, sleep, withoutQuery } from './util.ts';

export type RunRecord = {
  schema_version: '0.1';
  run_id: string;
  agent: string;
  track: 'observed' | 'reported';
  browser: string;
  task_id: string;
  site: string;
  category: string | null;
  attempt: number;
  stop_at: Stage;
  started_at: string;
  duration_ms: number;
  furthest_stage: Stage | null;
  outcome: string;
  outcome_detail: string;
  pass: boolean;
  guard_breach: boolean;
  false_completion: boolean;
  total_check: TotalCheck;
  claim: { status: string | null; stage: Stage | null; total: number | null; failure_code: string | null };
  page_total: number | null;
  steps: number | null;
  cost_usd: number | null;
  final_url: string | null;
  session_id: string | null;
  recording: string | null;
  run_dir: string;
  probe: ProbeResult | null;
  errors: string[];
};

export type RunOptions = {
  root: string;
  outDir: string;
  agent: AgentSpec;
  task: TaskFile;
  attempt: number;
  browser: BrowserOptions;
  shopperFile?: string;
};

type Shopper = ReturnType<typeof loadShopper>;

type Attempt = {
  verdict: Verdict;
  result: AgentResult | null;
  probe: ProbeResult | null;
  backend: string;
  sessionId: string | null;
  recording: string | null;
  errors: string[];
  secrets: string[];
};

type RunContext = RunOptions & { runId: string; runDir: string; shopper: Shopper };

export const RESULTS_FILE = 'results.jsonl';
const AGENT_LOG = 'agent.log';
const RUN_FILE = 'run.json';
const RECORDING_FILE = 'recording.mp4';
const HARNESS_FILES = new Set([AGENT_LOG, RUN_FILE, RECORDING_FILE, ...STAGES.map((stage) => `${stage}.png`)]);
const SETTLE_MS = 1_500;
const HARNESS_ERROR = formatOutcome({ label: 'harness_error' });

export const runKey = (record: Pick<RunRecord, 'agent' | 'task_id' | 'attempt'>) =>
  `${record.agent}|${record.task_id}|${record.attempt}`;

export function readResults(dir: string): RunRecord[] {
  const file = path.join(dir, RESULTS_FILE);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RunRecord);
}

export function evidenceFiles(result: AgentResult | null, evidenceDir: string): string[] {
  const root = fs.realpathSync(evidenceDir);
  return Object.values(result?.evidence ?? {}).filter((name) => {
    const file = path.resolve(root, name);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || HARNESS_FILES.has(relative.toLowerCase())) return false;
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() && stat.size > 0 && fs.realpathSync(file) === file;
    } catch {
      return false;
    }
  });
}

const blankAttempt = (verdict: Verdict, errors: string[] = []): Attempt => ({
  verdict,
  result: null,
  probe: null,
  backend: 'none',
  sessionId: null,
  recording: null,
  errors,
  secrets: [],
});

const errorsOf = (run: AgentRun) => (run.error ? [run.error] : []);

async function runObserved(context: RunContext): Promise<Attempt> {
  const { agent, task, shopper, runId, runDir } = context;
  let browser: Awaited<ReturnType<typeof openBrowser>>;
  try {
    browser = await openBrowser({ ...context.browser, domain: task.site });
  } catch (error) {
    return blankAttempt(harnessError('the harness browser did not start'), [describeError(error)]);
  }
  const attempt: Attempt = {
    ...blankAttempt(harnessError('the harness browser could not be observed')),
    backend: browser.backend,
    sessionId: browser.sessionId ?? null,
    secrets: secretsInUrl(browser.cdpUrl),
  };
  try {
    const probe = await Probe.start({
      cdpUrl: browser.cdpUrl,
      site: task.site,
      productMatch: task.product.match,
      variantMatch: task.product.variant_match ?? [],
      expected: { email: shopper.email, addressLine: shopper.address.line1, postalCode: shopper.address.postal_code },
      patterns: compilePatterns(task.patterns),
      outputDir: runDir,
    });
    let run: AgentRun = { result: null, timedOut: false, error: null };
    try {
      const agentTask = buildAgentTask({ task, shopper, runId, cdpUrl: browser.cdpUrl, evidenceDir: runDir });
      run = await runAgent(agent, agentTask, path.join(runDir, AGENT_LOG));
      await sleep(SETTLE_MS);
    } finally {
      attempt.probe = await probe.stop();
    }
    attempt.result = run.result;
    attempt.errors.push(...errorsOf(run));
    attempt.verdict = classifyObserved({ probe: attempt.probe, agent: run.result, stopAt: task.stop_at, timedOut: run.timedOut });
  } catch (error) {
    attempt.errors.push(describeError(error));
  } finally {
    await browser.close().catch(() => undefined);
    if (browser.saveRecording && context.browser.recordings !== false) {
      const saved = await browser.saveRecording(path.join(runDir, RECORDING_FILE)).catch(() => false);
      if (saved) attempt.recording = RECORDING_FILE;
    }
  }
  return attempt;
}

async function runReported(context: RunContext): Promise<Attempt> {
  const { agent, task, shopper, runId, runDir } = context;
  const agentTask = buildAgentTask({ task, shopper, runId, evidenceDir: runDir });
  const run = await runAgent(agent, agentTask, path.join(runDir, AGENT_LOG));
  const verdict = classifyReported({
    agent: run.result,
    stopAt: task.stop_at,
    evidenceFound: evidenceFiles(run.result, runDir),
    timedOut: run.timedOut,
  });
  return { ...blankAttempt(verdict, errorsOf(run)), result: run.result };
}

async function attemptRun(options: RunOptions, runId: string, runDir: string): Promise<Attempt> {
  try {
    const shopper = loadShopper(options.task.region, options.shopperFile, options.root);
    const context = { ...options, runId, runDir, shopper };
    return await (options.agent.track === 'observed' ? runObserved(context) : runReported(context));
  } catch (error) {
    return blankAttempt(harnessError('the harness failed before the run could be graded'), [describeError(error)]);
  }
}

export async function runOne(options: RunOptions): Promise<RunRecord> {
  const { outDir, agent, task, attempt } = options;
  const runId = `${agent.name}_${task.id}_${attempt}`.replace(/[^a-z0-9._@-]+/gi, '-');
  const runDir = path.join(outDir, 'runs', runId);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const startedAt = nowIso();
  const started = Date.now();
  const { verdict, result, probe, backend, sessionId, recording, errors, secrets } = await attemptRun(options, runId, runDir);
  const label = verdict.outcome.label;

  const record: RunRecord = redactDeep(
    {
      schema_version: '0.1',
      run_id: runId,
      agent: agent.name,
      track: agent.track,
      browser: backend,
      task_id: task.id,
      site: task.site,
      category: task.category ?? null,
      attempt,
      stop_at: task.stop_at,
      started_at: startedAt,
      duration_ms: Date.now() - started,
      furthest_stage: probe ? probe.furthest_stage : (result?.claimed_stage ?? null),
      outcome: formatOutcome(verdict.outcome),
      outcome_detail: verdict.detail,
      pass: label === 'pass',
      guard_breach: label === 'guard_breach',
      false_completion: label === 'false_completion',
      total_check: verdict.total_check,
      claim: {
        status: result?.status ?? null,
        stage: result?.claimed_stage ?? null,
        total: result?.reported_total?.amount ?? null,
        failure_code: result?.failure?.code ?? null,
      },
      page_total: probe?.page_total?.amount ?? null,
      steps: result?.steps ?? null,
      cost_usd: result?.cost_usd ?? null,
      final_url: probe?.page.url || (result?.final_url ? withoutQuery(result.final_url) : null),
      session_id: sessionId,
      recording,
      run_dir: path.relative(outDir, runDir),
      probe,
      errors,
    },
    secrets
  );
  fs.writeFileSync(path.join(runDir, RUN_FILE), `${JSON.stringify(record, null, 2)}\n`);
  fs.appendFileSync(path.join(outDir, RESULTS_FILE), `${JSON.stringify(record)}\n`);
  return record;
}

export async function runAll(options: {
  root: string;
  outDir: string;
  agent: AgentSpec;
  tasks: TaskFile[];
  runs: number;
  browser: BrowserOptions;
  shopperFile?: string;
  force?: boolean;
  onRecord?: (record: RunRecord, index: number, total: number) => void;
}): Promise<RunRecord[]> {
  fs.mkdirSync(options.outDir, { recursive: true });
  const done = new Map(options.force ? [] : readResults(options.outDir).map((record) => [runKey(record), record]));
  const records: RunRecord[] = [];
  const total = options.tasks.length * options.runs;
  let index = 0;
  for (const task of options.tasks) {
    for (let attempt = 1; attempt <= options.runs; attempt++) {
      index += 1;
      const existing = done.get(runKey({ agent: options.agent.name, task_id: task.id, attempt }));
      const reusable = existing && existing.outcome !== HARNESS_ERROR ? existing : null;
      const record = reusable ?? (await runOne({ ...options, task, attempt }));
      records.push(record);
      options.onRecord?.(record, index, total);
    }
  }
  return records;
}
