import type { Frame, Page } from 'playwright';
import { HUMAN_CHALLENGE, type PageState } from './detect.ts';

export type RawField = { descriptor: string; type: string; value: string; hidden: boolean };

export type FrameFields = { url: string; isMain: boolean; fields: RawField[] };

export type PageSnapshot = PageState & {
  h1: string;
  addButtons: number;
  productSchema: boolean;
  frameFields: FrameFields[];
};

function collectFields(): RawField[] {
  const fields: RawField[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll<HTMLInputElement>('input, select, textarea')) {
      const label = el.labels?.[0]?.innerText ?? '';
      const rect = el.getBoundingClientRect();
      fields.push({
        descriptor: [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('autocomplete'), label]
          .filter(Boolean)
          .join('|'),
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
        value: typeof el.value === 'string' ? el.value : '',
        hidden:
          el.getAttribute('type') === 'hidden' ||
          el.getAttribute('aria-hidden') === 'true' ||
          el.tabIndex === -1 ||
          (rect.width === 0 && rect.height === 0),
      });
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return fields;
}

function describeMainFrame() {
  const buttons = [...document.querySelectorAll<HTMLElement>('button, input[type=submit], a[role=button]')];
  const label = (el: HTMLElement) => (el.innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').trim();
  const challenge = document.querySelector('#px-captcha')?.getBoundingClientRect();
  return {
    text: document.body?.innerText ?? '',
    h1: [...document.querySelectorAll('h1')].map((el) => el.innerText).join(' '),
    addButtons: buttons.filter((el) => /add to (cart|bag|basket|trolley|order)|buy now/i.test(label(el))).length,
    productSchema: [...document.querySelectorAll('script[type="application/ld+json"]')].some((el) => {
      const json = el.textContent ?? '';
      return /"@type"\s*:\s*"Product"/.test(json) && !/"ItemList"/.test(json);
    }),
    challengeBox: Boolean(challenge && challenge.width > 40 && challenge.height > 20),
  };
}

const EMPTY_MAIN = { text: '', h1: '', addButtons: 0, productSchema: false, challengeBox: false };

async function readFields(frame: Frame): Promise<RawField[]> {
  const fields: unknown = await frame.evaluate(collectFields).catch(() => null);
  return Array.isArray(fields) ? (fields as RawField[]) : [];
}

export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  const frames = page.frames();
  const subFrames = frames.filter((frame) => frame !== page.mainFrame());
  const [title, html, main, frameTexts, fieldLists] = await Promise.all([
    page.title().catch(() => ''),
    page.content().catch(() => ''),
    page.evaluate(describeMainFrame).catch(() => EMPTY_MAIN),
    Promise.all(subFrames.slice(0, 12).map((frame) => frame.evaluate(() => (document.body?.innerText ?? '').slice(0, 400)).catch(() => ''))),
    Promise.all(frames.map(readFields)),
  ]);
  return {
    url: page.url(),
    title,
    text: String(main.text).replace(/\s+/g, ' ').trim(),
    html,
    frames: frames.map((frame) => frame.url()),
    challengeShown: main.challengeBox || HUMAN_CHALLENGE.test(frameTexts.join(' ')),
    h1: main.h1,
    addButtons: main.addButtons,
    productSchema: main.productSchema,
    frameFields: frames.map((frame, index) => ({ url: frame.url(), isMain: frame === page.mainFrame(), fields: fieldLists[index] })),
  };
}
