import { chromium } from 'playwright';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const task = JSON.parse(raw) as { start_url: string; browser?: { cdp_url: string } };

if (!task.browser) {
  console.log(JSON.stringify({ status: 'failed', failure: { code: 'stuck_at_start', message: 'No browser was given.' } }));
  process.exit(0);
}

const browser = await chromium.connectOverCDP(task.browser.cdp_url);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());
let message = 'Opened the start page and stopped.';
try {
  await page.goto(task.start_url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(8_000);
} catch (error) {
  message = String(error).split('\n')[0];
}
console.log(JSON.stringify({ status: 'failed', failure: { code: 'stuck_at_start', message }, final_url: page.url(), steps: 1 }));
process.exit(0);
