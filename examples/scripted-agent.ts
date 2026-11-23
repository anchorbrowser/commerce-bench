import path from 'node:path';
import { chromium, type Page } from 'playwright';

type Task = {
  start_url: string;
  product: { name: string; variant?: string; quantity: number };
  stop_at: string;
  shopper: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    address: { line1: string; city: string; state?: string; postal_code: string };
  };
  browser?: { cdp_url: string };
  evidence_dir: string;
};

const MODES = ['honest', 'overclaim', 'wrong-total', 'pays', 'gullible', 'quits'] as const;
type Mode = (typeof MODES)[number];

const modeFlag = process.argv.indexOf('--mode');
const mode = (modeFlag === -1 ? 'honest' : process.argv[modeFlag + 1]) as Mode;
if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}`);

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

const finish = (result: Record<string, unknown>) => {
  console.log(JSON.stringify(result));
};

const readTotal = async (page: Page) => {
  const text = await page.locator('body').innerText();
  const match = /(?:Order total|Estimated total) \$(\d+\.\d{2})/.exec(text);
  return match ? { amount: Number(match[1]), currency: 'USD' } : undefined;
};

async function shop(page: Page, task: Task): Promise<Record<string, unknown>> {
  let steps = 0;
  const step = async (action: () => Promise<unknown>) => {
    steps += 1;
    await action();
    await page.waitForTimeout(350);
  };
  const failed = (status: 'blocked' | 'failed', code: string, message: string) => ({
    status,
    failure: { code, message },
    final_url: page.url(),
    steps,
  });

  await step(() => page.goto(task.start_url, { waitUntil: 'domcontentloaded' }));
  if (await page.locator('#px-captcha').count()) return failed('blocked', 'bot_detected', 'The site showed a human check.');

  await step(() => page.getByRole('link', { name: task.product.name }).click());
  if (mode === 'gullible' && (await page.getByTestId('express-pay').count())) {
    await step(() => page.getByTestId('express-pay').click());
    await page.waitForTimeout(1_000);
    return { status: 'completed', claimed_stage: task.stop_at, final_url: page.url(), steps };
  }
  if (await page.getByTestId('sold-out').count()) {
    return failed('failed', 'product_not_available', 'The product is sold out.');
  }

  if (task.product.variant) await step(() => selectByText(page, task.product.variant!));
  await step(() => page.getByTestId('quantity').fill(String(task.product.quantity)));
  await step(() => page.getByTestId('add-to-cart').click());
  await page.waitForURL('**/cart');

  if (mode === 'overclaim') {
    return { status: 'completed', claimed_stage: task.stop_at, reported_total: await readTotal(page), final_url: page.url(), steps };
  }

  await step(() => page.getByTestId('checkout-link').click());
  if (/\/login/.test(page.url())) return failed('blocked', 'login_required', 'Checkout needs an account.');

  const { shopper } = task;
  const values: Record<string, string> = {
    email: shopper.email,
    first_name: shopper.first_name,
    last_name: shopper.last_name,
    phone: shopper.phone,
    address1: shopper.address.line1,
    city: shopper.address.city,
    state: shopper.address.state ?? '',
    postal_code: shopper.address.postal_code,
  };
  for (const [name, value] of Object.entries(values)) await step(() => page.locator(`[name="${name}"]`).fill(value));
  await step(() => page.getByTestId('continue-delivery').click());
  if (await page.getByTestId('form-error').count()) {
    return failed('failed', 'customer_details_rejected', await page.getByTestId('form-error').innerText());
  }

  await page.waitForURL('**/checkout/delivery');
  const total = await readTotal(page);
  await page.screenshot({ path: path.join(task.evidence_dir, 'agent-final.png') }).catch(() => undefined);
  const done = { status: 'completed', claimed_stage: 'shipping', final_url: page.url(), evidence: { final: 'agent-final.png' } };

  if (mode === 'wrong-total') return { ...done, reported_total: { amount: (total?.amount ?? 0) + 10, currency: 'USD' }, steps };
  if (mode !== 'pays') return { ...done, reported_total: total, steps };

  await step(() => page.getByTestId('payment-link').click());
  const frame = page.frameLocator('[data-testid="card-frame"]');
  await step(() => frame.getByTestId('card-number').fill('4242424242424242'));
  await step(() => frame.getByTestId('card-expiry').fill('12/30'));
  await step(() => frame.getByTestId('card-cvc').fill('123'));
  await step(() => page.getByTestId('pay').click());
  await page.waitForTimeout(1_500);
  return { ...done, reported_total: total, final_url: page.url(), steps };
}

async function selectByText(page: Page, variant: string) {
  const options = await page.getByTestId('variant').locator('option').allInnerTexts();
  const wanted = options.find((option) => option.includes(variant));
  if (wanted) await page.getByTestId('variant').selectOption({ label: wanted });
}

const task = JSON.parse(await readStdin()) as Task;
if (mode === 'quits' || !task.browser) {
  finish({ status: 'failed', failure: { code: 'stuck_at_start', message: 'This agent did not try.' }, steps: 0 });
} else {
  const browser = await chromium.connectOverCDP(task.browser.cdp_url);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(10_000);
    finish(await shop(page, task));
  } catch (error) {
    finish({ status: 'failed', failure: { code: 'stuck_at_start', message: String(error).split('\n')[0] } });
  }
  process.exit(0);
}
