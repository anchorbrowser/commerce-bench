import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const published = path.join(root, 'results/published');
const readme = path.join(root, 'README.md');
const ROWS = [
  { file: 'runs-anchor-best.jsonl', label: 'Best', name: 'Anchor, best setup per store', short: 'the best setup per store' },
  { file: 'runs-anchor-mac.jsonl', label: 'Mac', name: 'Anchor on Mac hardware', short: 'Mac hardware' },
  { file: 'runs-anchor-default.jsonl', label: 'Default', name: 'Anchor, default session', short: 'a default Anchor session' },
  { file: 'runs-local-chromium.jsonl', label: 'Local', name: 'Chromium on a laptop', short: 'Chromium on a laptop' },
];
const SINGLE_SETUPS = ['runs-local-chromium.jsonl', 'runs-anchor-default.jsonl', 'runs-anchor-stealth.jsonl', 'runs-anchor-residential.jsonl', 'runs-anchor-mac.jsonl'];
const SETUP_NAMES = {
  'anchor-default': 'Anchor, default session',
  'anchor-stealth': 'Anchor, proxy + extra stealth + captcha solving',
  'anchor-residential': 'Anchor, residential proxy + stealth',
  'anchor-mac': 'Anchor on Mac hardware',
};
const STAGES = ['product', 'cart', 'checkout', 'shipping', 'payment'];
const THEMES = {
  light: { ink: '#1f2328', muted: '#59636e', line: '#d1d9e0', tile: '#ffffff', done: '#1a7f37', part: '#9a6700', wall: '#cf222e', none: '#d1d9e0' },
  dark: { ink: '#f0f6fc', muted: '#9198a1', line: '#3d444d', tile: '#151b23', done: '#3fb950', part: '#d29922', wall: '#f85149', none: '#3d444d' },
};
const COLS = 5;
const TILE = { w: 164, h: 120, gap: 12 };
const TOP = 16;
const SANS = '-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Helvetica,Arial,sans-serif';
const esc = (value) => String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const rank = (stage) => STAGES.indexOf(stage);
const isWall = (outcome) => outcome.startsWith('bot_detected') || outcome === 'captcha_required';
const isTurnedAway = (outcome) => isWall(outcome) || outcome === 'website_unavailable';

function readRuns(file) {
  const full = path.join(published, file);
  if (!fs.existsSync(full)) return [];
  const text = fs.readFileSync(full, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line)) : [];
}

function summarize(runs) {
  const cells = {};
  for (const run of runs) (cells[run.task_id] ??= []).push(run);
  return Object.fromEntries(
    Object.entries(cells).map(([site, own]) => {
      const graded = own.filter((run) => run.outcome !== 'harness_error');
      const passes = own.filter((run) => run.pass).length;
      const reached = Math.max(...own.map((run) => rank(run.furthest_stage)));
      const passed = graded.length > 0 && passes * 2 > graded.length;
      const signIn = graded.length > 0 && graded.filter((run) => run.outcome === 'login_required').length * 2 >= graded.length;
      const turnedAway = reached < 0 || graded.filter((run) => isTurnedAway(run.outcome)).length * 2 > graded.length;
      return [
        site,
        {
          runs: own.length,
          graded: graded.length,
          passes,
          passed,
          reached,
          walled: reached < 0 && graded.length > 0 && graded.every((run) => isWall(run.outcome)),
          ending: passed ? 'finished' : signIn ? 'signin' : turnedAway ? 'blocked' : 'agent',
        },
      ];
    })
  );
}

const rows = ROWS.map((row) => {
  const runs = readRuns(row.file);
  return { ...row, runs, cells: summarize(runs) };
}).filter((row) => row.runs.length > 0);
const stores = [...new Set(rows.flatMap((row) => Object.keys(row.cells)))].sort();

