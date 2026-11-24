import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

type Task = { site: string; stop_at: string; evidence_dir: string };

const MODES = ['honest', 'transcript-only', 'overreach'] as const;
type Mode = (typeof MODES)[number];

const modeFlag = process.argv.indexOf('--mode');
const mode = (modeFlag === -1 ? 'honest' : process.argv[modeFlag + 1]) as Mode;
if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}`);

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

const WIDTH = 800;
const HEIGHT = 600;

function screenshotPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + WIDTH * 3);
  for (let x = 0; x < WIDTH; x++) row.set([47, 125, 79], 1 + x * 3);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: HEIGHT }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', pixels),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const task = JSON.parse(await readStdin()) as Task;
const save = (name: string, content: string | Buffer) => {
  fs.writeFileSync(path.join(task.evidence_dir, name), content);
  return name;
};

const transcript = save('transcript.txt', `Scripted fake assistant, mode ${mode}. No site was opened. Task: ${task.site}, stop at ${task.stop_at}.\n`);
const evidence: Record<string, string> = { transcript };
if (mode !== 'transcript-only') evidence.final = save('final.png', screenshotPng());

console.log(
  JSON.stringify({
    status: 'completed',
    claimed_stage: mode === 'overreach' ? 'payment' : task.stop_at,
    evidence,
    steps: 0,
    cost_usd: 0,
  })
);
