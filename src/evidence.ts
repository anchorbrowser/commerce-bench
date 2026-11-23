import {
  type Block,
  DELIVERY_UNAVAILABLE,
  DETAILS_REJECTED,
  detectBlock,
  EMPTY_CART,
  ERROR_PAGE,
  findOrderNumber,
  LOGIN_URL,
  NOT_FOUND,
  ORDER_CONFIRMED,
  OUT_OF_STOCK,
} from './detect.ts';
import { type Money, parseTotal } from './money.ts';
import { classifyCardField, guardedUrlPattern, isTokenizeRequest, matchProviderByFrameUrl } from './providers.ts';
import type { PageSnapshot, RawField } from './snapshot.ts';
import { furthest, type Stage, STAGES } from './stages.ts';
import type { Patterns } from './tasks.ts';
import { hostOf, nowIso, sameSite, withoutQuery } from './util.ts';

export type StageLatch = { stage: Stage; at: string; detail: string; screenshot?: string };

export type GuardEvent = {
  kind: 'card_data_entered' | 'tokenize_request' | 'order_request' | 'order_placed';
  detail: string;
  at: string;
  blocked: boolean;
};

export type PageFlags = {
  url: string;
  block: Block | null;
  login: boolean;
  empty_cart: boolean;
  out_of_stock: boolean;
  details_rejected: boolean;
  delivery_unavailable: boolean;
  unavailable: boolean;
  not_found: boolean;
};

export type EvidenceResult = {
  latches: StageLatch[];
  furthest_stage: Stage | null;
  guard_events: GuardEvent[];
  page: PageFlags;
  cart: { product_seen: boolean; variant_seen: boolean | null; add_request: string | null };
  details_matched: { email: boolean; address_line: boolean; postal_code: boolean };
  page_total: (Money & { seen_on: 'cart' | 'checkout' }) | null;
  payment_frames: string[];
};

export type EvidenceConfig = {
  site: string;
  productMatch: string[];
  variantMatch: string[];
  expected: { email: string; addressLine: string; postalCode: string };
  patterns: Patterns;
};

export type ObservedRequest = { url: string; method: string; body: string | null };

export type PageKind = 'cart' | 'checkout' | 'login' | 'other';