function render(theme) {
  const c = THEMES[theme];
  const gridRows = Math.ceil(stores.length / COLS);
  const gridHeight = gridRows * TILE.h + (gridRows - 1) * TILE.gap;
  const width = COLS * TILE.w + (COLS - 1) * TILE.gap + 12;
  const height = TOP + gridHeight + 80;
  const pip = (x, y, fill, stroke) => `<rect x="${x}" y="${y}" width="18" height="7" rx="3.5" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1.5"` : ''}/>`;

  const tiles = stores
    .map((site, index) => {
      const x = 6 + (index % COLS) * (TILE.w + TILE.gap);
      const y = TOP + Math.floor(index / COLS) * (TILE.h + TILE.gap);
      const lines = rows
        .map((row, line) => {
          const cell = row.cells[site];
          const lineY = y + 44 + line * 18;
          const label = `<text x="${x + 14}" y="${lineY + 7}" font-family="${SANS}" font-size="10.5" fill="${c.muted}">${row.label}</text>`;
          if (!cell) return label;
          const colour = cell.passed ? c.done : c.part;
          const pips = STAGES.map((stage, i) => {
            const px = x + 56 + i * 20;
            if (i <= cell.reached) return pip(px, lineY, colour);
            return pip(px, lineY, 'none', i === 0 && cell.walled ? c.wall : c.none);
          }).join('');
          return label + pips;
        })
        .join('');
      return `<g><rect x="${x}" y="${y}" width="${TILE.w}" height="${TILE.h}" rx="8" fill="${c.tile}" stroke="${c.line}"/>
<text x="${x + 14}" y="${y + 27}" font-family="${SANS}" font-size="${site.length > 16 ? 12 : 13.5}" font-weight="600" fill="${c.ink}">${esc(site)}</text>${lines}</g>`;
    })
    .join('\n');

  const legendY = TOP + gridHeight + 26;
  const keys = [
    ['task finished', c.done, true],
    ['got this far, then stopped', c.part, true],
    ['bot wall at the start page', c.wall, false],
  ];
  let keyX = 6;
  const legend = keys
    .map(([text, colour, filled]) => {
      const item = `${pip(keyX, legendY - 7, filled ? colour : 'none', filled ? null : colour)}<text x="${keyX + 24}" y="${legendY}" font-family="${SANS}" font-size="12" fill="${c.muted}">${text}</text>`;
      keyX += 34 + text.length * 6.3;
      return item;
    })
    .join('');
  const names = rows.map((row) => row.label).join(', ');
  const key = rows.map((row) => `${row.label}: ${row.name}.`).join(' ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Grid of ${stores.length} stores. Each store has one row of five bars per browser (${esc(names)}) showing how far the reference agent got: product, cart, checkout, shipping details accepted, payment page.">
${tiles}
${legend}
<text x="6" y="${legendY + 24}" font-family="${SANS}" font-size="12" fill="${c.muted}">Bars, left to right: ${STAGES.join(', ')}.</text>
<text x="6" y="${legendY + 42}" font-family="${SANS}" font-size="12" fill="${c.muted}">${esc(key)}</text>
</svg>
`;
}

for (const theme of Object.keys(THEMES)) {
  const file = path.join(root, 'assets', `results-${theme}.svg`);
  fs.writeFileSync(file, render(theme));
  console.log(`wrote ${path.relative(root, file)}`);
}

const sitesWith = (row, ending) => stores.filter((site) => row.cells[site]?.ending === ending);
const list = (sites) => {
  const names = sites.map((site) => `\`${site}\``);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};
const graded = (row) => row.runs.filter((run) => run.outcome !== 'harness_error').length;
const passedRuns = (row) => row.runs.filter((run) => run.pass).length;
for (const row of rows) {
  console.log(
    `${row.label}: finished ${sitesWith(row, 'finished').length} of ${Object.keys(row.cells).length}, runs passed ${passedRuns(row)} of ${graded(row)} graded, turned away ${sitesWith(row, 'blocked').length} (${sitesWith(row, 'blocked').join(', ')}), needs an account ${sitesWith(row, 'signin').length}, agent did not finish ${sitesWith(row, 'agent').length}`
  );
}

