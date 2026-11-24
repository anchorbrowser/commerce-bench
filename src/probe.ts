import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page, type Request, type Route } from 'playwright';
import { Evidence, type EvidenceConfig, type EvidenceResult, type ObservedRequest, type StageLatch } from './evidence.ts';
import { snapshotPage } from './snapshot.ts';
import { describeError, sleep } from './util.ts';

export type { GuardEvent, PageFlags, StageLatch } from './evidence.ts';

export type ProbeResult = EvidenceResult & { warnings: string[] };

export type ProbeConfig = EvidenceConfig & { cdpUrl: string; outputDir: string; pollIntervalMs?: number };

const BODY_LIMIT = 4_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 45_000;
export const BROWSER_UNRESPONSIVE = 'the browser stopped answering before the run ended';
const isWebPage = (page: Page) => !page.isClosed() && /^https?:/i.test(page.url());

function describeRequest(request: Request): ObservedRequest {
  let body: string | null;
  try {
    body = request.postData()?.slice(0, BODY_LIMIT) ?? null;
  } catch {
    body = null;
  }
  return { url: request.url(), method: request.method(), body };
}

export class Probe {
  private readonly browser: Browser;
  private readonly config: ProbeConfig;
  private readonly evidence: Evidence;
  private readonly contexts = new Set<BrowserContext>();
  private readonly pageIds = new WeakMap<Page, number>();
  private readonly pagesById = new Map<number, Page>();
  private readonly pending = new Set<Promise<void>>();
  private readonly warnings: string[] = [];
  private nextPageId = 1;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private chain: Promise<void> = Promise.resolve();

  private constructor(browser: Browser, config: ProbeConfig) {
    this.browser = browser;
    this.config = config;
    this.evidence = new Evidence(config, (latch, pageId) => this.track(this.capture(latch, pageId)));
  }

  static async start(config: ProbeConfig): Promise<Probe> {
    const browser = await chromium.connectOverCDP(config.cdpUrl);
    fs.mkdirSync(config.outputDir, { recursive: true });
    const probe = new Probe(browser, config);
    await probe.attachNewContexts();
    probe.loopDone = probe.loop();
    return probe;
  }

  async stop(): Promise<ProbeResult> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    const finished = await Promise.race([this.shutDown().then(() => true), sleep(STOP_TIMEOUT_MS).then(() => false)]);
    if (!finished) this.warn(BROWSER_UNRESPONSIVE);
    return this.result();
  }

  private async shutDown() {
    await this.loopDone;
    await this.enqueue(() => this.sweep());
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    for (const context of this.contexts) {
      await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined);
    }
    await this.browser.close().catch(() => undefined);
  }

  result(): ProbeResult {
    return { ...this.evidence.result(), warnings: this.warnings };
  }

  private async attachNewContexts() {
    for (const context of this.browser.contexts()) {
      if (this.contexts.has(context)) continue;
      const late = this.contexts.size > 0;
      this.contexts.add(context);
      context.on('dialog', () => {});
      context.on('request', (request) => this.onRequest(request));
      context.on('page', (page) => this.attachPage(page));
      for (const page of context.pages()) this.attachPage(page);
      try {
        await context.route(this.evidence.guarded, (route) => this.onGuardedRoute(route));
        if (late) this.warn('a browser context opened mid-run; requests it made before the guard attached were not blocked');
      } catch (error) {
        this.evidence.blocking = false;
        this.warn(`request blocking is off for a browser context: ${describeError(error)}`);
      }
    }
  }

  private attachPage(page: Page) {
    const check = () => {
      if (!this.stopped && isWebPage(page)) void this.enqueue(() => this.checkPage(page));
    };
    page.on('domcontentloaded', check);
    page.on('load', check);
    page.on('close', () => {
      const id = this.pageIds.get(page);
      if (id === undefined) return;
      this.pagesById.delete(id);
      this.evidence.forgetPage(id);
    });
  }

  private pageId(page: Page): number {
    let id = this.pageIds.get(page);
    if (id === undefined) {
      id = this.nextPageId++;
      this.pageIds.set(page, id);
      this.pagesById.set(id, page);
    }
    return id;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(work).catch((error) => this.warn(`check failed: ${describeError(error)}`));
    return this.chain;
  }

  private track(work: Promise<void>) {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private onGuardedRoute(route: Route) {
    return this.evidence.shouldBlock(describeRequest(route.request())) ? route.abort('blockedbyclient') : route.continue();
  }

  private onRequest(request: Request) {
    const addToCart = this.evidence.observeRequest(describeRequest(request));
    if (!addToCart) return;
    this.track(
      request
        .response()
        .then((response) => {
          if (response && response.status() < 400) this.evidence.confirmAddToCart(addToCart);
        })
        .catch(() => undefined)
    );
  }

  private async loop(): Promise<void> {
    const interval = this.config.pollIntervalMs ?? 500;
    while (!this.stopped) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, interval);
      });
      this.wake = null;
      if (this.stopped) break;
      await this.enqueue(() => this.sweep());
    }
  }

  private async sweep() {
    await this.attachNewContexts();
    for (const page of this.openPages()) {
      const url = page.url();
      if (url.startsWith('chrome-error://')) this.evidence.observeUnavailable(this.pageId(page), url);
      else if (isWebPage(page)) await this.checkPage(page);
    }
  }

  private openPages(): Page[] {
    return this.browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => !page.isClosed());
  }

  private async checkPage(page: Page) {
    const snapshot = await Promise.race([snapshotPage(page), sleep(SNAPSHOT_TIMEOUT_MS).then(() => null)]);
    if (snapshot) this.evidence.observePage(this.pageId(page), snapshot);
    else this.warn('a page did not answer in time and was skipped for one check');
  }

  private async capture(latch: StageLatch, pageId: number | null) {
    try {
      const latched = pageId === null ? undefined : this.pagesById.get(pageId);
      const page = latched && isWebPage(latched) ? latched : this.openPages().filter(isWebPage).pop();
      if (!page) return;
      const file = path.join(this.config.outputDir, `${latch.stage}.png`);
      fs.writeFileSync(file, await page.screenshot({ type: 'png', timeout: 15_000 }));
      latch.screenshot = path.basename(file);
    } catch (error) {
      this.warn(`screenshot for ${latch.stage} failed: ${describeError(error)}`);
    }
  }

  private warn(message: string) {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }
}
