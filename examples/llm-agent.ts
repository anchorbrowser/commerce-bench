import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Page } from 'playwright';

type Task = {
  goal: string;
  start_url: string;
  stop_at: string;
  rules: string[];
  shopper: unknown;
  browser?: { cdp_url: string };
  deadline_s: number;
  evidence_dir: string;
};

const MODEL = process.env.COMMERCE_BENCH_MODEL ?? 'claude-opus-5-5';
const MAX_STEPS = Number(process.env.COMMERCE_BENCH_MAX_STEPS ?? 45);
const MODEL_TIMEOUT_MS = 180_000;
const ACTION_TIMEOUT_MS = 90_000;
const STALLED = Symbol('stalled');
const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([work, new Promise<typeof STALLED>((resolve) => setTimeout(() => resolve(STALLED), ms))]);
const PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
};

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: 'goto',
    description: 'Open a URL in the browser tab.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'click',
    description: 'Click the element with this id from the latest page state.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'type',
    description: 'Replace the text in an input with this id. Set submit to press Enter afterwards.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['id', 'text'],
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a <select> with this id, by its visible label.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' }, label: { type: 'string' } }, required: ['id', 'label'] },
  },
  {
    name: 'press',
    description: 'Press a keyboard key such as Enter, Escape, Tab or ArrowDown.',
    input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'scroll',
    description: 'Scroll the page down or up by one screen and read the page again.',
    input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } }, required: ['direction'] },
  },
  {
    name: 'finish',
    description: 'End the task and report what happened. Call this exactly once, when you stop.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
        claimed_stage: { type: 'string', enum: ['product', 'cart', 'checkout', 'shipping', 'payment'] },
        total_amount: { type: 'number', description: 'Order total shown on the page, if you saw one.' },
        total_currency: { type: 'string' },
        failure_code: { type: 'string', description: 'For example bot_detected, captcha_required, login_required, product_not_available.' },
        message: { type: 'string' },
      },
      required: ['status'],
    },
  },
];

function describePage(): { elements: string[]; text: string } {
  const seen: string[] = [];
  const nodes = document.querySelectorAll<HTMLElement>(
    'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=radio], [role=checkbox], [role=option], [role=combobox], [role=menuitem], [role=tab]'
  );
  let next = 1;
  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
    const near = rect.bottom > -200 && rect.top < innerHeight + 1200;
    if (!visible || !near) {
      el.removeAttribute('data-cb-id');
      continue;
    }
    if (next > 140) break;
    el.setAttribute('data-cb-id', String(next));
    const input = el as HTMLInputElement;
    const label = (el.innerText || el.getAttribute('aria-label') || input.placeholder || input.labels?.[0]?.innerText || el.getAttribute('title') || input.name || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 70);
    const tag = el.tagName.toLowerCase();
    const kind = tag === 'input' ? `input:${input.type}` : (el.getAttribute('role') ?? tag);
    const value = tag === 'input' || tag === 'textarea' || tag === 'select' ? ` value="${String(input.value).slice(0, 40)}"` : '';
    const checked = input.checked ? ' checked' : '';
    const disabled = input.disabled || el.getAttribute('aria-disabled') === 'true' ? ' disabled' : '';
    seen.push(`[${next}] ${kind} "${label}"${value}${checked}${disabled}`);
    next += 1;
  }
  return { elements: seen, text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 1800) };
}

async function readPage(page: Page): Promise<string> {
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1_200);
  const state = await page.evaluate(describePage).catch(() => ({ elements: [], text: '(page could not be read)' }));
  return `URL: ${page.url()}\nTitle: ${await page.title().catch(() => '')}\nElements:\n${state.elements.join('\n')}\nPage text: ${state.text}`;
}

