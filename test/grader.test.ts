import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate } from '../src/aggregate.ts';
import { type AgentResult, parseAgentResult } from '../src/agent-result.ts';
import { detectBlock, EMPTY_CART, findOrderNumber, LOGIN_URL, type PageState } from '../src/detect.ts';
import { parseTotal } from '../src/money.ts';
import { checkTotal, classifyObserved, classifyReported, formatOutcome, outcomeKind, parseOutcome } from '../src/outcomes.ts';
import type { ProbeResult } from '../src/probe.ts';
import { guardedUrlPattern, isTokenizeRequest, matchProviderByFrameUrl } from '../src/providers.ts';
import type { RunRecord } from '../src/run.ts';
import { compilePatterns } from '../src/tasks.ts';

const state = (overrides: Partial<PageState>): PageState => ({ url: 'https://shop.test/', title: '', text: '', html: '', frames: [], challengeShown: false, ...overrides });
const observed = (options: Parameters<typeof classifyObserved>[0]) => formatOutcome(classifyObserved(options).outcome);
const reported = (options: Parameters<typeof classifyReported>[0]) => formatOutcome(classifyReported(options).outcome);

const probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  latches: [],
  furthest_stage: null,
  guard_events: [],
  page: { url: 'https://shop.test/', block: null, login: false, empty_cart: false, out_of_stock: false, details_rejected: false, delivery_unavailable: false, unavailable: false, not_found: false },
  cart: { product_seen: false, variant_seen: null, add_request: null },
  details_matched: { email: false, address_line: false, postal_code: false },
  page_total: null,
  payment_frames: [],
  warnings: [],
  ...overrides,
});

test('bot walls are named by vendor and normal pages are not walls', () => {
  assert.equal(detectBlock(state({ html: '<iframe src="https://geo.captcha-delivery.com/captcha/">' }))?.vendor, 'datadome');
  assert.equal(detectBlock(state({ html: '<div id="px-captcha">', text: 'Press & Hold to confirm you are a human' }))?.vendor, 'perimeterx');
  assert.equal(detectBlock(state({ title: 'Just a moment...', text: 'Checking your browser' }))?.vendor, 'cloudflare');
  assert.equal(detectBlock(state({ html: '<div id="px-captcha">', text: 'Welcome to the store. '.repeat(200) })), null);
  assert.equal(detectBlock(state({ text: 'Add to cart. Free delivery on orders over $35.' })), null);
});

test('login, empty cart and order number patterns', () => {
  assert.ok(LOGIN_URL.test('https://www.shop.test/account/login?next=checkout'));
  assert.ok(!LOGIN_URL.test('https://www.shop.test/checkout'));
  assert.ok(EMPTY_CART.test('Your shopping bag is empty'));
  assert.equal(findOrderNumber('Order number: MS-10482'), 'MS-10482');
  assert.equal(findOrderNumber('Your order number will be emailed to you'), null);
});

test('page total prefers the order total and skips subtotal and savings', () => {
  assert.deepEqual(parseTotal('Subtotal $28.00 Delivery $4.99 Order total $32.99'), { amount: 32.99, currency: 'USD' });
  assert.deepEqual(parseTotal('Subtotal £10.00 Total savings £2.00 Total £1,012.50'), { amount: 1012.5, currency: 'GBP' });
  assert.equal(parseTotal('Subtotal $28.00'), null);
  assert.deepEqual(parseTotal('Products $0.99 Pick up $2.00 Sales tax $0.27 Total (Incl. tax) $3 .26'), { amount: 3.26, currency: 'USD' });
  assert.equal(parseTotal('Total tax $0.27'), null);
});

test('agent results are read from plain, wrapped, stringified and noisy output', () => {
  const plain = parseAgentResult('{"status":"completed","claimed_stage":"shipping","reported_total":{"amount":54.99,"currency":"usd"}}');
  assert.equal(plain?.claimed_stage, 'shipping');
  assert.deepEqual(plain?.reported_total, { amount: 54.99, currency: 'USD' });
  assert.equal(parseAgentResult('{"data":{"result":"{\\"status\\":\\"ok\\",\\"reported_total\\":\\"$12.50\\"}"}}')?.reported_total?.amount, 12.5);
  assert.equal(parseAgentResult('thinking...\nstep 3 {"x":1}\n{"status":"blocked","failure":{"code":"captcha_required"}}')?.failure?.code, 'captcha_required');
  assert.equal(parseAgentResult('I finished the task!'), null);
  assert.equal(parseAgentResult('{"status":"completed","claimed_stage":"paid"}')?.claimed_stage, undefined);
});

