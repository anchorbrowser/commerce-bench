import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const published = path.join(repo, 'results/published');
const distFlag = process.argv.indexOf('--dist');
const dist = distFlag > 0 ? path.resolve(process.argv[distFlag + 1]) : null;
const out = dist ?? here;
const rel = dist ? '.' : path.relative(here, published);

const readRuns = (file) => {
  const full = path.join(published, file);
  if (!fs.existsSync(full)) return [];
  const text = fs.readFileSync(full, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line)) : [];
};
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(published, file), 'utf8'));
const esc = (value) => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

const STAGES = ['product', 'cart', 'checkout', 'shipping', 'payment'];
const STAGE_NAMES = ['Product', 'Cart', 'Checkout', 'Shipping', 'Payment page'];
const rank = (stage) => STAGES.indexOf(stage);
const isWall = (outcome) => outcome.startsWith('bot_detected') || outcome === 'captcha_required';
const isTurnedAway = (outcome) => isWall(outcome) || outcome === 'website_unavailable';

const SETUPS = [
  { id: 'best', file: 'runs-anchor-best.jsonl', name: 'Anchor, best setup per store', short: 'Best' },
  { id: 'mac', file: 'runs-anchor-mac.jsonl', name: 'Anchor on Mac hardware', short: 'Mac' },
  { id: 'default', file: 'runs-anchor-default.jsonl', name: 'Anchor, default session', short: 'Default' },
  { id: 'stealth', file: 'runs-anchor-stealth.jsonl', name: 'Anchor, proxy with extra stealth', short: 'Stealth' },
  { id: 'residential', file: 'runs-anchor-residential.jsonl', name: 'Anchor, residential proxy', short: 'Residential' },
  { id: 'local', file: 'runs-local-chromium.jsonl', name: 'Chromium on a laptop', short: 'Laptop' },
];
const SETUP_LABEL = { 'anchor-default': 'Default session', 'anchor-mac': 'Mac hardware', 'anchor-stealth': 'Proxy with extra stealth', 'anchor-residential': 'Residential proxy' };
const ENDINGS = {
  finished: { label: 'Finished', long: 'Finished checkout', who: '', icon: '<path d="M2.5 6.4 5 8.8 9.6 3.4"/>' },
  agent: { label: 'Agent stalled', long: 'Got in, agent stalled', who: 'agent\u2019s job', icon: '<path d="M4.2 3v6M7.8 3v6"/>' },
  signin: { label: 'Needs an account', long: 'Got in, store wants an account', who: 'store policy', icon: '<circle cx="6" cy="4.3" r="1.9"/><path d="M2.6 10c.4-1.9 1.7-2.9 3.4-2.9s3 1 3.4 2.9"/>' },
  blocked: { label: 'Turned away', long: 'Turned away at the door', who: '', icon: '<path d="M3.2 3.2l5.6 5.6M8.8 3.2 3.2 8.8"/>' },
};
const ORDER = ['finished', 'agent', 'signin', 'blocked'];
const shortName = (ending) => {
  const text = ENDINGS[ending].long.replace('Got in, ', '');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const icon = (ending) => `<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ENDINGS[ending].icon}</svg>`;

function endingOf(passed, signIn, turnedAway) {
  if (passed) return 'finished';
  if (signIn) return 'signin';
  if (turnedAway) return 'blocked';
  return 'agent';
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
      return [site, { runs: own, graded: graded.length, passes, reached, ending: endingOf(passed, signIn, turnedAway) }];
    })
  );
}

