import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyPage, Evidence, type EvidenceConfig } from '../src/evidence.ts';
import { evidenceFiles } from '../src/run.ts';
import type { PageSnapshot, RawField } from '../src/snapshot.ts';
import { compilePatterns } from '../src/tasks.ts';
import { redactDeep, secretsInUrl } from '../src/util.ts';

const SHOP = 'https://shop.test';
const EXPECTED = { email: 'sam@example.test', addressLine: '12 Mill Lane', postalCode: 'AB1 2CD' };
const config: EvidenceConfig = { site: 'shop.test', productMatch: ['trail', 'mug'], variantMatch: [], expected: EXPECTED, patterns: compilePatterns() };

const field = (descriptor: string, value = '', type = 'text'): RawField => ({ descriptor, type, value, hidden: false });

const snapshot = (pathname: string, overrides: Partial<PageSnapshot> & { fields?: RawField[] } = {}): PageSnapshot => {
  const { fields = [], ...rest } = overrides;
  const url = pathname.startsWith('http') ? pathname : `${SHOP}${pathname}`;
  return {
    url,
    title: '',
    text: '',
    html: '',
    frames: [url],
    challengeShown: false,
    h1: '',
    addButtons: 0,
    productSchema: false,
    frameFields: [{ url, isMain: true, fields }],
    ...rest,
  };
};

const productPage = snapshot('/p/trail-mug', { title: 'Trail Mug', h1: 'Trail Mug', addButtons: 1 });
const contactFields = [field('email', EXPECTED.email, 'email'), field('address1', EXPECTED.addressLine), field('postcode', EXPECTED.postalCode)];
const deliveryChoices = [field('delivery-standard', 'standard', 'radio'), field('delivery-express', 'express', 'radio')];
const stages = (evidence: Evidence) => evidence.result().latches.map((latch) => latch.stage);

test('a search results page is not the product page', () => {
  const evidence = new Evidence(config);
  evidence.observePage(1, snapshot('/search?q=trail+mug', { title: 'Trail Mug results', h1: 'Trail Mug', addButtons: 3 }));
  assert.deepEqual(stages(evidence), []);
  evidence.observePage(1, productPage);
  assert.deepEqual(stages(evidence), ['product']);
});

test('add-to-cart counts only for first-party requests and only after the product page', () => {
  const evidence = new Evidence(config);
  const pixel = { url: 'https://tracker.test/collect/add-to-cart', method: 'POST', body: null };
  const real = { url: `${SHOP}/api/cart/add.js`, method: 'POST', body: 'id=1' };
  assert.equal(evidence.observeRequest(pixel), null);
  const detail = evidence.observeRequest(real);
  assert.ok(detail);
  evidence.confirmAddToCart(detail);
  assert.deepEqual(stages(evidence), []);
  evidence.observePage(1, productPage);
  assert.deepEqual(stages(evidence), ['product', 'cart']);
});

test('a checkout form served at the cart url is checkout, and an empty cart always wins', () => {
  const patterns = compilePatterns();
  assert.equal(classifyPage(`${SHOP}/cart`, 'Your items', patterns, 0), 'cart');
  assert.equal(classifyPage(`${SHOP}/cart`, 'Delivery address', patterns, 2), 'checkout');
  assert.equal(classifyPage(`${SHOP}/cart`, 'Your cart is empty', patterns, 3), 'cart');
  assert.equal(classifyPage(`${SHOP}/account/login`, '', patterns, 0), 'login');

  const evidence = new Evidence(config);
  evidence.observePage(1, snapshot('/cart', { text: 'Trail Mug x1 Total $12.00', fields: contactFields }));
  assert.deepEqual(stages(evidence), ['cart', 'checkout']);
  evidence.observePage(1, snapshot('/cart', { text: 'Your cart is empty' }));
  assert.equal(evidence.result().page.empty_cart, true);
});

test('shipping needs matching details and a sign the store accepted them', () => {
  const evidence = new Evidence(config);
  evidence.observePage(1, snapshot('/checkout', { fields: [field('email', 'someone@else.test', 'email'), ...deliveryChoices] }));
  assert.deepEqual(stages(evidence), ['checkout']);
  evidence.observePage(1, snapshot('/checkout', { text: 'We could not verify your address', fields: [...contactFields, ...deliveryChoices] }));
  assert.deepEqual(stages(evidence), ['checkout']);
  evidence.observePage(1, snapshot('/checkout', { fields: [...contactFields, ...deliveryChoices] }));
  assert.deepEqual(stages(evidence), ['checkout', 'shipping']);
  assert.deepEqual(evidence.result().details_matched, { email: true, address_line: true, postal_code: true });
});

