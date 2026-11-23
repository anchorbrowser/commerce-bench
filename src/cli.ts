import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadAgent } from './agents.ts';
import type { BrowserBackend } from './browser.ts';
import { writeReport } from './report.ts';
import { runAll } from './run.ts';
import { selftest } from './selftest.ts';
import { loadTasks } from './tasks.ts';
import { describeError } from './util.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = /^[a-z0-9][a-z0-9._@-]{0,63}$/i;

const HELP = `commerce-bench: test a shopping agent on real ecommerce sites. Runs stop before payment.

Usage:
  commerce-bench run --agent <file> [options]    run an agent against task files
  commerce-bench report --in <dir>[,<dir>]       build leaderboard.json and report.html
  commerce-bench selftest                        prove the grader on the local mock shop
  commerce-bench validate [--tasks <dir>]        check task files

Run options:
  --agent <file>       agent file (see agents/ and examples/agents/)
  --tasks <path>       task file or folder. Default: tasks/
  --site <a,b>         only these task ids
  --runs <n>           runs per site. Default: 3
  --out <dir>          results folder. Reuse it to resume. Default: results/<agent>
  --browser <kind>     local (default), cdp, or anchor
  --cdp-url <url>      for --browser cdp. Or set COMMERCE_BENCH_CDP_URL
  --anchor-config <f>  session settings for --browser anchor (see configs/anchor/)
  --headed             show the local browser window
  --label <name>       name this row in the report, for example my-agent@anchor.
                       Use it to compare one agent on two browsers
  --shopper <file>     shopper details to use instead of shoppers/<region>.json
  --force              run again even if a result exists
`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      agent: { type: 'string' },
      tasks: { type: 'string' },
      site: { type: 'string' },
      runs: { type: 'string' },
      out: { type: 'string' },
      in: { type: 'string' },
      browser: { type: 'string' },
      'cdp-url': { type: 'string' },
      shopper: { type: 'string' },
      label: { type: 'string' },
      'anchor-config': { type: 'string' },
      headed: { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (!command || command === 'help' || values.help) {
    console.log(HELP);
    return;
  }

  if (command === 'validate') {
    const tasks = loadTasks(values.tasks ?? path.join(ROOT, 'tasks'));
    const drafts = tasks.filter((task) => task.status !== 'verified').length;
    console.log(`${tasks.length} task files are valid. ${drafts} are still marked draft.`);
    return;
  }

  if (command === 'selftest') {
    const ok = await selftest({ root: ROOT, outDir: values.out, headed: values.headed });
    process.exit(ok ? 0 : 1);
  }

  if (command === 'report') {
    if (!values.in) fail('report needs --in <results dir>');
    const inputs = values.in.split(',').map((dir) => path.resolve(dir.trim()));
    const report = writeReport(inputs, path.resolve(values.out ?? inputs[0]));
    console.log(`Wrote ${report.leaderboard}\nWrote ${report.html}`);
    return;
  }

  if (command === 'run') {
    if (!values.agent) fail('run needs --agent <file>');
    const agent = loadAgent(values.agent, ROOT);
    if (values.label) {
      if (!LABEL.test(values.label)) fail('--label must be a short name made of letters, digits, ".", "_", "-" or "@"');
      agent.name = values.label;
    }
    const anchorConfigArg = values['anchor-config'] ?? process.env.COMMERCE_BENCH_ANCHOR_SESSION;
    const anchorConfig = anchorConfigArg ? path.resolve(anchorConfigArg) : undefined;
    if (anchorConfig && !fs.existsSync(anchorConfig)) fail(`--anchor-config file not found: ${anchorConfig}`);
    const wanted = values.site?.split(',').map((id) => id.trim());
    const tasks = loadTasks(values.tasks ?? path.join(ROOT, 'tasks')).filter((task) => !wanted || wanted.includes(task.id));
    if (tasks.length === 0) fail('No task files matched.');
    const runs = Number(values.runs ?? 3);
    if (!Number.isInteger(runs) || runs < 1) fail('--runs must be a positive integer');
    const backend = (values.browser ?? 'local') as BrowserBackend;
    if (!['local', 'cdp', 'anchor'].includes(backend)) fail('--browser must be local, cdp or anchor');
    if (backend === 'cdp' && runs * tasks.length > 1) {
      console.log('Note: every run reuses the one browser behind --cdp-url. Clear its state between runs yourself.');
    }
    const outDir = path.resolve(values.out ?? path.join(ROOT, 'results', agent.name));
    console.log(`${agent.name} (${agent.track}) on ${tasks.length} sites, ${runs} runs each. Results in ${outDir}`);
    await runAll({
      root: ROOT,
      outDir,
      agent,
      tasks,
      runs,
      browser: {
        backend,
        headed: values.headed,
        cdpUrl: values['cdp-url'] ?? process.env.COMMERCE_BENCH_CDP_URL,
        anchorConfig,
        anchorDomain: process.env.COMMERCE_BENCH_ANCHOR_DOMAIN !== 'off',
        recordings: process.env.COMMERCE_BENCH_RECORDINGS !== 'off',
      },
      shopperFile: values.shopper,
      force: values.force,
      onRecord: (record, index, total) =>
        console.log(
          `[${index}/${total}] ${record.task_id} run ${record.attempt}: ${record.outcome} (furthest: ${record.furthest_stage ?? 'none'}, ${(record.duration_ms / 1_000).toFixed(0)}s)`
        ),
    });
    const report = writeReport([outDir], outDir);
    console.log(`\nWrote ${report.leaderboard}\nWrote ${report.html}`);
    return;
  }

  fail(`Unknown command "${command}".\n\n${HELP}`);
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
