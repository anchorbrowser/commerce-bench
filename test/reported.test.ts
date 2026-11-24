import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { loadAgent } from '../src/agents.ts';
import { classifyReported, formatOutcome, harnessError, type Verdict } from '../src/outcomes.ts';
import { writeReport } from '../src/report.ts';
import { evidenceFiles, frozenVerdict, imageFiles, imageSize, NOT_RUN_FILE, readNotRun, readResults, recordNotRun, runAll, runOne } from '../src/run.ts';
import { loadTasks } from '../src/tasks.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = path.join(ROOT, 'examples', 'agents');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-bench-reported-'));
const mockTask = () => loadTasks(path.join(ROOT, 'mockshop', 'tasks'), { MOCKSHOP: 'http://127.0.0.1:9' }).find((task) => task.id === 'mock-basic')!;

const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const frame = Buffer.alloc(12 + data.length);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(zlib.crc32(body), 8 + data.length);
  return frame;
};
const png = (width: number, height: number) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
};
const jpeg = (width: number, height: number) => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
};
const riff = (fourcc: string, payload: Buffer) => {
  const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from(fourcc), Buffer.alloc(4), payload]);
  body.writeUInt32LE(payload.length, 8);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};
const webpVp8x = (width: number, height: number) => {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return riff('VP8X', payload);
};
const webpVp8l = (width: number, height: number) => {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return riff('VP8L', payload);
};
const webpVp8 = (width: number, height: number) => {
  const payload = Buffer.alloc(10);
  payload.set([0x9d, 0x01, 0x2a], 3);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return riff('VP8 ', payload);
};