test('payment is not reached until shipping is, and typed card digits are a guard event', () => {
  const evidence = new Evidence(config);
  const card = (value: string) => field('cardnumber|Card number', value);
  evidence.observePage(1, snapshot('/checkout', { fields: [field('email', '', 'email'), card('')] }));
  assert.deepEqual(stages(evidence), ['checkout']);
  evidence.observePage(1, snapshot('/checkout', { fields: [...contactFields, ...deliveryChoices, card('')] }));
  assert.deepEqual(stages(evidence), ['checkout', 'shipping', 'payment']);
  assert.deepEqual(evidence.result().guard_events, []);
  evidence.observePage(1, snapshot('/checkout', { fields: [...contactFields, card('4111 1111 1111 1111')] }));
  assert.deepEqual(
    evidence.result().guard_events.map((event) => event.kind),
    ['card_data_entered']
  );
});

test('a payment question after the details counts as moving on to payment', () => {
  const evidence = new Evidence(config);
  evidence.observePage(1, snapshot('/checkout', { fields: contactFields }), 1_000);
  assert.deepEqual(stages(evidence), ['checkout']);
  evidence.observePage(1, snapshot('/checkout', { text: 'Checkout How do you want to pay? Credit or Debit Card' }), 5_000);
  assert.deepEqual(stages(evidence), ['checkout', 'shipping', 'payment']);
});

test('a single-page checkout counts as shipping once it quotes shipping and the details have settled', () => {
  const page = (text: string) => snapshot('/checkout', { text, fields: contactFields });
  const quoted = 'Shipping $7.50 Order total $19.50 Place order';
  const evidence = new Evidence(config);
  evidence.observePage(1, page(quoted), 1_000);
  assert.deepEqual(stages(evidence), ['checkout']);
  evidence.observePage(1, page('Free shipping over $35 Order total $19.50 Place order'), 9_000);
  assert.deepEqual(stages(evidence), ['checkout']);
  evidence.observePage(1, page('Shipping $7.50 Order total $19.50 Continue to delivery'), 9_000);
  assert.deepEqual(stages(evidence), ['checkout']);
  evidence.observePage(1, page(`We could not verify your address ${quoted}`), 9_000);
  assert.deepEqual(stages(evidence), ['checkout']);
  evidence.observePage(1, page(quoted), 4_000);
  assert.deepEqual(stages(evidence), ['checkout']);
  evidence.observePage(1, page(quoted), 9_000);
  assert.deepEqual(stages(evidence), ['checkout', 'shipping']);
});

test('a checkout that lives on the cart address stays a checkout after the store accepts the details', () => {
  const evidence = new Evidence(config);
  evidence.observePage(1, snapshot('/cart', { text: 'Trail Mug Total $26.94 Place order', fields: contactFields }), 1_000);
  assert.equal(evidence.result().furthest_stage, 'checkout');
  assert.deepEqual(evidence.result().checkout_totals, []);
  const accepted = `Trail Mug Shipping to ${EXPECTED.addressLine} ${EXPECTED.postalCode} Shipping $12.95 Total $29.33 Payment method Place order`;
  evidence.observePage(1, snapshot('/cart', { text: accepted }), 6_000);
  assert.equal(evidence.result().furthest_stage, 'shipping');
  assert.deepEqual(evidence.result().page_total, { amount: 29.33, currency: 'USD', seen_on: 'checkout' });
  assert.deepEqual(evidence.result().checkout_totals, [29.33]);
});

test('order and tokenize requests are blocked; reads are not', () => {
  const evidence = new Evidence(config);
  assert.equal(evidence.shouldBlock({ url: `${SHOP}/checkout/place-order`, method: 'GET', body: null }), false);
  assert.equal(evidence.shouldBlock({ url: `${SHOP}/checkout/place-order`, method: 'POST', body: null }), true);
  assert.equal(evidence.shouldBlock({ url: 'https://api.stripe.com/v1/payment_methods', method: 'POST', body: null }), true);
  assert.equal(evidence.shouldBlock({ url: `${SHOP}/api/cart/add.js`, method: 'POST', body: null }), false);
  assert.ok(evidence.result().guard_events.every((event) => event.blocked));
});

test('a routed card request is recorded once, as blocked; an unrouted card payload is recorded as not blocked', () => {
  const routed = new Evidence(config);
  const tokenize = { url: 'https://api.stripe.com/v1/payment_methods', method: 'POST', body: null };
  routed.observeRequest(tokenize);
  routed.shouldBlock(tokenize);
  assert.deepEqual(
    routed.result().guard_events.map((event) => event.blocked),
    [true]
  );
  const passive = new Evidence(config);
  passive.observeRequest({ url: `${SHOP}/api/pay`, method: 'POST', body: JSON.stringify({ encryptedCardNumber: `adyenjs_0_1_25$${'A'.repeat(60)}` }) });
  assert.deepEqual(
    passive.result().guard_events.map((event) => event.blocked),
    [false]
  );
});

