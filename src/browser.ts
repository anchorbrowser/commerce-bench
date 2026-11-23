import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { readJson, sleep } from './util.ts';

export type BrowserBackend = 'local' | 'cdp' | 'anchor';

export type BrowserHandle = {
  backend: BrowserBackend;
  cdpUrl: string;
  close: () => Promise<void>;
  sessionId?: string;
  saveRecording?: (file: string) => Promise<boolean>;
};

export type BrowserOptions = {
  backend: BrowserBackend;
  headed?: boolean;
  cdpUrl?: string;
  domain?: string;
  anchorConfig?: string;
  anchorDomain?: boolean;
  recordings?: boolean;
};

const ANCHOR_API = 'https://api.anchorbrowser.io';

async function launchLocal(headed: boolean): Promise<BrowserHandle> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-bench-'));
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--window-size=1366,900',
    ...(headed ? [] : ['--headless=new']),
    'about:blank',
  ];
  const child: ChildProcess = spawn(chromium.executablePath(), args, { stdio: 'ignore' });
  const close = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  const portFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (fs.existsSync(portFile)) {
      const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && wsPath) return { backend: 'local', cdpUrl: `ws://127.0.0.1:${port}${wsPath}`, close };
    }
    await sleep(100);
  }
  await close();
  throw new Error('Local Chromium did not open a debugging port. Run "npx playwright install chromium" and retry.');
}

async function launchAnchor({ domain, anchorConfig, anchorDomain = true }: BrowserOptions): Promise<BrowserHandle> {
  const apiKey = process.env.ANCHORBROWSER_API_KEY;
  if (!apiKey) throw new Error('The anchor backend needs ANCHORBROWSER_API_KEY in the environment.');
  const config = anchorConfig ? readJson<{ session?: Record<string, unknown> }>(anchorConfig) : {};
  const useDomain = domain && anchorDomain && !/^[\d.]+$/.test(domain);
  const withDomain = useDomain ? { ...config, session: { ...config.session, domain } } : config;
  const headers = { 'anchor-api-key': apiKey, 'content-type': 'application/json' };
  const create = (body: unknown) => fetch(`${ANCHOR_API}/v1/sessions`, { method: 'POST', headers, body: JSON.stringify(body) });
  let response = await create(withDomain);
  if (response.status === 400 && useDomain) response = await create(config);
  if (!response.ok) throw new Error(`Anchor session creation failed with HTTP ${response.status}`);
  const payload = (await response.json()) as { data?: { id?: string; cdp_url?: string } };
  const id = payload.data?.id;
  const cdpUrl = payload.data?.cdp_url;
  if (!id || !cdpUrl) throw new Error('Anchor session response had no id or cdp_url');
  return {
    backend: 'anchor',
    cdpUrl,
    sessionId: id,
    close: async () => {
      await fetch(`${ANCHOR_API}/v1/sessions/${id}`, { method: 'DELETE', headers }).catch(() => undefined);
    },
    saveRecording: async (file) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const recording = await fetch(`${ANCHOR_API}/v1/sessions/${id}/recordings/primary/fetch`, { headers }).catch(() => null);
        if (recording?.ok && /video|octet-stream/.test(recording.headers.get('content-type') ?? '')) {
          const bytes = Buffer.from(await recording.arrayBuffer());
          if (bytes.length > 10_000) {
            fs.writeFileSync(file, bytes);
            return true;
          }
        }
        await sleep(6_000);
      }
      return false;
    },
  };
}

export async function openBrowser(options: BrowserOptions): Promise<BrowserHandle> {
  if (options.backend === 'anchor') return launchAnchor(options);
  if (options.backend === 'cdp') {
    if (!options.cdpUrl) throw new Error('The cdp backend needs --cdp-url or COMMERCE_BENCH_CDP_URL.');
    return { backend: 'cdp', cdpUrl: options.cdpUrl, close: async () => undefined };
  }
  return launchLocal(options.headed ?? false);
}
