import fs from 'node:fs';
import path from 'node:path';
import { NOT_RUN_REASON } from './agents.ts';
import { aggregate, dedupe, type Leaderboard } from './aggregate.ts';
import { outcomeKind } from './outcomes.ts';
import { readNotRun, readResults, type RunRecord } from './run.ts';
import { STAGE_LABEL, STAGES, stageRank } from './stages.ts';
import { escapeHtml as esc } from './util.ts';

const percent = (value: number) => `${Math.round(value * 100)}%`;

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#e3e3e0;--track:#e9e9e6;
--pass:#2f7d4f;--wall:#c2410c;--false:#7c3aed;--breach:#b91c1c;--stuck:#2563eb;--site:#a16207}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1d1d20;--ink:#ececee;--muted:#9a9aa1;--line:#2e2e33;--track:#2a2a2f;
--pass:#4ade80;--wall:#fb923c;--false:#a78bfa;--breach:#f87171;--stuck:#60a5fa;--site:#facc15}}
*{box-sizing:border-box}body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:24px 16px;background:var(--bg);color:var(--ink)}
main{max-width:1180px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.meta,.sub{color:var(--muted);font-size:12.5px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th{text-align:left;font-weight:600;font-size:12px;color:var(--muted);padding:6px 8px;white-space:nowrap}
td{border-top:1px solid var(--line);padding:7px 8px;vertical-align:top}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.badge{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11.5px;border:1px solid var(--line);color:var(--muted)}
.funnels{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.bar{display:flex;align-items:center;gap:8px;margin:5px 0}.bar .label{width:150px;font-size:12.5px}.bar .n{width:92px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--muted)}
.trackbar{flex:1;height:11px;background:var(--track);border-radius:6px;overflow:hidden;display:flex}.fill{height:100%;background:var(--pass)}
.seg.pass,.dot.pass,.tag.pass{background:var(--pass)}.seg.wall,.dot.wall,.tag.wall{background:var(--wall)}.seg.false,.dot.false,.tag.false{background:var(--false)}
.seg.breach,.dot.breach,.tag.breach{background:var(--breach)}.seg.stuck,.dot.stuck,.tag.stuck{background:var(--stuck)}.seg.site,.dot.site,.tag.site{background:var(--site)}
.seg{height:100%}.tag{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11.5px;color:#fff;white-space:nowrap}
@media (prefers-color-scheme:dark){.tag{color:#111}}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:3px}.pips span{display:inline-block;width:14px;height:6px;border-radius:3px;background:var(--track);margin-right:2px}
.pips span.on{background:var(--pass)}.cell{min-width:120px}.legend span{margin-right:12px;white-space:nowrap}
details{border-top:1px solid var(--line);padding:8px 0}summary{cursor:pointer}details .body{padding:8px 0 4px 16px}
.body video{display:block;width:100%;max-width:720px;margin-top:10px;border:1px solid var(--line);border-radius:6px}.shots img{height:84px;border:1px solid var(--line);border-radius:4px;margin:4px 6px 0 0}
`;

function summaryTable(board: Leaderboard): string {
  const rows = board.agents
    .map(
      (agent) => `<tr><td><strong>${esc(agent.agent)}</strong><div class="sub">${esc(agent.browser)} browser</div></td>
<td><span class="badge">${agent.track}</span></td><td class="num">${agent.sites_passed} / ${agent.sites}</td>
<td class="num">${percent(agent.pass_rate)}</td><td class="num">${percent(agent.false_completion_rate)}</td>
<td class="num">${percent(agent.guard_breach_rate)}</td><td class="num">${agent.flaky_sites}</td>
<td class="num">${agent.median_duration_s ?? '-'}</td><td class="num">${agent.median_steps ?? '-'}</td>
<td class="num">${agent.total_cost_usd === null ? '-' : `$${agent.total_cost_usd.toFixed(2)}`}</td><td class="num">${agent.runs}</td></tr>`
    )
    .join('');
  return `<div class="card"><table><tr><th>Agent</th><th>Track</th><th class="num">Sites passed</th><th class="num">Run pass rate</th>
<th class="num">False completion</th><th class="num">Guard breach</th><th class="num">Flaky sites</th><th class="num">Median s (passes)</th>
<th class="num">Median steps</th><th class="num">Cost</th><th class="num">Runs</th></tr>${rows}</table></div>`;
}

function funnels(board: Leaderboard): string {
  return `<div class="funnels">${board.agents
    .map((agent) => {
      const bars = STAGES.map((stage) => {
        const { runs, share } = agent.funnel[stage];
        return `<div class="bar"><span class="label">${STAGE_LABEL[stage]}</span><span class="trackbar"><span class="fill" style="width:${(share * 100).toFixed(1)}%"></span></span><span class="n">${runs}/${agent.runs} runs</span></div>`;
      }).join('');
      return `<div class="card"><strong>${esc(agent.agent)}</strong> <span class="badge">${agent.track}</span>${bars}</div>`;
    })
    .join('')}</div>`;
}

function grid(board: Leaderboard): string {
  const head = board.agents.map((agent) => `<th>${esc(agent.agent)}</th>`).join('');
  const rows = board.sites
    .map((site) => {
      const cells = board.agents
        .map((agent) => {
          const cell = site.cells[agent.agent];
          if (!cell) return '<td class="cell sub">not run</td>';
          const pips = STAGES.map((stage) => `<span class="${stageRank(cell.stage) >= stageRank(stage) ? 'on' : ''}" title="${STAGE_LABEL[stage]}"></span>`).join('');
          const dots = cell.runs
            .map((run) => `<span class="dot ${outcomeKind(run.outcome)}" title="run ${run.attempt}: ${esc(run.outcome)}"></span>`)
            .join('');
          const label = cell.runs.length === 1 || !cell.flaky ? cell.runs[0].outcome : 'mixed results';
          return `<td class="cell"><div class="pips">${pips}</div><div>${dots}<span class="sub">${esc(label)}</span></div></td>`;
        })
        .join('');
      return `<tr><td><strong>${esc(site.task_id)}</strong><div class="sub">${esc(site.category ?? '')}</div></td>${cells}</tr>`;
    })
    .join('');
  return `<div class="card"><table><tr><th>Site</th>${head}</tr>${rows}</table>
<p class="sub">Bars show the stage reached in most runs. Dots are single runs, coloured by outcome.</p></div>`;
}

function reasons(board: Leaderboard): string {
  const rows = board.agents
    .map((agent) => {
      const entries = Object.entries(agent.outcomes).sort((a, b) => b[1] - a[1]);
      const segments = entries
        .map(([outcome, count]) => `<span class="seg ${outcomeKind(outcome)}" style="width:${(count / agent.runs) * 100}%" title="${esc(outcome)}: ${count}"></span>`)
        .join('');
      const list = entries.map(([outcome, count]) => `<span><span class="dot ${outcomeKind(outcome)}"></span>${esc(outcome)} ${count}</span>`).join('');
      return `<div style="margin:10px 0"><strong>${esc(agent.agent)}</strong><div class="trackbar" style="height:14px;margin:5px 0">${segments}</div><div class="legend sub">${list}</div></div>`;
    })
    .join('');
  return `<div class="card">${rows}</div>`;
}

function walls(board: Leaderboard): string {
  const vendors = [...new Set(board.agents.flatMap((agent) => Object.keys(agent.bot_walls)))].sort();
  if (vendors.length === 0) return '<div class="card sub">No bot walls recorded.</div>';
  const head = vendors.map((vendor) => `<th class="num">${esc(vendor)}</th>`).join('');
  const rows = board.agents
    .map((agent) => `<tr><td>${esc(agent.agent)}</td>${vendors.map((vendor) => `<td class="num">${agent.bot_walls[vendor] ?? 0}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="card"><table><tr><th>Agent</th>${head}</tr>${rows}</table></div>`;
}

function notRunTable(board: Leaderboard): string {
  const rows = (board.not_run ?? [])
    .map(
      (entry) => `<tr><td><strong>${esc(entry.agent)}</strong></td><td><span class="badge">${esc(entry.track)}</span></td>
<td>${esc(NOT_RUN_REASON[entry.status] ?? entry.status)}${entry.note ? `<div class="sub">${esc(entry.note)}</div>` : ''}</td><td class="num">${esc(entry.sites)}</td></tr>`
    )
    .join('');
  return `<div class="card"><table><tr><th>Agent</th><th>Track</th><th>Reason</th><th class="num">Sites selected</th></tr>${rows}</table>
<p class="sub">These agents were not run. They have no results and are not counted in any rate above.</p></div>`;
}

function runDetails(records: RunRecord[], relativeTo: (record: RunRecord) => string): string {
  return records
    .map((record) => {
      const base = relativeTo(record);
      const probeLatches = record.probe?.latches ?? [];
      const latches = probeLatches
        .map((latch) => `<li><strong>${STAGE_LABEL[latch.stage]}</strong> ${esc(latch.detail)}</li>`)
        .join('');
      const shots = probeLatches
        .filter((latch) => latch.screenshot)
        .map((latch) => {
          const src = esc(`${base}/${latch.screenshot}`);
          return `<a href="${src}"><img loading="lazy" alt="${latch.stage}" src="${src}"></a>`;
        })
        .join('');
      const guards = (record.probe?.guard_events ?? [])
        .map((event) => `<li>${esc(event.kind)}: ${esc(event.detail)}${event.blocked ? ' (request blocked)' : ''}</li>`)
        .join('');
      const claim = record.claim.status
        ? `status ${esc(record.claim.status)}, stage ${esc(record.claim.stage ?? 'none')}, total ${record.claim.total ?? 'not given'}`
        : 'no result returned';
      return `<details><summary><span class="tag ${outcomeKind(record.outcome)}">${esc(record.outcome)}</span> ${esc(record.agent)} on ${esc(record.task_id)}, run ${record.attempt}
<span class="sub">${(record.duration_ms / 1_000).toFixed(0)}s, furthest: ${esc(record.furthest_stage ?? 'none')}</span></summary><div class="body">
<div>${esc(record.outcome_detail)}</div><div class="sub">Agent said: ${claim}. Page total: ${record.page_total ?? 'not read'} (${record.total_check}).</div>
${latches ? `<ul>${latches}</ul>` : ''}${guards ? `<div><strong>Guard events</strong><ul>${guards}</ul></div>` : ''}
${record.errors.length ? `<div class="sub">Errors: ${esc(record.errors.join('; '))}</div>` : ''}<div class="shots">${shots}</div>${record.recording ? `<video controls preload="none" src="${esc(`${base}/${record.recording}`)}"></video>` : ''}</div></details>`;
    })
    .join('');
}

export function writeReport(inputDirs: string[], outDir: string): { leaderboard: string; html: string; board: Leaderboard } {
  fs.mkdirSync(outDir, { recursive: true });
  const loaded = inputDirs.flatMap((dir) => readResults(dir).map((record) => ({ record, dir })));
  const notRunLines = inputDirs.flatMap((dir) => readNotRun(dir));
  if (loaded.length === 0 && notRunLines.length === 0) throw new Error(`No results found in ${inputDirs.join(', ')}`);
  const browsersOf = new Map<string, Set<string>>();
  for (const { record } of loaded) browsersOf.set(record.agent, (browsersOf.get(record.agent) ?? new Set()).add(record.browser));
  const origin = new Map<RunRecord, string>();
  const labelled = loaded.map(({ record, dir }) => {
    const row = browsersOf.get(record.agent)!.size > 1 ? { ...record, agent: `${record.agent}@${record.browser}` } : record;
    origin.set(row, dir);
    return row;
  });
  const records = dedupe(labelled);
  const board = aggregate(records, notRunLines.filter((line) => !browsersOf.has(line.agent)));
  const relativeTo = (record: RunRecord) => path.relative(outDir, path.join(origin.get(record)!, record.run_dir)) || '.';
  const order = new Map(board.agents.map((agent, index) => [agent.agent, index]));
  records.sort((a, b) => order.get(a.agent)! - order.get(b.agent)! || a.task_id.localeCompare(b.task_id) || a.attempt - b.attempt);
  const tracks = new Set(board.agents.map((agent) => agent.track));

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Commerce Bench report</title><style>${CSS}</style></head><body><main>
<h1>Commerce Bench report</h1>
<div class="meta">${board.agents.length} agents, ${board.sites.length} sites, ${records.length} runs. Generated ${esc(board.generated_at)}. No run enters payment details or places an order.</div>
${tracks.has('reported') ? '<p class="sub">Rows marked <span class="badge">reported</span> ran in the assistant\'s own browser and are graded from what it sent back. Rows marked <span class="badge">observed</span> were watched by the harness. Do not compare the two directly.</p>' : ''}
<h2>Summary</h2>${summaryTable(board)}
${board.not_run ? `<h2>Not run</h2>${notRunTable(board)}` : ''}
<h2>How far each agent gets</h2>${funnels(board)}
<h2>Site by agent</h2>${grid(board)}
<h2>Why runs stopped</h2>${reasons(board)}
<h2>Bot walls by vendor</h2>${walls(board)}
<h2>Runs</h2><div class="card">${runDetails(records, relativeTo)}</div>
</main></body></html>`;

  const leaderboard = path.join(outDir, 'leaderboard.json');
  const htmlFile = path.join(outDir, 'report.html');
  fs.writeFileSync(leaderboard, `${JSON.stringify(board, null, 2)}\n`);
  fs.writeFileSync(htmlFile, html);
  return { leaderboard, html: htmlFile, board };
}
