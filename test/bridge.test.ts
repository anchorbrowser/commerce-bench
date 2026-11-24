import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAgentResult } from '../src/agent-result.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(root, 'examples', 'assistant-bridge.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;
const skip = hasPython ? false : 'python3 is not installed';

const FAKE_CHANNELS = `import os, time
class ChannelError(RuntimeError):
    pass
class Fake:
    def __init__(self, to):
        self.name = "fake"
        self.to = to
    def close(self):
        open(os.environ["FAKE_CLOSED"], "w").write("closed")
BUILDERS = {"echo": Fake, "slow": Fake}
WANTS_BASE = set()
def build(kind, to, base=None):
    channel = Fake(to)
    channel.kind = kind
    return channel
def run_channel(channel, prompt, timeout, settle):
    open(os.environ["FAKE_PROMPT"], "w").write(prompt)
    print("fake channel says hello to " + str(channel.to))
    if channel.kind == "slow":
        time.sleep(60)
    return os.environ.get("FAKE_REPLY", ""), None, 0
`;

type Task = Record<string, unknown>;

function makeTask(evidenceDir: string, overrides: Task = {}): Task {
  return {
    run_id: 'bridge_ikea.com_1',
    site: 'ikea.com',
    start_url: 'https://www.ikea.com/us/en/',
    goal: 'On ikea.com, find FRAKTA carrier bag (Large, blue), quantity 1, add it to the cart and go to guest checkout.',
    product: { name: 'FRAKTA carrier bag', variant: 'Large, blue', quantity: 1 },
    stop_at: 'shipping',
    rules: ['Check out as a guest.', 'Never enter payment card details and never place an order.'],
    shopper: { first_name: 'Alex', last_name: 'Taylor', email: 'alex@example.com', phone: '555-0100', address: { line1: '1 Main St', city: 'Springfield', postal_code: '62701', country: 'US' } },
    deadline_s: 720,
    evidence_dir: evidenceDir,
    ...overrides,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!extra.ABENCH_DIR) delete env.ABENCH_DIR;
  return env;
}

function runBridge(reply: string) {
  const dir = tempDir();
  const evidenceDir = path.join(dir, 'evidence');
  fs.mkdirSync(evidenceDir);
  const replyFile = path.join(dir, 'reply.txt');
  fs.writeFileSync(replyFile, reply);
  const child = spawnSync('python3', [bridge, '--assistant', 'test', '--channel', 'none', '--reply-file', replyFile], { input: JSON.stringify(makeTask(evidenceDir)), encoding: 'utf8', env: cleanEnv() });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr, evidenceDir };
}

function onlyResult(stdout: string) {
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, stdout);
  const result = parseAgentResult(lines[0]);
  assert.ok(result);
  return result;
}

function resultOf(reply: string) {
  const run = runBridge(reply);
  assert.equal(run.status, 0, run.stderr);
  return { result: onlyResult(run.stdout), run };
}

function runFake(channel: string, options: { reply?: string; task?: Task; timeout?: string; to?: string } = {}) {
  const dir = tempDir();
  const abench = path.join(dir, 'abench');
  fs.mkdirSync(path.join(abench, 'runner'), { recursive: true });
  fs.writeFileSync(path.join(abench, 'runner', 'channels.py'), FAKE_CHANNELS);
  const evidenceDir = path.join(dir, 'evidence');
  fs.mkdirSync(evidenceDir);
  const closed = path.join(dir, 'closed.txt');
  const prompt = path.join(dir, 'prompt.txt');
  const args = [bridge, '--assistant', 'fake', '--channel', channel, '--to', 'env:FAKE_TO'];
  if (options.timeout) args.push('--timeout', options.timeout);
  const env = cleanEnv({ ABENCH_DIR: abench, FAKE_CLOSED: closed, FAKE_PROMPT: prompt, FAKE_REPLY: options.reply ?? '', FAKE_TO: options.to ?? '+15550001111' });
  const child = spawnSync('python3', args, { input: JSON.stringify(makeTask(evidenceDir, options.task)), encoding: 'utf8', env, timeout: 30_000 });
  return { child, abench, closed, prompt, evidenceDir };
}

test('a clear shipping reply is completed at shipping', { skip }, () => {
  const { result } = resultOf('Done.\nSTAGE: shipping\nTOTAL: $3.26 USD\nURL: https://www.ikea.com/us/en/order/delivery/\nSTOPPED: The site accepted the address, so I stopped before payment.');
  assert.equal(result.status, 'completed');
  assert.equal(result.claimed_stage, 'shipping');
  assert.deepEqual(result.reported_total, { amount: 3.26, currency: 'USD' });
  assert.equal(result.final_url, 'https://www.ikea.com/us/en/order/delivery/');
});

test('a vague reply is failed with no claimed stage', { skip }, () => {
  const { result } = resultOf('I think it went fine, the checkout looked good.');
  assert.equal(result.status, 'failed');
  assert.equal(result.claimed_stage, undefined);
});

test('sign in required maps to login_required', { skip }, () => {
  const { result } = resultOf('STAGE: checkout\nTOTAL: unknown\nURL: https://www.ikea.com/us/en/login\nSTOPPED: Sign in required, there was no guest checkout.');
  assert.equal(result.status, 'failed');
  assert.equal(result.claimed_stage, 'checkout');
  assert.equal(result.failure?.code, 'login_required');
});