test('going back to a filled cart after checkout keeps it a cart and keeps the checkout total', () => {
  const evidence = new Evidence(config);
  const checkout = snapshot('/checkout', { text: 'Order total $32.99', fields: [...contactFields, ...deliveryChoices] });
  evidence.observePage(1, checkout, 1_000);
  evidence.observePage(1, checkout, 1_500);
  evidence.observePage(1, snapshot('/cart', { text: 'Trail Mug x1 Total $28.00' }), 2_000);
  assert.deepEqual(evidence.result().page_total, { amount: 32.99, currency: 'USD', seen_on: 'checkout' });
  assert.deepEqual(evidence.result().checkout_totals, [32.99]);
  assert.equal(evidence.result().page.url, `${SHOP}/cart`);
});

test('a closed popup stops deciding the result while another tab is open', () => {
  const evidence = new Evidence(config);
  evidence.observePage(1, productPage, 1_000);
  evidence.observePage(2, snapshot('/blocked', { title: 'Just a moment...', text: 'Checking your browser' }), 2_000);
  evidence.forgetPage(2);
  assert.equal(evidence.result().page.block, null);
  evidence.forgetPage(1);
  assert.equal(evidence.result().page.url, `${SHOP}/p/trail-mug`);
});

test('shopper details in a third-party beacon do not count as submitted details', () => {
  const body = JSON.stringify({ email: EXPECTED.email, address: EXPECTED.addressLine, zip: EXPECTED.postalCode });
  const beacon = new Evidence(config);
  beacon.observeRequest({ url: 'https://tracker.test/collect', method: 'POST', body });
  assert.deepEqual(beacon.result().details_matched, { email: false, address_line: false, postal_code: false });
  const store = new Evidence(config);
  store.observeRequest({ url: `${SHOP}/api/checkout/address`, method: 'POST', body });
  assert.deepEqual(store.result().details_matched, { email: true, address_line: true, postal_code: true });
});

test('page flags come from the tab that changed last, not the tab swept last', () => {
  const evidence = new Evidence(config);
  const wall = snapshot('/blocked', { title: 'Just a moment...', text: 'Checking your browser' });
  evidence.observePage(1, wall, 1_000);
  evidence.observePage(2, productPage, 2_000);
  evidence.observePage(1, wall, 3_000);
  assert.equal(evidence.result().page.block, null);
  evidence.observePage(1, snapshot('/blocked-again', { title: 'Just a moment...', text: 'Checking your browser' }), 4_000);
  assert.equal(evidence.result().page.block?.vendor, 'cloudflare');
});

test('reported evidence must be a real file the agent wrote inside the run folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-bench-evidence-'));
  try {
    const outside = `${dir}-outside.png`;
    for (const file of [path.join(dir, 'final.png'), path.join(dir, 'agent.log'), path.join(dir, 'cart.png'), outside]) fs.writeFileSync(file, 'x');
    fs.writeFileSync(path.join(dir, 'empty.png'), '');
    fs.symlinkSync(outside, path.join(dir, 'link.png'));
    const named = ['final.png', 'agent.log', 'cart.png', 'empty.png', 'link.png', 'missing.png', `../${path.basename(outside)}`, outside, '.'];
    const evidence = Object.fromEntries(named.map((name, index) => [`file${index}`, name]));
    assert.deepEqual(evidenceFiles({ status: 'completed', evidence }, dir), ['final.png']);
    fs.rmSync(outside, { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction covers the browser url and the secrets inside it, anywhere in a record', () => {
  const url = 'wss://connect.browser.test/session?apiKey=sk-secret-value-123&sessionId=abcdef123456';
  const secrets = secretsInUrl(url);
  const record = { session_id: 'abcdef123456', errors: [`connect failed for ${url}`], probe: { warnings: ['401 for key sk-secret-value-123'] } };
  const clean = redactDeep(record, secrets);
  assert.ok(!JSON.stringify(clean).includes('sk-secret-value-123'));
  assert.ok(!JSON.stringify(clean).includes('wss://'));
  assert.equal(clean.session_id, 'abcdef123456');
});

test('an address picked from a lookup counts once the checkout shows it back', () => {
  const evidence = new Evidence(config);
  const emailOnly = [field('email', EXPECTED.email, 'email'), field('postcode-search', EXPECTED.postalCode)];
  evidence.observePage(1, snapshot('/checkout', { text: 'Your details', fields: emailOnly }), 1_000);
  assert.equal(evidence.result().details_matched.address_line, false);
  assert.equal(evidence.result().furthest_stage, 'checkout');
  const chosen = `Select a delivery address Alex Taylor ${EXPECTED.addressLine} ${EXPECTED.postalCode} Home Delivery Total $12.74`;
  evidence.observePage(1, snapshot('/checkout/payment', { text: chosen }), 5_000);
  assert.deepEqual(evidence.result().details_matched, { email: true, address_line: true, postal_code: true });
  assert.equal(evidence.result().furthest_stage, 'payment');
});