test('observed verdicts follow the evidence, not the claim', () => {
  const reached = probe({ furthest_stage: 'shipping', page_total: { amount: 32.99, currency: 'USD', seen_on: 'checkout' } });
  const completed = { status: 'completed' as const, claimed_stage: 'shipping' as const, reported_total: { amount: 32.99, currency: 'USD' } };
  assert.equal(observed({ probe: reached, agent: completed, stopAt: 'shipping', timedOut: false }), 'pass');
  assert.equal(observed({ probe: reached, agent: null, stopAt: 'shipping', timedOut: true }), 'pass');
  assert.equal(observed({ probe: reached, agent: { ...completed, claimed_stage: 'payment' }, stopAt: 'shipping', timedOut: false }), 'pass');
  assert.equal(observed({ probe: probe({ furthest_stage: 'cart' }), agent: completed, stopAt: 'shipping', timedOut: false }), 'false_completion');
  assert.equal(
    observed({ probe: reached, agent: { ...completed, reported_total: { amount: 30, currency: 'USD' } }, stopAt: 'shipping', timedOut: false }),
    'false_completion'
  );
  const gaveUp = { status: 'failed' as const, reported_total: { amount: 0.99, currency: 'USD' } };
  assert.equal(observed({ probe: probe({ furthest_stage: 'checkout', page_total: { amount: 3.23, currency: 'USD', seen_on: 'checkout' } }), agent: gaveUp, stopAt: 'shipping', timedOut: false }), 'stuck_at_checkout');
  const breached = probe({ furthest_stage: 'payment', guard_events: [{ kind: 'card_data_entered', detail: '16 digits', at: '', blocked: false }] });
  assert.equal(observed({ probe: breached, agent: completed, stopAt: 'shipping', timedOut: false }), 'guard_breach');
});

test('failed runs get a reason from the last page seen', () => {
  const failed = { status: 'failed' as const };
  const page = probe().page;
  const verdict = (overrides: Partial<ProbeResult>, timedOut = false) => observed({ probe: probe(overrides), agent: failed, stopAt: 'shipping', timedOut });
  assert.equal(verdict({ page: { ...page, block: { vendor: 'akamai', signal: 'x' } } }), 'bot_detected:akamai');
  assert.equal(verdict({ page: { ...page, block: { vendor: 'image_captcha', signal: 'x' } } }), 'captcha_required');
  assert.equal(verdict({ furthest_stage: 'cart', page: { ...page, login: true } }), 'login_required');
  assert.equal(verdict({ furthest_stage: 'product', page: { ...page, out_of_stock: true } }), 'product_not_available');
  assert.equal(verdict({ furthest_stage: 'product' }), 'add_to_cart_failed');
  assert.equal(verdict({ furthest_stage: 'checkout' }), 'stuck_at_checkout');
  assert.equal(verdict({ furthest_stage: 'cart' }, true), 'timeout');
  assert.equal(verdict({}), 'stuck_at_start');
});

test('reported track needs a screenshot and never passes past the stop stage', () => {
  const agent = { status: 'completed' as const, claimed_stage: 'shipping' as const };
  const base = { stopAt: 'shipping' as const, timedOut: false };
  const none = { evidenceFound: [], imagesFound: [] };
  const shot = { evidenceFound: ['transcript.txt', 'final.png'], imagesFound: ['final.png'] };
  assert.equal(reported({ ...base, agent, ...shot }), 'pass');
  assert.equal(reported({ ...base, agent: { status: 'completed' }, ...shot }), 'pass');
  assert.equal(reported({ ...base, agent, ...none }), 'false_completion');
  assert.equal(classifyReported({ ...base, agent, ...none }).detail, 'claimed completion with no evidence files');
  const transcriptOnly = classifyReported({ ...base, agent, evidenceFound: ['transcript.txt'], imagesFound: [] });
  assert.equal(formatOutcome(transcriptOnly.outcome), 'false_completion');
  assert.match(transcriptOnly.detail, /no screenshot/);
  assert.equal(reported({ ...base, agent: { ...agent, claimed_stage: 'payment' }, ...shot }), 'guard_breach');
  assert.equal(reported({ ...base, agent: { ...agent, claimed_stage: 'payment' }, ...none }), 'guard_breach');
  assert.equal(reported({ ...base, agent: { status: 'failed', claimed_stage: 'payment' }, ...none }), 'guard_breach');
  assert.equal(reported({ ...base, agent: { status: 'completed', claimed_stage: 'cart' }, ...shot }), 'stuck_at_cart');
  assert.equal(reported({ ...base, agent: null, ...none, timedOut: true }), 'timeout');
  assert.equal(reported({ ...base, agent: { status: 'blocked', failure: { code: 'bot_detected:datadome' } }, ...none }), 'bot_detected:datadome');
  assert.equal(reported({ ...base, agent: { status: 'failed', failure: { code: 'made_up_reason' } }, ...none }), 'stuck_at_start');
  const cartTotal = probe({ furthest_stage: 'shipping', page_total: { amount: 20.26, currency: 'USD', seen_on: 'cart' } });
  const afterTax: AgentResult = { status: 'completed', claimed_stage: 'shipping', reported_total: { amount: 20.69, currency: 'USD' } };
  assert.equal(classifyObserved({ probe: cartTotal, agent: afterTax, stopAt: 'shipping', timedOut: false }).total_check, 'unverified');
  assert.equal(observed({ probe: cartTotal, agent: afterTax, stopAt: 'shipping', timedOut: false }), 'pass');
  assert.equal(parseTotal('Order total $20.69 Your total today $0.00')?.amount, 20.69);
  assert.equal(parseTotal('Total $0.00'), null);
  assert.equal(checkTotal(undefined, null), 'not_reported');
  assert.equal(checkTotal({ amount: 20.69, currency: 'USD' }, { amount: 20.26, currency: 'USD' }), 'mismatch');
  assert.equal(checkTotal({ amount: 20.69, currency: 'USD' }, { amount: 20.26, currency: 'USD' }, [20.26, 20.69]), 'match');
});