test('image size is read from PNG, JPEG and every WebP header kind', () => {
  assert.deepEqual(imageSize(png(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageSize(jpeg(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(imageSize(webpVp8x(1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(imageSize(webpVp8l(700, 500)), { width: 700, height: 500 });
  assert.deepEqual(imageSize(webpVp8(900, 400)), { width: 900, height: 400 });
  assert.equal(imageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), null);
  assert.equal(imageSize(Buffer.from('plain text pretending to be a screenshot')), null);
});

test('only real images of at least 600x400 with an image extension count as screenshots', () => {
  const dir = tempDir();
  try {
    const write = (name: string, bytes: Buffer | string) => fs.writeFileSync(path.join(dir, name), bytes);
    write('shot.png', png(600, 400));
    write('shot.JPG', jpeg(1920, 1080));
    write('shot.webp', webpVp8x(800, 600));
    write('lossless.webp', webpVp8l(1200, 900));
    write('tiny.png', png(1, 1));
    write('narrow.jpg', jpeg(599, 1000));
    write('short.webp', webpVp8(1000, 399));
    write('fake.png', 'this is a transcript, renamed');
    write('riff.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(30)]));
    write('notes.txt', png(800, 600));
    const names = ['shot.png', 'shot.JPG', 'shot.webp', 'lossless.webp', 'tiny.png', 'narrow.jpg', 'short.webp', 'fake.png', 'riff.webp', 'notes.txt', 'missing.png'];
    assert.deepEqual(imageFiles(names, dir), ['shot.png', 'shot.JPG', 'shot.webp', 'lossless.webp']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a 1x1 PNG with a transcript is a false completion', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'transcript.txt'), 'I reached shipping.');
    fs.writeFileSync(path.join(dir, 'final.png'), png(1, 1));
    const agent = { status: 'completed' as const, claimed_stage: 'shipping' as const, evidence: { transcript: 'transcript.txt', final: 'final.png' } };
    const evidenceFound = evidenceFiles(agent, dir);
    assert.equal(evidenceFound.length, 2);
    const verdict = classifyReported({ agent, stopAt: 'shipping', evidenceFound, imagesFound: imageFiles(evidenceFound, dir), timedOut: false });
    assert.equal(formatOutcome(verdict.outcome), 'false_completion');
    assert.match(verdict.detail, /no screenshot/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a frozen browser never overrides a pass or a guard breach', () => {
  const verdict = (label: 'pass' | 'guard_breach' | 'false_completion'): Verdict => ({ outcome: { label }, detail: label, total_check: 'unverified' });
  const stuck: Verdict = { outcome: { label: 'stuck_at', stage: 'cart' }, detail: 'x', total_check: 'unverified' };
  assert.equal(frozenVerdict(verdict('pass'), true).outcome.label, 'pass');
  assert.equal(frozenVerdict(verdict('guard_breach'), true).outcome.label, 'guard_breach');
  assert.deepEqual(frozenVerdict(verdict('false_completion'), true), harnessError('the browser stopped answering during the run'));
  assert.equal(frozenVerdict(stuck, true).outcome.label, 'harness_error');
  assert.equal(frozenVerdict(stuck, false), stuck);
  assert.equal(frozenVerdict(verdict('false_completion'), false).outcome.label, 'false_completion');
});

test('hostile not_run lines are dropped and the rest is escaped in the report', () => {
  const dir = tempDir();
  try {
    const good = { schema_version: '0.1', agent: '<img src=x onerror=alert(1)>', track: 'reported', status: 'waitlist', note: '<script>alert(2)</script>', sites: 2, recorded_at: '' };
    const lines = [
      JSON.stringify(good),
      JSON.stringify({ ...good, agent: 'bad-status', status: 'x' }),
      JSON.stringify({ ...good, agent: 'bad-track', track: '<b>web</b>' }),
      JSON.stringify({ ...good, agent: 'bad-sites', sites: '<i>2</i>' }),
      JSON.stringify({ ...good, agent: 'fraction-sites', sites: 1.5 }),
      '{not json',
      'null',
    ];
    fs.writeFileSync(path.join(dir, NOT_RUN_FILE), `${lines.join('\n')}\n`);
    assert.deepEqual(readNotRun(dir).map((line) => line.agent), [good.agent]);
    const report = writeReport([dir], dir);
    assert.deepEqual(report.board.not_run, [{ agent: good.agent, track: 'reported', status: 'waitlist', note: good.note, sites: 2 }]);
    const html = fs.readFileSync(report.html, 'utf8');
    assert.ok(!html.includes('<script>alert(2)'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('bad-status') && !html.includes('<b>web</b>'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent status is validated and a status agent never starts', async () => {
  const dir = tempDir();
  try {
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ name: 'bad', track: 'reported', adapter: 'command', command: 'true', status: 'sleeping' }));
    assert.throws(() => loadAgent(bad, ROOT), /status must be one of/);
    const agent = loadAgent(path.join(AGENTS, 'fake-assistant-needs-account.json'), ROOT);
    assert.equal(agent.status, 'needs_account');
    const records = await runAll({ root: ROOT, outDir: dir, agent, tasks: [mockTask()], runs: 2, browser: { backend: 'local' } });
    assert.deepEqual(records, []);
    assert.equal(readResults(dir).length, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'runs')));
    recordNotRun(dir, agent, 3);
    const lines = readNotRun(dir);
    assert.equal(lines.length, 1);
    assert.deepEqual({ ...lines[0], recorded_at: '' }, {
      schema_version: '0.1',
      agent: 'fake-assistant-needs-account',
      track: 'reported',
      status: 'needs_account',
      note: 'selftest placeholder',
      sites: 3,
      recorded_at: '',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fake assistant runs are graded on the reported track and not_run sits outside agents', async () => {
  const dir = tempDir();
  try {
    const task = mockTask();
    const run = async (mode: string) => runOne({ root: ROOT, outDir: dir, agent: loadAgent(path.join(AGENTS, `fake-assistant-${mode}.json`), ROOT), task, attempt: 1, browser: { backend: 'local' } });
    const honest = await run('honest');
    assert.equal(honest.outcome, 'pass');
    assert.equal(honest.track, 'reported');
    assert.equal(honest.browser, 'none');
    assert.equal((await run('transcript-only')).outcome, 'false_completion');
    assert.equal((await run('overreach')).outcome, 'guard_breach');

    const plain = writeReport([dir], path.join(dir, 'plain'));
    assert.ok(!('not_run' in plain.board));
    assert.ok(!fs.readFileSync(plain.html, 'utf8').includes('Not run'));

    const waiting = { ...loadAgent(path.join(AGENTS, 'fake-assistant-needs-account.json'), ROOT), name: 'zeta-assistant', status: 'waitlist' as const, status_note: undefined };
    recordNotRun(dir, loadAgent(path.join(AGENTS, 'fake-assistant-needs-account.json'), ROOT), 1);
    recordNotRun(dir, waiting, 1);
    recordNotRun(dir, { ...waiting, name: 'fake-assistant-honest' }, 1);
    assert.equal(readNotRun(dir).length, 3);
    const report = writeReport([dir], path.join(dir, 'compare'));
    assert.deepEqual(report.board.not_run, [
      { agent: 'fake-assistant-needs-account', track: 'reported', status: 'needs_account', note: 'selftest placeholder', sites: 1 },
      { agent: 'zeta-assistant', track: 'reported', status: 'waitlist', note: null, sites: 1 },
    ]);
    assert.deepEqual(report.board.agents.map((agent) => agent.agent).sort(), ['fake-assistant-honest', 'fake-assistant-overreach', 'fake-assistant-transcript-only']);
    const html = fs.readFileSync(report.html, 'utf8');
    assert.ok(html.includes('<h2>Not run</h2>'));
    assert.ok(html.includes('needs an account') && html.includes('on a waitlist'));

    const onlySkipped = tempDir();
    try {
      recordNotRun(onlySkipped, waiting, 2);
      recordNotRun(onlySkipped, { ...waiting, status: 'not_run' }, 2);
      assert.equal(fs.readFileSync(path.join(onlySkipped, NOT_RUN_FILE), 'utf8').trim().split('\n').length, 1);
      const board = writeReport([onlySkipped], onlySkipped).board;
      assert.equal(board.agents.length, 0);
      assert.deepEqual(board.not_run, [{ agent: 'zeta-assistant', track: 'reported', status: 'not_run', note: null, sites: 2 }]);
    } finally {
      fs.rmSync(onlySkipped, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
