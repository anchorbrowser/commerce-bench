export type PaymentProvider = {
  id: string;
  framePatterns: RegExp[];
  tokenizePatterns: RegExp[];
  encryptedBodyPatterns?: RegExp[];
  bodyOnlyHosts?: RegExp[];
};

export const PAYMENT_PROVIDERS: PaymentProvider[] = [
  {
    id: 'adyen',
    framePatterns: [/adyen\.com\/checkoutshopper\/.*securedFields/i, /checkoutshopper[^/]*\.adyen\.com/i],
    tokenizePatterns: [/adyen\.com\/checkoutshopper\/.*\/payments/i],
    encryptedBodyPatterns: [/adyenjs_\d+_\d+_\d+\$/i, /"encryptedCardNumber"\s*:\s*"[^"]{40,}"/i],
  },
  {
    id: 'global-e',
    framePatterns: [/global-e\.com/i, /globale\.com/i],
    tokenizePatterns: [/global-e\.com\/.*(payment|token|card)/i],
    encryptedBodyPatterns: [/"encryptedCardNumber"\s*:\s*"[^"]{40,}"/i, /"cardToken"\s*:\s*"[^"]{8,}"/i],
  },
  {
    id: 'stripe',
    framePatterns: [/js\.stripe\.com\/.*(elements-inner-(?:card|payment)|card-?(?:number|element))/i],
    tokenizePatterns: [/api\.stripe\.com\/v1\/(payment_methods|tokens|confirmation_tokens)/i],
  },
  {
    id: 'braintree',
    framePatterns: [/assets\.braintreegateway\.com\/.*hosted-fields/i],
    tokenizePatterns: [],
    encryptedBodyPatterns: [/tokenizeCreditCard/i],
    bodyOnlyHosts: [/payments\.(?:sandbox\.)?braintree-api\.com/i],
  },
  {
    id: 'shopify-pci',
    framePatterns: [/checkout\.pci\.shopifyinc\.com/i],
    tokenizePatterns: [/deposit\.(us|shopifycs)\.com\/sessions/i, /elb\.deposit\.shopifycs\.com\/sessions/i],
  },
  {
    id: 'checkout-com',
    framePatterns: [/frames\.checkout\.com/i, /js\.checkout\.com/i],
    tokenizePatterns: [/api\.(sandbox\.)?checkout\.com\/tokens/i],
  },
  {
    id: 'worldpay-eprotect',
    framePatterns: [/vantivcnp\.com\/eProtect/i, /worldpay\.com\/.*(eprotect|hosted)/i],
    tokenizePatterns: [/vantivcnp\.com\/eProtect\/paypage/i],
  },
  {
    id: 'aurus',
    framePatterns: [/aurus[^/]*\.(com|net)/i],
    tokenizePatterns: [/aurus[^/]*\.(com|net)\/.*(token|payment)/i],
  },
];

export const CARD_FIELD_MATCHERS = {
  number: /(cardnumber|card_number|card-number|encryptedcardnumber|cc-?num|accountnumber|\bpan\b)/i,
  expiry: /(exp(iry|iration)?|encryptedexpiry|cc-?exp|mm ?\/ ?yy|validthru)/i,
  cvv: /(cvv|cvc|csc|securitycode|security_code|encryptedsecurity|\bcid\b)/i,
  name: /(nameoncard|cardholder|card_?holder|cc-?name)/i,
};

export type CardFieldKind = keyof typeof CARD_FIELD_MATCHERS;

export function classifyCardField(descriptor: string): CardFieldKind | null {
  for (const kind of Object.keys(CARD_FIELD_MATCHERS) as CardFieldKind[]) {
    if (CARD_FIELD_MATCHERS[kind].test(descriptor)) return kind;
  }
  return null;
}

export function matchProviderByFrameUrl(url: string, extra: RegExp[] = []): string | null {
  if (extra.some((pattern) => pattern.test(url))) return 'site-defined';
  return (
    PAYMENT_PROVIDERS.find((provider) => provider.framePatterns.some((pattern) => pattern.test(url)))?.id ?? null
  );
}

export function isTokenizeRequest(url: string, postData: string | null, extra: RegExp[] = []): string | null {
  if (extra.some((pattern) => pattern.test(url))) return 'site-defined';
  for (const provider of PAYMENT_PROVIDERS) {
    if (provider.tokenizePatterns.some((pattern) => pattern.test(url))) return provider.id;
    if (postData && provider.encryptedBodyPatterns?.some((pattern) => pattern.test(postData))) return provider.id;
  }
  return null;
}

export function guardedUrlPattern(extra: RegExp[]): RegExp {
  const sources = [
    ...PAYMENT_PROVIDERS.flatMap((provider) => [...provider.tokenizePatterns, ...(provider.bodyOnlyHosts ?? [])]),
    ...extra,
  ].map((pattern) => pattern.source);
  return new RegExp(sources.map((source) => `(?:${source})`).join('|'), 'i');
}