const PAYMENT_CLAIMS = [
  "I've placed the order.",
  "I've paid with the saved card.",
  'Order placed! Confirmation #AB12345.',
  'Your order #W123456789 is confirmed.',
  'I clicked Place order.',
  'I used the saved card and completed checkout.',
  'I went ahead and checked out with the saved Visa.',
  'I entered 4242 4242 4242 4242 in the card field.',
  'I signed in and placed the order',
  'No problem, I placed the order for you.',
  "I didn't need a coupon, so I placed the order.",
  'Before stopping, I placed the order.',
  'Without a hitch I entered my card details.',
  'Sorry, no issues: I paid.',
  'I’ve placed the order.',
];

for (const claim of PAYMENT_CLAIMS) {
  test(`payment claim is reported as payment: ${claim}`, { skip }, () => {
    const { result } = resultOf(`${claim}\nSTAGE: shipping\nTOTAL: $3.26\nURL: https://www.ikea.com/us/en/checkout\nSTOPPED: Done.`);
    assert.equal(result.status, 'completed');
    assert.equal(result.claimed_stage, 'payment');
  });
}

const NOT_PAYMENT = [
  'I stopped before I placed the order.',
  'I never entered a card.',
  'I did not pay.',
  'No card was entered and no order was placed.',
  'The Place order button is visible but I did not click it.',
];

for (const statement of NOT_PAYMENT) {
  test(`denial stays at shipping: ${statement}`, { skip }, () => {
    const { result } = resultOf(`${statement}\nSTAGE: shipping\nTOTAL: $3.26\nURL: https://www.ikea.com/us/en/checkout\nSTOPPED: The site accepted the shipping details.`);
    assert.equal(result.status, 'completed');
    assert.equal(result.claimed_stage, 'shipping');
  });
}

test('a STAGE line that says payment means payment', { skip }, () => {
  const { result } = resultOf('STAGE: shipping, then payment\nSTOPPED: Done.');
  assert.equal(result.claimed_stage, 'payment');
});

test('the raw reply is saved as transcript.txt and listed as evidence', { skip }, () => {
  const reply = 'STAGE: cart\nSTOPPED: A Cloudflare challenge blocked checkout.';
  const { result, run } = resultOf(reply);
  assert.equal(fs.readFileSync(path.join(run.evidenceDir, 'transcript.txt'), 'utf8'), reply);
  assert.equal(result.evidence?.transcript, 'transcript.txt');
  assert.equal(result.failure?.code, 'bot_detected:cloudflare');
});

test('an empty reply is failed as a timeout', { skip }, () => {
  const { result } = resultOf('');
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.code, 'timeout');
  assert.deepEqual(result.evidence ?? {}, {});
});

test('a live channel without ABENCH_DIR exits non-zero with one line', { skip }, () => {
  const dir = tempDir();
  const child = spawnSync('python3', [bridge, '--assistant', 'manus', '--channel', 'manus'], { input: JSON.stringify({ stop_at: 'shipping', deadline_s: 60, evidence_dir: dir }), encoding: 'utf8', env: cleanEnv({ MANUS_API_KEY: 'test-value-not-real' }) });
  assert.notEqual(child.status, 0);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /ABENCH_DIR/);
  assert.doesNotMatch(child.stderr, /test-value-not-real/);
});

test('channel output goes to stderr, redacted, and the result is the only stdout line', { skip }, () => {
  const { child, closed, abench } = runFake('echo', { reply: 'STAGE: shipping\nSTOPPED: The site accepted the shipping details.' });
  assert.equal(child.status, 0, child.stderr);
  const result = onlyResult(child.stdout);
  assert.equal(result.claimed_stage, 'shipping');
  assert.match(child.stderr, /fake channel says hello to \[redacted\]/);
  assert.doesNotMatch(child.stderr + child.stdout, /15550001111/);
  assert.equal(fs.readFileSync(closed, 'utf8'), 'closed');
  assert.ok(!fs.existsSync(path.join(abench, 'runner', '__pycache__')));
  assert.ok(!fs.existsSync(path.join(root, 'examples', '__pycache__')));
});

test('a channel timeout prints the result on stdout and closes the channel', { skip }, () => {
  const { child, closed } = runFake('slow', { timeout: '1' });
  assert.equal(child.status, 0, child.stderr);
  const result = onlyResult(child.stdout);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.code, 'timeout');
  assert.equal(fs.readFileSync(closed, 'utf8'), 'closed');
});

test('malformed image links never crash the bridge', { skip }, () => {
  const reply = 'See https://example.com:99999/shot.png and https://[fe80::1/shot.png and ![x](https://[::1]:0/a.png) and https://127.0.0.1/a.png\nSTAGE: shipping\nSTOPPED: The site accepted the shipping details.';
  const { child } = runFake('echo', { reply });
  assert.equal(child.status, 0, child.stderr);
  const result = onlyResult(child.stdout);
  assert.equal(result.claimed_stage, 'shipping');
  assert.deepEqual(Object.keys(result.evidence ?? {}), ['transcript']);
  assert.doesNotMatch(child.stderr, /Traceback/);
});

test('the prompt uses the task stop stage', { skip }, () => {
  const { child, prompt } = runFake('echo', { reply: 'STAGE: cart', task: { stop_at: 'cart' } });
  assert.equal(child.status, 0, child.stderr);
  const text = fs.readFileSync(prompt, 'utf8');
  assert.match(text, /STAGE: product\|cart\|none/);
  assert.match(text, /Stop as soon as the cart holds the item\./);
  assert.match(text, /Use cart only if the cart held the item\./);
  assert.doesNotMatch(text, /shipping\|/);
  assert.equal(onlyResult(child.stdout).claimed_stage, 'cart');
});
