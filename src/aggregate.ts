import { botVendor } from './outcomes.ts';
import { type RunRecord, runKey } from './run.ts';
import { type Stage, STAGES, stageRank } from './stages.ts';
import { median, nowIso } from './util.ts';

export type SiteCell = {
  stage: Stage | null;
  passed: boolean;
  flaky: boolean;
  runs: { attempt: number; furthest_stage: Stage | null; outcome: string; run_dir: string }[];
};

export type AgentSummary = {
  agent: string;
  track: 'observed' | 'reported';
  browser: string;
  runs: number;
  sites: number;
  sites_passed: number;
  flaky_sites: number;
  pass_rate: number;
  guard_breach_rate: number;
  false_completion_rate: number;
  funnel: Record<Stage, { runs: number; share: number; sites: number }>;
  outcomes: Record<string, number>;
  bot_walls: Record<string, number>;
  median_duration_s: number | null;
  median_steps: number | null;
  total_cost_usd: number | null;
};

export type Leaderboard = {
  schema_version: '0.1';
  generated_at: string;
  stages: readonly Stage[];
  agents: AgentSummary[];
  sites: { task_id: string; site: string; category: string | null; stop_at: Stage; cells: Record<string, SiteCell> }[];
};

const cellKey = (agent: string, taskId: string) => `${agent}|${taskId}`;

function cellOf(runs: RunRecord[]): SiteCell {
  const ranks = runs.map((run) => stageRank(run.furthest_stage)).sort((a, b) => a - b);
  const middle = ranks[Math.floor((ranks.length - 1) / 2)];
  return {
    stage: middle >= 0 ? STAGES[middle] : null,
    passed: runs.filter((run) => run.pass).length * 2 > runs.length,
    flaky: new Set(runs.map((run) => run.outcome)).size > 1,
    runs: runs
      .map((run) => ({ attempt: run.attempt, furthest_stage: run.furthest_stage, outcome: run.outcome, run_dir: run.run_dir }))
      .sort((a, b) => a.attempt - b.attempt),
  };
}

export function dedupe(records: RunRecord[]): RunRecord[] {
  return [...new Map(records.map((record) => [runKey(record), record])).values()];
}

export function aggregate(records: RunRecord[]): Leaderboard {
  const agentNames = [...new Set(records.map((record) => record.agent))];
  const taskIds = [...new Set(records.map((record) => record.task_id))].sort();
  const cells = new Map<string, SiteCell>();
  for (const agent of agentNames) {
    for (const taskId of taskIds) {
      const runs = records.filter((record) => record.agent === agent && record.task_id === taskId);
      if (runs.length > 0) cells.set(cellKey(agent, taskId), cellOf(runs));
    }
  }

  const agents = agentNames.map((agent): AgentSummary => {
    const runs = records.filter((record) => record.agent === agent);
    const own = taskIds.map((taskId) => cells.get(cellKey(agent, taskId))).filter((cell): cell is SiteCell => Boolean(cell));
    const rate = (count: number) => (runs.length ? count / runs.length : 0);
    const outcomes: Record<string, number> = {};
    const botWalls: Record<string, number> = {};
    for (const run of runs) {
      outcomes[run.outcome] = (outcomes[run.outcome] ?? 0) + 1;
      const vendor = botVendor(run.outcome);
      if (vendor) botWalls[vendor] = (botWalls[vendor] ?? 0) + 1;
    }
    const passes = runs.filter((run) => run.pass);
    const costs = runs.map((run) => run.cost_usd).filter((cost): cost is number => cost !== null);
    const durations = median(passes.map((run) => run.duration_ms / 1_000));
    const funnel = {} as AgentSummary['funnel'];
    for (const stage of STAGES) {
      const reached = runs.filter((run) => stageRank(run.furthest_stage) >= stageRank(stage)).length;
      funnel[stage] = {
        runs: reached,
        share: rate(reached),
        sites: own.filter((cell) => stageRank(cell.stage) >= stageRank(stage)).length,
      };
    }
    return {
      agent,
      track: runs[0].track,
      browser: [...new Set(runs.map((run) => run.browser))].join('+'),
      runs: runs.length,
      sites: own.length,
      sites_passed: own.filter((cell) => cell.passed).length,
      flaky_sites: own.filter((cell) => cell.flaky).length,
      pass_rate: rate(passes.length),
      guard_breach_rate: rate(runs.filter((run) => run.guard_breach).length),
      false_completion_rate: rate(runs.filter((run) => run.false_completion).length),
      funnel,
      outcomes,
      bot_walls: botWalls,
      median_duration_s: durations === null ? null : Math.round(durations * 10) / 10,
      median_steps: median(passes.map((run) => run.steps).filter((steps): steps is number => steps !== null)),
      total_cost_usd: costs.length ? Math.round(costs.reduce((sum, cost) => sum + cost, 0) * 100) / 100 : null,
    };
  });
  agents.sort(
    (a, b) => b.sites_passed - a.sites_passed || a.false_completion_rate - b.false_completion_rate || a.agent.localeCompare(b.agent)
  );

  return {
    schema_version: '0.1',
    generated_at: nowIso(),
    stages: STAGES,
    agents,
    sites: taskIds.map((taskId) => {
      const sample = records.find((record) => record.task_id === taskId)!;
      const row: Record<string, SiteCell> = {};
      for (const { agent } of agents) {
        const cell = cells.get(cellKey(agent, taskId));
        if (cell) row[agent] = cell;
      }
      return { task_id: taskId, site: sample.site, category: sample.category, stop_at: sample.stop_at, cells: row };
    }),
  };
}
