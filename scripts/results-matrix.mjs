import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const published = path.join(root, 'results/published');
const ROWS = [
  { file: 'runs-anchor-mac.jsonl', label: 'Mac' },
  { file: 'runs-anchor-default.jsonl', label: 'Anchor' },
  { file: 'runs-local-chromium.jsonl', label: 'Local' },
];
const STAGES = ['product', 'cart', 'checkout', 'shipping', 'payment'];
const THEMES = {
  light: { ink: '#1f2328', muted: '#59636e', line: '#d1d9e0', tile: '#ffffff', done: '#1a7f37', part: '#9a6700', wall: '#cf222e', none: '#d1d9e0' },
  dark: { ink: '#f0f6fc', muted: '#9198a1', line: '#3d444d', tile: '#151b23', done: '#3fb950', part: '#d29922', wall: '#f85149', none: '#3d444d' },
};
const COLS = 5;
const TILE = { w: 164, h: 104, gap: 12 };
const TOP = 16;
const SANS = '-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Helvetica,Arial,sans-serif';
const esc = (value) => String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const rank = (stage) => STAGES.indexOf(stage);
const isWall = (outcome) => outcome.startsWith('bot_detected') || outcome === 'captcha_required';

function readRuns(file) {
  const full = path.join(published, file);
  if (!fs.existsSync(full)) return [];
  const rows = fs.readFileSync(full, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return [...new Map(rows.map((row) => [`${row.task_id}|${row.attempt}`, row])).values()];
}

function summarize(runs) {
  const cells = {};
  for (const run of runs) (cells[run.task_id] ??= []).push(run);
  return Object.fromEntries(
    Object.entries(cells).map(([site, own]) => {
      const reached = Math.max(...own.map((run) => rank(run.furthest_stage)));
      return [
        site,
        {
          runs: own.length,
          passed: own.filter((run) => run.pass).length * 2 > own.length,
          reached,
          walled: reached < 0 && own.every((run) => isWall(run.outcome)),
        },
      ];
    })
  );
}

const rows = ROWS.map((row) => ({ ...row, cells: summarize(readRuns(row.file)) })).filter((row) => Object.keys(row.cells).length > 0);
const stores = [...new Set(rows.flatMap((row) => Object.keys(row.cells)))].sort();

function render(theme) {
  const c = THEMES[theme];
  const gridRows = Math.ceil(stores.length / COLS);
  const gridHeight = gridRows * TILE.h + (gridRows - 1) * TILE.gap;
  const width = COLS * TILE.w + (COLS - 1) * TILE.gap + 12;
  const height = TOP + gridHeight + 62;
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

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Grid of ${stores.length} stores. Each store has one row of five bars per browser (${esc(names)}) showing how far the reference agent got: product, cart, checkout, shipping details accepted, payment page.">
${tiles}
${legend}
<text x="6" y="${legendY + 24}" font-family="${SANS}" font-size="12" fill="${c.muted}">Bars, left to right: ${STAGES.join(', ')}. Mac: Anchor on Mac hardware. Anchor: default session. Local: Chromium on a laptop.</text>
</svg>
`;
}

for (const theme of Object.keys(THEMES)) {
  const file = path.join(root, 'assets', `results-${theme}.svg`);
  fs.writeFileSync(file, render(theme));
  console.log(`wrote ${path.relative(root, file)}`);
}
for (const row of rows) {
  const cells = Object.values(row.cells);
  const count = (test) => cells.filter(test).length;
  console.log(
    `${row.label}: ${cells.length} stores, finished ${count((cell) => cell.passed)}, past the start page ${count((cell) => cell.reached >= 0)}, reached checkout ${count((cell) => cell.reached >= 2)}, walled ${count((cell) => cell.walled)}`
  );
}