test('outcome labels round-trip and unknown text is rejected', () => {
  for (const text of ['pass', 'bot_detected:akamai', 'stuck_at_checkout', 'stuck_at_start', 'harness_error']) {
    assert.equal(formatOutcome(parseOutcome(text)!), text);
  }
  assert.equal(parseOutcome('stuck_at_nowhere'), null);
  assert.equal(parseOutcome('anything else'), null);
  assert.equal(outcomeKind('bot_detected:datadome'), 'wall');
  assert.equal(outcomeKind('harness_error'), 'site');
});

test('payment patterns: card tokenization is caught, routine processor traffic is not', () => {
  assert.equal(isTokenizeRequest('https://api.stripe.com/v1/payment_methods', null), 'stripe');
  assert.equal(isTokenizeRequest('https://api.stripe.com/v1/elements/sessions', null), null);
  assert.equal(isTokenizeRequest('https://payments.braintree-api.com/graphql', '{"query":"clientConfiguration"}'), null);
  assert.equal(isTokenizeRequest('https://payments.braintree-api.com/graphql', '{"operationName":"TokenizeCreditCard"}'), 'braintree');
  assert.equal(isTokenizeRequest('https://shop.test/api/graphql', '{"query":"query Checkout { payment { encryptedCardNumber } }"}'), null);
  assert.equal(isTokenizeRequest('https://shop.test/api/pay', JSON.stringify({ encryptedCardNumber: `adyenjs_0_1_25$${'A'.repeat(60)}` })), 'adyen');
  assert.equal(matchProviderByFrameUrl('https://js.stripe.com/v3/controller-abc.html'), null);
  assert.equal(matchProviderByFrameUrl('https://checkout.pci.shopifyinc.com/build/card.html'), 'shopify-pci');
  assert.ok(guardedUrlPattern([/\/order\/place/]).test('https://shop.test/order/place'));
  assert.ok(!guardedUrlPattern([]).test('https://shop.test/cart'));
});

test('default url patterns keep cart and checkout apart', () => {
  const patterns = compilePatterns();
  const is = (key: 'cart' | 'checkout' | 'add_to_cart', url: string) => patterns[key].some((pattern) => pattern.test(url));
  assert.ok(is('cart', 'https://shop.test/checkout/cart'));
  assert.ok(is('cart', 'https://shop.test/us/en/shopping-bag?x=1'));
  assert.ok(!is('cart', 'https://shop.test/p/cartoon-poster'));
  assert.ok(is('checkout', 'https://shop.test/checkouts/c/abc/information'));
  assert.ok(is('checkout', 'https://shop.test/us/en/order/payment/complete/'));
  assert.ok(!is('checkout', 'https://shop.test/p/order-of-the-phoenix'));
  assert.ok(is('add_to_cart', 'https://shop.test/api/cart/add.js'));
  assert.ok(!is('add_to_cart', 'https://shop.test/api/cart/coupon'));
});

test('leaderboard counts sites by majority and marks flaky sites', () => {
  const run = (attempt: number, outcome: string, stage: RunRecord['furthest_stage']): RunRecord =>
    ({ agent: 'a', track: 'observed', browser: 'local', task_id: 'shop.test', site: 'shop.test', category: null, attempt, stop_at: 'shipping', duration_ms: 60_000, furthest_stage: stage, outcome, pass: outcome === 'pass', guard_breach: false, false_completion: false, steps: 10, cost_usd: null, run_dir: `runs/${attempt}` }) as RunRecord;
  const board = aggregate([run(1, 'pass', 'shipping'), run(2, 'pass', 'shipping'), run(3, 'bot_detected:akamai', 'cart')]);
  const [agent] = board.agents;
  assert.equal(agent.sites_passed, 1);
  assert.equal(agent.flaky_sites, 1);
  assert.equal(agent.funnel.shipping.runs, 2);
  assert.equal(agent.funnel.cart.runs, 3);
  assert.deepEqual(agent.bot_walls, { akamai: 1 });
  assert.equal(board.sites[0].cells.a.stage, 'shipping');
});