const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
const best = byLabel.Best;
const local = byLabel.Local;
if (best && local && fs.existsSync(readme)) {
  const picks = JSON.parse(fs.readFileSync(path.join(published, 'best-setup.json'), 'utf8')).stores;
  const index = JSON.parse(fs.readFileSync(path.join(published, 'index.json'), 'utf8'));
  const finishedOf = (row) => sitesWith(row, 'finished').length;
  const gotInOf = (row) => Object.keys(row.cells).length - sitesWith(row, 'blocked').length;
  const singles = rows.filter((row) => row !== best && row !== local).sort((a, b) => finishedOf(b) - finishedOf(a));
  const counts = Object.values(best.cells).map((cell) => cell.runs);
  const perStore = counts.sort((a, b) => counts.filter((n) => n === b).length - counts.filter((n) => n === a).length)[0];
  const uneven = rows.some((row) => Object.values(row.cells).some((cell) => cell.runs !== perStore));
  const table = [
    '| Browser | Got&nbsp;in | Finished | Agent stalled<br><sub>agent\'s job</sub> | Needs account<br><sub>store policy</sub> | Turned away | Runs passed |',
    '|:---|:---:|:---:|:---:|:---:|:---:|:---:|',
    ...rows.map((row) => {
      const cells = [row.name, `${gotInOf(row)}&nbsp;of&nbsp;${Object.keys(row.cells).length}`, finishedOf(row), sitesWith(row, 'agent').length, sitesWith(row, 'signin').length, sitesWith(row, 'blocked').length, `${passedRuns(row)}&nbsp;of&nbsp;${graded(row)}`];
      return `| ${row === best ? cells.map((cell, i) => (i < 3 ? `**${cell}**` : cell)).join(' | ') : cells.join(' | ')} |`;
    }),
  ].join('\n');

  const rescued = sitesWith(local, 'blocked').filter((site) => best.cells[site]?.ending === 'finished');
  const signIn = sitesWith(best, 'signin');
  const open = sitesWith(best, 'blocked');
  const stalled = sitesWith(best, 'agent');
  const singleRuns = SINGLE_SETUPS.flatMap(readRuns);
  const falseClaims = singleRuns.filter((run) => run.false_completion).length;
  const agentLines = fs.readFileSync(path.join(root, 'examples/llm-agent.ts'), 'utf8').split('\n').length;
  const allRows = index.all_runs?.rows ?? singleRuns.length;
  const breaches = index.all_runs?.guard_breaches ?? singleRuns.filter((run) => run.guard_breach).length;
  const strongest = singles[0];
  const others = [...singles.slice(1), local];
  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  const times = Math.floor((gotInOf(best) / gotInOf(local)) * 10) / 10;
  const lead = `**Anchor got the agent past the front door at ${gotInOf(best)} of ${stores.length} stores, ${times === 2 ? 'twice' : `${times} times`} as many as Chromium on a laptop (${gotInOf(local)}).** Once in, the agent finished checkout at ${finishedOf(best)}. The other ${gotInOf(best) - finishedOf(best)} stopped on an agent stall (${sitesWith(best, 'agent').length}) or on a store with no guest checkout (${sitesWith(best, 'signin').length}). ${sitesWith(best, 'blocked').length} stores turned the agent away in most runs, even on the best setup.`;
  const bullets = [
    `- **The right Anchor setup per store finishes the most.** With the best setup for each store, the reference agent finished ${finishedOf(best)} of ${stores.length} stores.${strongest ? ` The strongest single setup, ${strongest.short}, finished ${finishedOf(strongest)}.` : ''} ${others.map((row, i) => (i === 0 ? `${capital(row.short)} finished ${finishedOf(row)}` : `${row.short} ${finishedOf(row)}`)).join(others.length > 2 ? ', ' : ' and ')}.`,
    `- **The browser decides whether the agent gets a chance.** The agent never changed. A laptop browser was turned away at ${sitesWith(local, 'blocked').length} stores, the best Anchor setup at ${open.length}.${rescued.length ? ` ${rescued.length} stores that turned the laptop browser away were finished on Anchor: ${list(rescued)}.` : ''}`,
    signIn.length
      ? `- **${signIn.length === 1 ? 'One store needs' : `${signIn.length === 2 ? 'Two' : signIn.length} stores need`} an account.** ${list(signIn)} asked the shopper to sign in before checkout, with no guest path. That is the store's rule, not a browser block. The task asks for guest checkout, so ${signIn.length === 1 ? 'it does' : 'they do'} not count as finished.`
      : null,
    open.length || stalled.length
      ? `- **Still open.** ${open.length ? `Even on the best setup, ${list(open)} turned the agent away with a bot wall or an error page in most runs. ` : ''}${stalled.length ? `In ${list(stalled)} the agent got in and did not finish. The reference agent is a bundled example of about ${Math.round(agentLines / 10) * 10} lines. A stronger agent can move that number with no change to the browser.` : ''}`
      : null,
    falseClaims
      ? `- **The agent sometimes claims more than it did.** ${falseClaims} of ${singleRuns.length} published runs ended as \`false_completion\`: the agent said it was done and the browser showed otherwise. A self-reported score would have counted them as passes.`
      : `- **No false claims in the published runs.** None of the ${singleRuns.length} published runs ended as \`false_completion\`.`,
    `- **Nothing was bought.** ${allRows} runs recorded, superseded reruns included. No card entered, no order placed, ${breaches === 0 ? 'zero' : breaches} guard breaches.`,
  ].filter(Boolean);

  const groups = new Map();
  for (const [store, pick] of Object.entries(picks)) {
    if (!pick.finished) continue;
    const key = pick.config ?? pick.setup;
    groups.set(key, { setup: pick.setup, stores: [...(groups.get(key)?.stores ?? []), store] });
  }
  const order = Object.keys(SETUP_NAMES);
  const setupRows = [...groups.entries()]
    .sort(([, a], [, b]) => order.indexOf(a.setup) - order.indexOf(b.setup))
    .map(([config, group]) => `| ${SETUP_NAMES[group.setup] ?? group.setup}${config.includes('-uk') ? ', UK exit' : ''} | [\`${config}\`](${config}) | ${group.stores.length} | ${group.stores.sort().join(', ')} |`);
  const notFinished = Object.entries(picks)
    .filter(([store, pick]) => !pick.finished && !signIn.includes(store))
    .map(([store, pick]) => `\`${store}\` (${(SETUP_NAMES[pick.setup] ?? pick.setup).replace('Anchor, ', '').replace('Anchor on ', '')}, ${pick.passes} of ${pick.graded} runs passed)`);
  const example = [...groups.entries()].find(([config]) => config.endsWith('mac.json')) ?? [...groups.entries()][0];

  const block = `<!-- results:begin -->
${lead}

${table}

<sub>${stores.length} stores, ${perStore} runs per store on each browser${uneven ? ', a few stores fewer' : ''}. A store counts as got in unless it was turned away. A store counts as finished when more than half of its graded runs pass. Runs where the harness itself failed (\`harness_error\`) are not graded. "Turned away" means the agent never reached a product page, or a bot wall or error page ended most runs. Best setup per store takes, for each store, the Anchor setup with the most passing runs. On a tie it takes the setup whose runs got furthest, then the lightest. It is picked after the runs, so read it as a guide to which setup to use for a store, not as one fixed configuration.</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/results-dark.svg">
  <img alt="Grid of ${stores.length} stores. Each store has ${rows.length} rows of five bars, one row per browser (${rows.map((row) => row.name).join(', ')}), showing how far the reference agent got: product, cart, checkout, shipping details accepted, payment page. Green rows finished the task." src="assets/results-light.svg" width="880">
</picture>

What stands out:

${bullets.join('\n')}

### Which Anchor setup finished which store

| Setup | Session settings | Count | Stores finished |
|---|---|---|---|
${setupRows.join('\n')}

Each store is listed once, under the setup with the most passing runs, the lightest on a tie. A heavier setup may also have finished it. The rows for every setup are in [\`results/published/\`](results/published/), and the pick for each store is in [\`best-setup.json\`](results/published/best-setup.json).${notFinished.length ? ` Not finished on any Anchor setup tried yet, leaving out the stores that need an account: ${notFinished.join(', ')}.` : ''}
${example ? `
To repeat one, for example \`${example[1].stores.sort()[0]}\`:

\`\`\`sh
npm run bench -- run --agent examples/agents/llm-claude.json --browser anchor --anchor-config ${example[0]} --site ${example[1].stores.sort()[0]} --runs ${perStore}
\`\`\`
` : ''}<!-- results:end -->`;

  const current = fs.readFileSync(readme, 'utf8');
  const pattern = /<!-- results:begin -->[\s\S]*?<!-- results:end -->/;
  if (!pattern.test(current)) throw new Error('README.md has no results:begin and results:end markers');
  fs.writeFileSync(readme, current.replace(pattern, () => block));
  console.log('wrote README.md results block');
}