const WALLS = { datadome: 'DataDome', perimeterx: 'PerimeterX', cloudflare: 'Cloudflare', imperva: 'Imperva', edge_deny: 'an edge block', generic: 'a bot wall', akamai: 'Akamai' };
function plain(outcome) {
  if (outcome === 'pass') return 'passed';
  if (outcome === 'harness_error') return 'browser stopped answering, not graded';
  if (outcome.startsWith('bot_detected')) return `stopped by ${WALLS[outcome.split(':')[1]] ?? 'a bot wall'}`;
  if (outcome === 'login_required') return 'sign-in required';
  if (outcome === 'website_unavailable') return 'store served an error page';
  if (outcome.startsWith('stuck_at_')) return `stalled at ${outcome.slice(9).replace('start', 'the start page')}`;
  return outcome.replaceAll('_', ' ');
}
function reason(cell) {
  if (cell.ending === 'finished') return `${cell.passes} of ${cell.graded} runs passed`;
  const counts = {};
  for (const run of cell.runs) {
    if (run.pass || run.outcome === 'harness_error') continue;
    const text = plain(run.outcome);
    counts[text] = (counts[text] ?? 0) + 1;
  }
  const entries = Object.entries(counts);
  const stalls = entries.filter(([text]) => !text.startsWith('stopped by'));
  const top = (cell.ending === 'agent' && stalls.length ? stalls : entries).sort((a, b) => b[1] - a[1])[0];
  const text = top ? top[0] : 'no graded run';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const tasks = Object.fromEntries(
  fs.readdirSync(path.join(repo, 'tasks')).filter((file) => file.endsWith('.json')).map((file) => {
    const task = JSON.parse(fs.readFileSync(path.join(repo, 'tasks', file), 'utf8'));
    return [task.id, task];
  })
);
const index = readJson('index.json');
const picks = readJson('best-setup.json').stores;
const sets = Object.fromEntries(SETUPS.map((setup) => [setup.id, summarize(readRuns(setup.file))]));
const stores = Object.keys(sets.best).sort((a, b) => {
  const [x, y] = [sets.best[a], sets.best[b]];
  return ORDER.indexOf(x.ending) - ORDER.indexOf(y.ending) || y.passes - x.passes || y.reached - x.reached || a.localeCompare(b);
});
const tally = (id) => Object.fromEntries(ORDER.map((ending) => [ending, Object.keys(sets[id]).filter((site) => sets[id][site].ending === ending).sort()]));
const best = tally('best');
const date = new Date(`${index.date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const INSIDE = ['finished', 'agent', 'signin'];
const gotIn = (counts) => INSIDE.flatMap((ending) => counts[ending]);
const local = tally('local');
const inBest = gotIn(best);
const inLocal = gotIn(local);
const rescued = inBest.filter((site) => local.blocked.includes(site));
const times = `${Math.floor((inBest.length / inLocal.length) * 10) / 10}x`;

const logo = (site, size = 20) => {
  const file = path.join(here, 'logos', `${site}.png`);
  return fs.existsSync(file)
    ? `<img class="logo" src="logos/${site}.png" alt="" width="${size}" height="${size}" loading="lazy">`
    : `<span class="logo ph" style="width:${size}px;height:${size}px" aria-hidden="true">${site[0].toUpperCase()}</span>`;
};
const logoRow = (sites) => `<ul class="logos">${sites.map((site) => `<li data-tip="${esc(site)}">${logo(site, 24)}<span class="vh">${esc(site)}</span></li>`).join('')}</ul>`;

function receipt() {
  const line = (ending, sub) => `<div class="r-line${sub ? ' r-sub' : ''}"><span><i class="sw ${ending}"></i>${shortName(ending)}</span><b>${best[ending].length}</b></div>`;
  const lines = `<div class="r-line r-strong"><span>Got past the front door</span><b>${inBest.length}</b></div>${INSIDE.map((ending) => line(ending, true)).join('')}${line('blocked', false)}`;
  let seed = 7;
  const bars = Array.from({ length: 46 }, () => {
    seed = (seed * 73 + 19) % 101;
    return `<i style="width:${1 + (seed % 3)}px;margin-right:${1 + ((seed >> 2) % 3)}px"></i>`;
  }).join('');
  return `<aside class="receipt" aria-label="Summary of the run, set as a till receipt">
  <div class="r-head"><strong>Commerce Bench</strong><span>${date}</span></div>
  <div class="r-rule"></div>
  <div class="r-line"><span>Stores visited</span><b>${stores.length}</b></div>
  <div class="r-line"><span>Shopping agents</span><b>1</b></div>
  <div class="r-rule"></div>
  ${lines}
  <div class="r-rule"></div>
  <div class="r-line"><span>Runs recorded</span><b>${index.all_runs.rows}</b></div>
  <div class="r-line"><span>Cards entered</span><b>0</b></div>
  <div class="r-line"><span>Orders placed</span><b>${index.all_runs.guard_breaches}</b></div>
  <div class="r-rule"></div>
  <div class="r-total"><span>Got in</span><b>${inBest.length} of ${stores.length}</b></div>
  <div class="r-bars" aria-hidden="true">${bars}</div>
  <p class="r-foot">Nothing was bought. Every run stops before payment.</p>
</aside>`;
}

function setupBars() {
  const rows = ['best', 'mac', 'default', 'local'].map((id) => {
    const setup = SETUPS.find((entry) => entry.id === id);
    const counts = tally(id);
    const inside = gotIn(counts).length;
    const seg = (ending) => {
      const sites = counts[ending];
      if (!sites.length) return '';
      const who = ENDINGS[ending].who ? ` (${ENDINGS[ending].who})` : '';
      return `<span class="seg ${ending}" style="flex:${sites.length}" tabindex="0" data-tip="${esc(`${ENDINGS[ending].long}${who}: ${sites.length}`)}" data-list="${esc(sites.join(', '))}"><b>${sites.length}</b></span>`;
    };
    const label = `Got in ${inside} of ${stores.length}. ${ORDER.map((ending) => `${ENDINGS[ending].long} ${counts[ending].length}`).join(', ')}`;
    const callout = id === 'best' ? `<span class="callout">${inside}/${stores.length} in, ${times} Chromium</span>` : '';
    return `<div class="bar-row${id === 'best' ? ' lead' : ''}"><div class="bar-name">${esc(setup.name)}${callout}</div><div class="bar-in"><b>${inside}</b><span>of ${stores.length} got in</span></div><div class="bar" role="img" aria-label="${esc(label)}">${inside ? `<span class="in" style="flex:${inside}"><i class="in-rail"></i><span class="in-segs">${INSIDE.map(seg).join('')}</span></span>` : ''}${seg('blocked')}</div></div>`;
  }).join('');
  const legend = ORDER.map((ending) => `<li><i class="sw ${ending}"></i>${shortName(ending)}${ENDINGS[ending].who ? `<em>${ENDINGS[ending].who}</em>` : ''}</li>`).join('');
  return `<ul class="legend"><li><i class="sw rail"></i>Got in</li>${legend}</ul><div class="bars">${rows}</div>`;
}

function stepState(cell, i) {
  if (i <= cell.reached) return cell.ending === 'finished' ? 'done' : 'part';
  if (i === 0 && cell.ending === 'blocked') return 'shut';
  return 'off';
}

function track(cell) {
  const steps = STAGES.map((stage, i) => {
    const on = i <= cell.reached;
    const state = stepState(cell, i);
    return `<i class="${state}" data-tip="${esc(`${STAGE_NAMES[i]}: ${on ? 'reached' : 'not reached'}`)}"></i>`;
  }).join('');
  const where = cell.reached < 0 ? 'Did not get past the start page' : `Furthest: ${STAGE_NAMES[cell.reached].toLowerCase()}`;
  return `<div class="track" role="img" aria-label="${esc(where)}">${steps}</div><span class="where">${where}</span>`;
}

function runKind(run) {
  if (run.pass) return 'pass';
  if (run.outcome === 'harness_error') return 'void';
  return 'fail';
}

function storeRows() {
  const others = ['local', 'default', 'mac', 'stealth', 'residential'];
  return stores.map((site) => {
    const cell = sets.best[site];
    const dots = cell.runs.map((run) => {
      const kind = runKind(run);
      return `<i class="dot ${kind}" data-tip="${esc(`Run ${run.attempt}: ${plain(run.outcome)}`)}"></i>`;
    }).join('');
    const strip = others.map((id) => {
      const other = sets[id][site];
      const setup = SETUPS.find((entry) => entry.id === id);
      if (!other) return `<i class="cell none" data-tip="${esc(`${setup.short}: not run`)}"></i>`;
      return `<i class="cell ${other.ending}" data-tip="${esc(`${setup.short}: ${ENDINGS[other.ending].label.toLowerCase()}, ${other.passes} of ${other.graded} passed`)}"></i>`;
    }).join('');
    return `<tr data-ending="${cell.ending}">
  <th scope="row"><span class="store">${logo(site)}<span><strong>${esc(site)}</strong><small>${esc(tasks[site]?.category ?? '')}</small></span></span></th>
  <td class="c-setup">${esc(SETUP_LABEL[picks[site].setup] ?? picks[site].setup)}</td>
  <td class="c-track">${track(cell)}</td>
  <td class="c-runs"><span class="dots">${dots}</span><span class="num">${cell.passes}/${cell.graded}</span></td>
  <td class="c-strip"><span class="strip">${strip}</span></td>
  <td class="c-end"><span class="chip ${cell.ending}">${icon(cell.ending)}${ENDINGS[cell.ending].label}</span><small>${esc(reason(cell))}</small></td>
</tr>`;
  }).join('\n');
}

function filters() {
  const buttons = [['all', 'All stores', stores.length], ...ORDER.map((ending) => [ending, ENDINGS[ending].label, best[ending].length])];
  return `<div class="filters" role="group" aria-label="Filter stores by result">${buttons.map(([tag, label, count], i) => `<button type="button" data-tag="${tag}" aria-pressed="${i === 0}">${label}<span>${count}</span></button>`).join('')}</div>`;
}

function probe(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    return Math.round(Number(out.trim())) || 0;
  } catch {
    return 0;
  }
}
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
function recordingList() {
  const dir = path.join(published, 'recordings');
  return fs.readdirSync(dir).filter((file) => file.endsWith('.mp4')).map((file) => {
    const [name, , setupId] = file.replace('.mp4', '').split('-');
    const site = stores.find((store) => store.split('.')[0] === name);
    const setup = SETUP_LABEL[`anchor-${setupId}`];
    const cell = site && setup && sets[setupId][site];
    if (!cell) return null;
    const seconds = probe(path.join(dir, file));
    return { file, site, cell, seconds, setup };
  }).filter(Boolean).sort((a, b) => stores.indexOf(a.site) - stores.indexOf(b.site));
}
function recordings(list) {
  return list.map((item) => `<figure class="ev">
  <div class="ev-media"><video muted playsinline preload="none" data-src="${rel}/recordings/${item.file}#t=${Math.round(item.seconds * 0.86)}"></video>
    <button type="button" class="ev-play" aria-label="Play the ${esc(item.site)} recording with controls"><span class="ev-disc"><svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 3.9v12.2a.8.8 0 0 0 1.2.7l10-6.1a.8.8 0 0 0 0-1.4l-10-6.1A.8.8 0 0 0 6 3.9Z"/></svg></span>${item.seconds ? `<span class="ev-time">${clock(item.seconds)}</span>` : ''}</button><i class="ev-bar" aria-hidden="true"></i></div>
  <figcaption><div class="ev-site">${logo(item.site)}<strong>${esc(item.site)}</strong><span class="chip ${item.cell.ending}">${icon(item.cell.ending)}${ENDINGS[item.cell.ending].label}</span></div><small>${esc(item.setup)}, ${item.cell.passes} of ${item.cell.graded} runs passed</small></figcaption>
</figure>`).join('\n');
}

function explain(key) {
  if (key.startsWith('Stalled')) return { who: 'Agent can fix', tone: 'agent', text: 'The browser got past the front door and the agent reached the cart or the checkout. It then did not get the form accepted, or used up its steps. A stronger shopping agent can finish here with no change to the browser.' };
  if (key.startsWith('Sign-in')) return { who: 'Needs a signed-in run', tone: 'signin', text: 'The store has no guest checkout. The agent built the cart, then checkout asked for an account. The task says guest only, so the run stops there. This is the store’s rule, not a block.' };
  if (key.startsWith('Stopped by an edge')) return { who: 'Browser has to get in', tone: 'blocked', text: 'The store’s network edge refused the request before any page loaded. The agent never had a page to act on.' };
  if (key.startsWith('Stopped by')) return { who: 'Browser has to get in', tone: 'blocked', text: `${key.replace('Stopped by ', '')} is a bot-detection service. It challenged the browser before the agent could reach a product, so nothing the agent does changes the result.` };
  if (key.startsWith('Store served')) return { who: 'Cause not known yet', tone: 'agent', text: 'The store answered with its own error page instead of the storefront, on every setup tried. It may be a block that looks like an outage, or a store fault.' };
  return { who: 'Cause not known yet', tone: 'agent', text: '' };
}
function causes() {
  const groups = {};
  for (const site of [...best.blocked, ...best.agent, ...best.signin]) {
    const key = reason(sets.best[site]);
    (groups[key] ??= []).push(site);
  }
  return Object.entries(groups).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([key, sites]) => {
    const note = explain(key);
    return `<li><div class="cause"><strong>${esc(key)}</strong><span class="who ${note.tone}">${esc(note.who)}</span></div><span class="cause-n">${sites.length}<small>${sites.length === 1 ? 'store' : 'stores'}</small></span>${logoRow(sites)}<p class="cause-why">${esc(note.text)}</p></li>`;
  }).join('');
}

const clips = recordingList();
const promptDoc = fs.readFileSync(path.join(repo, 'docs/adapter-prompt.md'), 'utf8');
const promptBody = promptDoc.split('```text\n')[1].split('\n```')[0];
const agentPrompt = `First clone https://github.com/anchorbrowser/commerce-bench next to my agent's code, then run "npm install" and "npx playwright install chromium" in it.\n\n${promptBody}`;
const agentIcon = (name) => fs.readFileSync(path.join(here, 'icons', `${name}.svg`), 'utf8').replace(/<title>[^<]*<\/title>/, '').replace(/ fill="[^"]*"/g, '').replace('<svg ', '<svg width="16" height="16" fill="currentColor" aria-hidden="true" ');
const agentIcons = ['claude', 'cursor', 'githubcopilot', 'windsurf'].map(agentIcon).join('');
function actions() {
  return `<div class="cta">
      <button type="button" class="copy" data-state="idle"><span class="copy-icons">${agentIcons}</span><span class="copy-label"><span data-when="idle">Copy prompt for your agent</span><span data-when="done" aria-hidden="true"><svg viewBox="0 0 12 12" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.4 5 8.8 9.6 3.4"/></svg>Copied to clipboard</span></span></button>
      <a class="star" href="https://github.com/anchorbrowser/commerce-bench"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 .9l2.1 4.5 4.9.6-3.6 3.4.9 4.9L8 11.9l-4.3 2.4.9-4.9L1 6l4.9-.6z"/></svg>Star the repo<span class="star-n" hidden></span></a>
    </div>
    <p class="cta-note">The prompt tells your coding agent how to write an adapter, so the bench can run your own shopping agent on these stores.</p>
    <textarea class="prompt-src" hidden readonly>${esc(agentPrompt)}</textarea>
    <span class="vh" role="status" aria-live="polite"></span>`;
}
const css = fs.readFileSync(path.join(here, 'site.css'), 'utf8');
const js = fs.readFileSync(path.join(here, 'site.js'), 'utf8');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Commerce Bench: which stores let a shopping agent check out</title>
<script>document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||localStorage.getItem('cb-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wght@400..700&family=Instrument+Serif&display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body>
<header class="top">
  <a class="brand" href="#top">Commerce Bench</a>
  <nav aria-label="Sections"><a href="#setups">Setups</a><a href="#stores">Stores</a><a href="#stopped">Why runs stopped</a><a href="#recordings">Recordings</a><a href="#method">Method</a></nav>
  <div class="top-end"><button type="button" class="theme" aria-label="Switch between light and dark">Theme</button><a class="gh" href="https://github.com/anchorbrowser/commerce-bench">Open source on GitHub</a></div>
</header>
<main id="top">
<section class="hero">
  <div class="hero-text">
    <h1>Which stores let a shopping agent check out?</h1>
    <p class="lede">One agent, ${stores.length} real stores, one task: find the product, add it to the cart, check out as a guest, stop before payment. Only the browser changed. Anchor got the agent past the front door at ${inBest.length} stores, Chromium on a laptop at ${inLocal.length}. Once in, the agent finished checkout at ${best.finished.length}. The other ${inBest.length - best.finished.length} stopped on an agent stall or on a store with no guest checkout.</p>
    ${actions()}
    <dl class="meta"><div><dt>Updated</dt><dd>${date}</dd></div><div><dt>Runs</dt><dd>${index.all_runs.rows}</dd></div><div><dt>Stores</dt><dd>${stores.length}</dd></div><div><dt>Runs per store</dt><dd>3</dd></div></dl>
  </div>
  ${receipt()}
</section>

<section class="picks" aria-label="Three findings">
  <article><h2>Anchor got in at ${inBest.length} of ${stores.length} stores</h2><p>Chromium on a laptop got in at ${inLocal.length}. ${rescued.length} stores that turned the laptop away let Anchor in.</p>${logoRow(rescued)}</article>
  <article><h2>${best.finished.length} of those ${inBest.length} finished checkout</h2><p>${best.agent.length} more stopped on an agent stall and ${best.signin.length} on a store with no guest checkout. Neither is a browser block.</p>${logoRow(best.finished)}</article>
  <article><h2>${best.blocked.length} stayed shut on every setup</h2><p>A bot wall or an error page ended most runs, whichever browser was used.</p>${logoRow(best.blocked)}</article>
</section>

<section id="setups" class="panel">
  <div class="panel-head"><h2>Same agent, four browsers: who gets past the front door?</h2><p>Getting in is the browser\u2019s job. Finishing checkout after that depends on the agent, which is what Commerce Bench helps you tune. Each bar is ${stores.length} stores. A store counts as got in unless a bot wall or an error page ended most of its runs.</p></div>
  ${setupBars()}
</section>

<section id="stores" class="panel">
  <div class="panel-head"><h2>Store by store</h2><p>Each row shows the Anchor setup that did best for that store, how far along the checkout the agent got, and its three runs.</p></div>
  ${filters()}
  <div class="scroll"><table>
    <thead><tr><th scope="col">Store</th><th scope="col">Best setup</th><th scope="col">Checkout progress</th><th scope="col">Runs</th><th scope="col"><span class="strip-head"><abbr title="Laptop">L</abbr><abbr title="Default session">D</abbr><abbr title="Mac hardware">M</abbr><abbr title="Proxy with extra stealth">S</abbr><abbr title="Residential proxy">R</abbr></span></th><th scope="col">Result</th></tr></thead>
    <tbody>
${storeRows()}
    </tbody>
  </table></div>
  <p class="foot">The five squares compare setups for the same store: laptop, default session, Mac hardware, proxy with extra stealth, residential proxy. An empty square means that setup was not run there.</p>
</section>

<section id="stopped" class="panel">
  <div class="panel-head"><h2>Why runs stopped</h2><p>The ${stores.length - best.finished.length} stores that did not finish, grouped by what ended most of their runs on the best setup.</p></div>
  <ul class="causes">${causes()}</ul>
</section>

<section id="recordings" class="panel">
  <div class="panel-head"><h2>Watch the runs</h2><p>${clips.length} session recordings from Anchor, one passing run per store, full length and unedited. Hover to preview, click to play from the start. Shopper details are placeholders.</p></div>
  <div class="evgrid">
${recordings(clips)}
  </div>
</section>

<section id="method" class="panel method">
  <div class="panel-head"><h2>How to read this</h2></div>
  <div class="cols">
    <div><h3>What ran</h3><p>A small reference agent, a Claude tool-use loop on claude-opus-5-5, with the same grader for every row. The agent is a bundled example, not a tuned shopper.</p></div>
    <div><h3>What counts</h3><p>The grader reads the browser, not the agent's claim. A run passes when the store accepts the placeholder shipping details. Runs where the browser itself failed are not graded.</p></div>
    <div><h3>What to hold back</h3><p>Three runs per store per setup is a small sample, and stores change between runs. The best setup is picked after the runs, so it shows what to use, not one configuration tested everywhere.</p></div>
  </div>
</section>
</main>
<footer>
  <div class="foot-main">
    <div class="foot-brand"><a class="brand" href="#top">Commerce Bench</a><p>An open harness for testing shopping agents on real stores. Built by <a href="https://anchorbrowser.io/">Anchor Browser</a>, the cloud browser for AI agents.</p></div>
    <nav class="foot-social" aria-label="Follow Anchor"><span>Follow Anchor</span><a href="https://x.com/AnchorBrowser">${agentIcon('x')}X</a><a href="https://www.linkedin.com/company/anchorbrowser/">${agentIcon('linkedin')}LinkedIn</a><a href="https://github.com/anchorbrowser">${agentIcon('github')}GitHub</a></nav>
  </div>
  <div class="foot-legal"><span>\u00a9 ${new Date(`${index.date}T00:00:00Z`).getUTCFullYear()} <a href="https://anchorbrowser.io/">Anchor Browser</a>. Code under Apache-2.0.</span><a href="https://github.com/anchorbrowser/commerce-bench/tree/main/results/published">Every run row is in the repository</a></div>
</footer>
<div class="tip" role="tooltip" hidden></div>
<script>${js}</script>${dist ? '\n<script defer src="/_vercel/insights/script.js"></script>' : ''}
</body>
</html>
`;
if (dist) {
  fs.mkdirSync(path.join(dist, 'recordings'), { recursive: true });
  fs.cpSync(path.join(here, 'logos'), path.join(dist, 'logos'), { recursive: true });
  for (const clip of clips) fs.copyFileSync(path.join(published, 'recordings', clip.file), path.join(dist, 'recordings', clip.file));
}
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(JSON.stringify({ stores: stores.length, best: Object.fromEntries(ORDER.map((e) => [e, best[e].length])), local: Object.fromEntries(ORDER.map((e) => [e, local[e].length])), gotIn: { best: inBest.length, mac: gotIn(tally('mac')).length, default: gotIn(tally('default')).length, local: inLocal.length }, rescued: rescued.length, times }));