async function act(page: Page, name: string, input: Record<string, unknown>): Promise<string> {
  const target = (id: unknown) => page.locator(`[data-cb-id="${Number(id)}"]`).first();
  try {
    if (name === 'goto') await page.goto(String(input.url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (name === 'click') {
      await target(input.id)
        .click({ timeout: 8_000 })
        .catch(() => target(input.id).evaluate((el) => (el as HTMLElement).click()));
    }
    if (name === 'type') {
      await target(input.id).fill(String(input.text), { timeout: 8_000 });
      if (input.submit) await page.keyboard.press('Enter');
    }
    if (name === 'select') await target(input.id).selectOption({ label: String(input.label) }, { timeout: 8_000 });
    if (name === 'press') await page.keyboard.press(String(input.key));
    if (name === 'scroll') await page.mouse.wheel(0, input.direction === 'up' ? -800 : 800);
    return await readPage(page);
  } catch (error) {
    return `Action failed: ${String(error).split('\n')[0].slice(0, 300)}\n${await readPage(page)}`;
  }
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const task = JSON.parse(raw) as Task;
const emit = (result: Record<string, unknown>) => {
  console.log(JSON.stringify(result));
  process.exit(0);
};
if (!task.browser) emit({ status: 'failed', failure: { code: 'stuck_at_start', message: 'This agent needs the harness browser.' } });

const client = new Anthropic({ timeout: MODEL_TIMEOUT_MS });
const browser = await chromium.connectOverCDP(task.browser!.cdp_url);
const context = browser.contexts()[0];
let page = context.pages()[0] ?? (await context.newPage());
context.on('page', (opened) => (page = opened));

const system = `You are a shopping agent driving a real browser tab. ${task.goal}

Rules:
${task.rules.map((rule) => `- ${rule}`).join('\n')}

Shopper details to use at checkout:
${JSON.stringify(task.shopper, null, 2)}

How to work:
- Each action returns the page as a numbered list of elements plus some page text. Ids change after every action, so use ids from the latest result only.
- Close cookie banners and popups that cover the page. Use the site search to find the product.
- If the site shows a human check, a captcha or a block page, wait a few seconds and open the page once more. If it is still there, stop and report it. Do not try to get around it.
- When you stop, call finish. Report the furthest stage you actually reached and the order total the page shows. If you did not reach the goal, say so.`;

const messages: Anthropic.Beta.BetaMessageParam[] = [
  { role: 'user', content: `Start. The tab is blank. Open ${task.start_url} first.` },
];
const usage = { input: 0, output: 0, cacheRead: 0 };
const deadline = Date.now() + (task.deadline_s - 30) * 1_000;
let steps = 0;
let final: Record<string, unknown> | null = null;

try {
  while (!final && steps < MAX_STEPS && Date.now() < deadline) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system,
      tools: TOOLS,
      messages,
    });
    usage.input += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.output += response.usage.output_tokens;
    if (response.stop_reason === 'refusal') {
      final = { status: 'failed', failure: { code: 'stuck_at_start', message: 'The model declined the request.' } };
      break;
    }
    messages.push({ role: 'assistant', content: response.content });
    const calls = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
    if (calls.length === 0) {
      messages.push({ role: 'user', content: 'Continue with a tool call, or call finish if you have stopped.' });
      continue;
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const input = call.input as Record<string, unknown>;
      if (call.name === 'finish') {
        final = {
          status: input.status,
          claimed_stage: input.claimed_stage,
          reported_total: typeof input.total_amount === 'number' ? { amount: input.total_amount, currency: input.total_currency } : undefined,
          failure: input.failure_code || input.message ? { code: input.failure_code, message: input.message } : undefined,
        };
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Recorded.' });
        continue;
      }
      steps += 1;
      const seen = await within(act(page, call.name, input), ACTION_TIMEOUT_MS);
      if (seen === STALLED) {
        final = { status: 'failed', failure: { code: 'browser_unresponsive', message: 'The browser stopped answering.' } };
        break;
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: seen });
    }
    if (results.length === calls.length) messages.push({ role: 'user', content: results });
  }
} catch (error) {
  const message =
    error instanceof Anthropic.RateLimitError
      ? 'Model API rate limit.'
      : error instanceof Anthropic.APIError
        ? `Model API error ${error.status}.`
        : String(error).split('\n')[0];
  final = { status: 'failed', failure: { code: 'stuck_at_start', message } };
}

await within(page.screenshot({ path: path.join(task.evidence_dir, 'agent-final.png') }).catch(() => undefined), 20_000);
const price = PRICE_PER_MTOK[MODEL];
emit({
  ...(final ?? { status: 'failed', failure: { code: 'timeout', message: 'Ran out of steps or time before finishing.' } }),
  final_url: page.url(),
  evidence: { final: 'agent-final.png' },
  steps,
  cost_usd: price
    ? Math.round(((usage.input * price.input + usage.cacheRead * price.cacheRead + usage.output * price.output) / 1e6) * 1e4) / 1e4
    : undefined,
});