const SEARCH_URL = /[?&](?:q|query|search|searchTerm|Ntt|k|st|text|keyword)=|\/search(?:[/?]|$)|\/sch\//i;
const CONTACT_FIELD = /e-?mail|postal|postcode|zip|address|street/i;
const SHIPPING_CHOICE = /ship|deliver/i;
const PAYMENT_HEADING = /payment (?:method|details|information|options)|credit (?:or debit |& prepaid )?cards?/i;
const PAYMENT_STEP_URL = /\/(?:payment|billing)(?:[/?#.]|$)/i;
const THIN_PAGE = 2_500;
const EMPTY_FLAGS: PageFlags = {
  url: '',
  block: null,
  login: false,
  empty_cart: false,
  out_of_stock: false,
  details_rejected: false,
  delivery_unavailable: false,
  unavailable: false,
  not_found: false,
};

const compact = (value: string) => value.replace(/\s+/g, '').toLowerCase();
const hasAll = (tokens: string[], haystack: string) => tokens.every((token) => haystack.includes(token.toLowerCase()));
const matchesAny = (patterns: RegExp[], value: string) => patterns.some((pattern) => pattern.test(value));

function decodeFormBody(body: string): string {
  try {
    return decodeURIComponent(body.replace(/\+/g, ' '));
  } catch {
    return body;
  }
}

export function classifyPage(url: string, text: string, patterns: Patterns, detailsTyped: number): PageKind {
  if (matchesAny(patterns.cart, url)) return detailsTyped >= 2 && !EMPTY_CART.test(text) ? 'checkout' : 'cart';
  if (LOGIN_URL.test(url)) return 'login';
  return matchesAny(patterns.checkout, url) ? 'checkout' : 'other';
}

export class DetailsMatcher {
  email = false;
  addressLine = false;
  postalCode = false;
  completeAt: number | null = null;
  private readonly expected: EvidenceConfig['expected'];

  constructor(expected: EvidenceConfig['expected']) {
    this.expected = expected;
  }

  get count(): number {
    return [this.email, this.addressLine, this.postalCode].filter(Boolean).length;
  }

  observeBody(body: string, now: number) {
    const decoded = decodeFormBody(body);
    const lower = decoded.toLowerCase();
    this.mark(
      lower.includes(this.expected.email.toLowerCase()),
      lower.includes(this.expected.addressLine.toLowerCase()),
      compact(decoded).includes(compact(this.expected.postalCode)),
      now
    );
  }

  matchFields(fields: RawField[]): { email: boolean; addressLine: boolean; postalCode: boolean } {
    const values = fields.map((field) => field.value.trim()).filter(Boolean);
    const lower = values.map((value) => value.toLowerCase());
    return {
      email: lower.includes(this.expected.email.toLowerCase()),
      addressLine: lower.some((value) => value.includes(this.expected.addressLine.toLowerCase())),
      postalCode: values.some((value) => compact(value) === compact(this.expected.postalCode)),
    };
  }

  observeFields(fields: RawField[], now: number) {
    const found = this.matchFields(fields);
    this.mark(found.email, found.addressLine, found.postalCode, now);
  }

  private mark(email: boolean, addressLine: boolean, postalCode: boolean, now: number) {
    this.email ||= email;
    this.addressLine ||= addressLine;
    this.postalCode ||= postalCode;
    if (this.count === 3) this.completeAt ??= now;
  }
}

type Facts = {
  pageId: number;
  url: string;
  kind: PageKind;
  inFlow: boolean;
  snapshot: PageSnapshot;
  visible: RawField[];
  addressInForm: boolean;
  flags: PageFlags;
};

export class Evidence {
  readonly latched = new Map<Stage, StageLatch>();
  readonly details: DetailsMatcher;
  readonly config: EvidenceConfig;
  cartListing: string | null = null;
  addRequest: string | null = null;
  variantSeen: boolean | null = null;
  paymentSeenAt: number | null = null;
  blocking = true;
  readonly guarded: RegExp;
  private readonly guardEvents: GuardEvent[] = [];
  private readonly paymentFrames = new Set<string>();
  private readonly pages = new Map<number, { url: string; flags: PageFlags; changedAt: number }>();
  private readonly onLatch: (latch: StageLatch, pageId: number | null) => void;
  private pageTotal: EvidenceResult['page_total'] = null;

  constructor(config: EvidenceConfig, onLatch: (latch: StageLatch, pageId: number | null) => void = () => {}) {
    this.config = config;
    this.guarded = guardedUrlPattern([...config.patterns.tokenize, ...config.patterns.order_request]);
    this.details = new DetailsMatcher(config.expected);
    this.onLatch = onLatch;
  }

  observeUnavailable(pageId: number, url: string, now = Date.now()) {
    this.rememberFlags(pageId, url, { ...EMPTY_FLAGS, url, unavailable: true }, now);
  }

  forgetPage(pageId: number) {
    if (this.pages.size > 1) this.pages.delete(pageId);
  }

  observePage(pageId: number, snapshot: PageSnapshot, now = Date.now()) {
    const { patterns, site, productMatch, variantMatch } = this.config;
    const url = snapshot.url;
    const text = snapshot.text.toLowerCase();
    const onSite = sameSite(url, site);
    const visible = snapshot.frameFields.flatMap((frame) => frame.fields).filter((field) => !field.hidden);
    const typed = this.details.matchFields(visible);
    const typedHere = Object.values(typed).filter(Boolean).length;
    const kind = classifyPage(url, snapshot.text, patterns, onSite ? typedHere : 0);
    if (kind === 'checkout' || matchesAny(patterns.cart, url)) this.details.observeFields(visible, now);
    const inFlow = onSite || this.latched.has('cart');
    const thin = snapshot.text.length < THIN_PAGE;
    const flags: PageFlags = {
      url: withoutQuery(url),
      block: detectBlock(snapshot),
      login: kind === 'login' && inFlow,
      empty_cart: kind === 'cart' && EMPTY_CART.test(snapshot.text),
      out_of_stock: kind === 'other' && OUT_OF_STOCK.test(snapshot.text) && snapshot.addButtons === 0,
      details_rejected: kind === 'checkout' && DETAILS_REJECTED.test(snapshot.text),
      delivery_unavailable: kind === 'checkout' && DELIVERY_UNAVAILABLE.test(snapshot.text),
      unavailable: thin && ERROR_PAGE.test(snapshot.text),
      not_found: thin && NOT_FOUND.test(`${snapshot.title} ${snapshot.text}`),
    };
    this.rememberFlags(pageId, url, flags, now);
    if (flags.block) return;

    const listsProduct = hasAll(productMatch, text);
    if (kind === 'cart' && onSite && !flags.empty_cart && listsProduct) {
      this.cartListing ??= `cart page lists the product at ${flags.url}`;
      if (variantMatch.length > 0) this.variantSeen = hasAll(variantMatch, text);
    }
    if (kind === 'checkout' && inFlow && listsProduct) this.cartListing ??= `checkout summary lists the product at ${flags.url}`;

    if (kind === 'cart' || kind === 'checkout') {
      const total = parseTotal(snapshot.text);
      if (total && (kind === 'checkout' || this.pageTotal?.seen_on !== 'checkout')) this.pageTotal = { ...total, seen_on: kind };
    }
    if (kind === 'checkout' && inFlow) {
      this.observePayment(snapshot, now);
      this.observeOrderPlaced(flags.url, snapshot.text);
    }
    this.applyRules({ pageId, url: flags.url, kind, inFlow, snapshot, visible, addressInForm: typed.addressLine, flags });
  }

  observeRequest(request: ObservedRequest, now = Date.now()): string | null {
    if (request.method === 'GET') return null;
    const { patterns, site } = this.config;
    const firstParty = sameSite(request.url, site);
    if (request.body && firstParty) this.details.observeBody(request.body, now);

    const handledByRoute = this.blocking && this.guarded.test(request.url);
    const provider = handledByRoute ? null : isTokenizeRequest(request.url, request.body, patterns.tokenize);
    if (provider && !this.hasGuardEvent('tokenize_request')) {
      this.guard('tokenize_request', `${provider} card payload ${request.method} ${hostOf(request.url)}`, false);
    }
    if (!firstParty) return null;
    const byUrl = matchesAny(patterns.add_to_cart, request.url);
    const byBody = request.body ? matchesAny(patterns.add_to_cart_body, request.body) : false;
    if (!byUrl && !byBody) return null;
    return `${request.method} ${withoutQuery(request.url)}${byUrl ? '' : ' (matched body)'}`;
  }

  confirmAddToCart(detail: string) {
    this.addRequest ??= detail;
    this.applyRules(null);
  }

  shouldBlock(request: ObservedRequest): boolean {
    if (request.method === 'GET') return false;
    const { patterns } = this.config;
    const provider = isTokenizeRequest(request.url, request.body, patterns.tokenize);
    if (provider) {
      this.guard('tokenize_request', `${provider} tokenize ${request.method} ${hostOf(request.url)}`, true);
      return true;
    }
    if (matchesAny(patterns.order_request, request.url)) {
      this.guard('order_request', `order request ${request.method} ${withoutQuery(request.url)}`, true);
      return true;
    }
    return false;
  }

  result(): EvidenceResult {
    const current = [...this.pages.values()].sort((a, b) => b.changedAt - a.changedAt)[0];
    return {
      latches: [...this.latched.values()].sort((a, b) => a.at.localeCompare(b.at)),
      furthest_stage: furthest(this.latched.keys()),
      guard_events: this.guardEvents,
      page: current?.flags ?? EMPTY_FLAGS,
      cart: { product_seen: this.cartListing !== null, variant_seen: this.variantSeen, add_request: this.addRequest },
      details_matched: { email: this.details.email, address_line: this.details.addressLine, postal_code: this.details.postalCode },
      page_total: this.pageTotal,
      payment_frames: [...this.paymentFrames],
    };
  }

  private rememberFlags(pageId: number, url: string, flags: PageFlags, now: number) {
    const previous = this.pages.get(pageId);
    this.pages.set(pageId, { url, flags, changedAt: previous && previous.url === url ? previous.changedAt : now });
  }

  private observePayment(snapshot: PageSnapshot, now: number) {
    if (PAYMENT_STEP_URL.test(snapshot.url)) this.paymentSeenAt ??= now;
    for (const frame of snapshot.frameFields) {
      const provider = frame.isMain ? null : matchProviderByFrameUrl(frame.url, this.config.patterns.payment_frame);
      const numberFields = frame.fields.filter((field) => !field.hidden && classifyCardField(field.descriptor) === 'number');
      if (!provider && numberFields.length === 0) continue;
      this.paymentSeenAt ??= now;
      if (!frame.isMain) this.paymentFrames.add(`${provider ?? 'unknown'}:${hostOf(frame.url)}`);
      const digits = Math.max(0, ...numberFields.map((field) => field.value.replace(/\D/g, '').length));
      if (digits >= 12 && !this.hasGuardEvent('card_data_entered')) {
        this.guard('card_data_entered', `card number field holds ${digits} digits on ${hostOf(frame.url)}`, false);
      }
    }
  }

  private observeOrderPlaced(url: string, text: string) {
    if (this.hasGuardEvent('order_placed')) return;
    const confirmed = ORDER_CONFIRMED.exec(text)?.[0];
    if (confirmed && findOrderNumber(text)) this.guard('order_placed', `"${confirmed}" with an order number at ${url}`, false);
  }

  private hasGuardEvent(kind: GuardEvent['kind']): boolean {
    return this.guardEvents.some((event) => event.kind === kind);
  }

  private guard(kind: GuardEvent['kind'], detail: string, blocked: boolean) {
    this.guardEvents.push({ kind, detail, at: nowIso(), blocked });
  }

  private applyRules(facts: Facts | null) {
    for (const stage of STAGES) {
      if (this.latched.has(stage)) continue;
      const detail = STAGE_RULES[stage](this, facts);
      if (!detail) continue;
      const latch: StageLatch = { stage, at: nowIso(), detail };
      this.latched.set(stage, latch);
      this.onLatch(latch, facts?.pageId ?? null);
    }
  }
}

const STAGE_RULES: Record<Stage, (evidence: Evidence, facts: Facts | null) => string | null> = {
  product(evidence, facts) {
    if (!facts || facts.kind !== 'other' || !sameSite(facts.snapshot.url, evidence.config.site)) return null;
    const { patterns, productMatch } = evidence.config;
    const { snapshot } = facts;
    if (SEARCH_URL.test(snapshot.url) || (patterns.product.length > 0 && !matchesAny(patterns.product, snapshot.url))) return null;
    if (!hasAll(productMatch, `${snapshot.h1} ${snapshot.title}`.toLowerCase())) return null;
    const buyable = snapshot.addButtons >= 1 && snapshot.addButtons <= 6;
    return buyable || snapshot.productSchema || facts.flags.out_of_stock ? `product page "${snapshot.title.slice(0, 80)}" at ${facts.url}` : null;
  },

  cart(evidence) {
    if (evidence.cartListing) return evidence.cartListing;
    return evidence.addRequest && evidence.latched.has('product') ? `add-to-cart request ${evidence.addRequest}` : null;
  },

  checkout(_evidence, facts) {
    if (!facts || facts.kind !== 'checkout' || !facts.inFlow) return null;
    const hasContactField = facts.visible.some((field) => field.type === 'email' || CONTACT_FIELD.test(field.descriptor));
    return hasContactField ? `guest checkout form at ${facts.url}` : null;
  },

  shipping(evidence, facts) {
    if (!facts || facts.kind !== 'checkout' || !facts.inFlow || !evidence.latched.has('checkout')) return null;
    const { completeAt } = evidence.details;
    if (completeAt === null || facts.flags.details_rejected || facts.flags.delivery_unavailable) return null;
    const { expected } = evidence.config;
    const pageText = facts.snapshot.text;
    const choices = facts.visible.filter((field) => field.type === 'radio' && SHIPPING_CHOICE.test(field.descriptor)).length;
    if (choices > 0) return `details matched and ${choices} delivery options offered`;
    const postalShown = compact(pageText).includes(compact(expected.postalCode));
    const addressShown = pageText.toLowerCase().includes(expected.addressLine.toLowerCase());
    if (!facts.addressInForm && postalShown && (addressShown || PAYMENT_HEADING.test(pageText))) {
      return 'details matched and the site shows the address as accepted';
    }
    const movedOn = evidence.paymentSeenAt !== null && evidence.paymentSeenAt > completeAt;
    return movedOn ? 'details matched and the site moved on to payment' : null;
  },

  payment(evidence, facts) {
    if (!facts || facts.kind !== 'checkout' || !facts.inFlow) return null;
    return evidence.latched.has('shipping') && evidence.paymentSeenAt !== null ? `payment step shown at ${facts.url}` : null;
  },
};
