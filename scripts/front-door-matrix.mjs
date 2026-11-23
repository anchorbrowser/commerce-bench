import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'results/published/front-door.json'), 'utf8'));

const THEMES = {
  light: { ink: '#1f2328', muted: '#59636e', line: '#d1d9e0', tile: '#ffffff', ok: '#1a7f37', wall: '#cf222e', error: '#9a6700', none: '#d1d9e0', pill: '#dafbe1', pillInk: '#116329' },
  dark: { ink: '#f0f6fc', muted: '#9198a1', line: '#3d444d', tile: '#151b23', ok: '#3fb950', wall: '#f85149', error: '#d29922', none: '#3d444d', pill: '#12261e', pillInk: '#3fb950' },
};
const COLUMNS = data.setups.filter((setup) => !setup.fold_into);
const foldedInto = (id) => data.setups.filter((setup) => setup.fold_into === id).map((setup) => setup.id);
const COLS = 5;
const TILE = { w: 164, h: 92, gap: 12 };
const TOP = 16;
const esc = (value) => String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);

function render(theme) {
  const c = THEMES[theme];
  const rows = Math.ceil(data.stores.length / COLS);
  const gridHeight = rows * TILE.h + (rows - 1) * TILE.gap;
  const height = TOP + gridHeight + 62;
  const width = COLS * TILE.w + (COLS - 1) * TILE.gap + 12;
  const state = (result) => (result === 'opened' ? c.ok : result == null ? c.none : result.startsWith('bot_detected') || result === 'captcha_required' ? c.wall : c.error);
  const sans = '-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Helvetica,Arial,sans-serif';

  const tiles = data.stores
    .map((store, index) => {
      const x = 6 + (index % COLS) * (TILE.w + TILE.gap);
      const y = TOP + Math.floor(index / COLS) * (TILE.h + TILE.gap);
      const pips = COLUMNS.map((setup, i) => {
        const result = foldedInto(setup.id).some((id) => store.results[id] === 'opened') ? 'opened' : store.results[setup.id];
        const bar = `x="${x + 14 + i * 28}" y="${y + 44}" width="24" height="8" rx="4"`;
        return result === 'opened' ? `<rect ${bar} fill="${c.ok}"/>` : `<rect ${bar} fill="none" stroke="${state(result)}" stroke-width="1.5"/>`;
      }).join('');
      const use = data.setups.find((setup) => setup.id === store.use);
      const label = use ? use.short : 'none';
      const pillWidth = 14 + label.length * 6.4;
      return `<g><rect x="${x}" y="${y}" width="${TILE.w}" height="${TILE.h}" rx="8" fill="${c.tile}" stroke="${c.line}"/>
<text x="${x + 14}" y="${y + 27}" font-family="${sans}" font-size="${store.site.length > 16 ? 12 : 13.5}" font-weight="600" fill="${c.ink}">${esc(store.site)}</text>${pips}
<rect x="${x + 14}" y="${y + 62}" width="${pillWidth}" height="18" rx="9" fill="${use ? c.pill : 'none'}" stroke="${use ? 'none' : c.line}"/>
<text x="${x + 14 + pillWidth / 2}" y="${y + 74.5}" text-anchor="middle" font-family="${sans}" font-size="11" font-weight="600" fill="${use ? c.pillInk : c.muted}">${esc(label)}</text></g>`;
    })
    .join('\n');

  const legendY = TOP + gridHeight + 26;
  const order = COLUMNS.map((setup, i) => `<rect x="${6 + i * 28}" y="${legendY - 8}" width="24" height="8" rx="4" fill="${c.none}"/>`).join('');
  const names = COLUMNS.map((setup) => setup.short).join(' · ');
  const keys = [
    ['opened', c.ok],
    ['bot wall', c.wall],
    ['error', c.error],
  ]
    .map(([text, fill], i) => `<rect x="${520 + i * 110}" y="${legendY - 8}" width="24" height="8" rx="4" fill="${i === 0 ? fill : 'none'}" stroke="${fill}" stroke-width="1.5"/><text x="${550 + i * 110}" y="${legendY}" font-family="${sans}" font-size="12" fill="${c.muted}">${text}</text>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Grid of ${data.stores.length} stores. For each store, five bars show whether the start page opened on ${esc(names)}, and a label names the lightest Anchor setup that opened it.">
${tiles}
${order}<text x="${6 + COLUMNS.length * 28 + 6}" y="${legendY}" font-family="${sans}" font-size="12" fill="${c.muted}">bars, left to right: ${esc(names)}</text>${keys}
<text x="6" y="${legendY + 24}" font-family="${sans}" font-size="12" fill="${c.muted}">Label: lightest Anchor setup that opened the store. ${esc(data.note)}</text>
</svg>
`;
}

for (const theme of Object.keys(THEMES)) {
  const file = path.join(root, 'assets', `front-door-${theme}.svg`);
  fs.writeFileSync(file, render(theme));
  console.log(`wrote ${path.relative(root, file)}`);
}
