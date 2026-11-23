export type PageState = { url: string; title: string; text: string; html: string; frames: string[]; challengeShown: boolean };

export const HUMAN_CHALLENGE =
  /press (?:&|and) hold|confirm you(?:'|’)?re a human|(?:please )?verify you are (?:a )?human|human challenge|access to this page has been denied/i;

type Signature = { vendor: string; pattern: RegExp; where: 'markup' | 'text' | 'title'; onRichPages?: boolean; requires?: RegExp };

const BLOCK_SIGNATURES: Signature[] = [
  { vendor: 'datadome', pattern: /captcha-delivery\.com/i, where: 'markup', onRichPages: true },
  { vendor: 'perimeterx', pattern: /px-captcha|press (?:&|and) hold/i, where: 'markup', onRichPages: true, requires: HUMAN_CHALLENGE },
  {
    vendor: 'cloudflare',
    pattern:
      /_cf_chl_opt|cf-challenge-running|id="challenge-form"|challenge-platform\/h\/[bg]\/orchestrate\/(?:chl_page|managed|jsch)/i,
    where: 'markup',
  },
  {
    vendor: 'edge_deny',
    pattern:
      /we'?re sorry[,!]? (?:but )?(?:the site|[\w.]+) is currently unavailable|(?:error id|reference)\s*[#=:]*\s*(?:0\.[0-9a-f]{6,}\.\d{9,}\.[0-9a-f]{6,}|\d{1,2}\.[0-9a-f]{6,}\.\d{9,}\.[0-9a-f]{6,})|access to this page has been denied|request unsuccessful\. incapsula|the request could not be satisfied|you have been blocked|access denied[^.]{0,40}(?:this server|permission)/i,
    where: 'text',
  },
  {
    vendor: 'cloudflare',
    pattern:
      /just a moment\.\.\.|checking (?:your browser|if the site connection is secure)|needs to review the security of your connection|performance & security by cloudflare/i,
    where: 'text',
  },
  { vendor: 'akamai', pattern: /\/_sec\/cp_challenge\/|sec-if-cpt|errors\.edgesuite\.net/i, where: 'markup' },
  { vendor: 'imperva', pattern: /_Incapsula_Resource\?(?:SWUDNSAI|CWUDNSAI)|incapsula incident id/i, where: 'markup' },
  { vendor: 'aws_waf', pattern: /captcha\.awswaf\.com|window\.gokuProps/i, where: 'markup' },
  { vendor: 'alibaba', pattern: /_____tmd_____|nc_1_n1z/i, where: 'markup' },
  {
    vendor: 'akamai',
    pattern: /access denied.{0,80}reference #|you don.t have permission to access/i,
    where: 'text',
  },
  { vendor: 'fastly', pattern: /id="(?:captchaImage|capForm|capInput|capSubmit)"/i, where: 'markup' },
  {
    vendor: 'image_captcha',
    pattern:
      /enter the (?:characters|letters|text|code) (?:you )?(?:see|seen|shown)|type the (?:characters|text) (?:you see|in the image)/i,
    where: 'text',
  },
  {
    vendor: 'generic',
    pattern:
      /pardon our interruption|are you a robot|verify (?:that )?you(?:'re| are) (?:a )?human|unusual (?:traffic|activity)|request (?:was )?blocked|access to this page has been denied|robot or human|not a robot|unable to give you access|you(?:'ve| have) been blocked|(?:request|access) (?:has been |was |is )?(?:blocked|denied)|suspicious (?:activity|traffic)|automated (?:access|queries|requests|traffic)|press (?:&|and) hold|security check|prove you(?:'re| are) (?:a )?human|slide to (?:verify|complete)|human verification/i,
    where: 'text',
  },
  { vendor: 'generic', pattern: /just a moment|attention required|access denied|robot or human/i, where: 'title', onRichPages: true },
];

export type Block = { vendor: string; signal: string };

export const ERROR_PAGE =
  /this page isn.t working|something went wrong|an (?:unexpected )?error (?:has )?occurred|we.re sorry,? (?:but )?(?:something|an error)|oops!? something/i;

export const NOT_FOUND =
  /page not found|\b404\b|ended up somewhere else|can.t find (?:the|that|this) page|page (?:you(?:'re| are) looking for )?(?:doesn.t|does not|no longer) exists?|rearranged some/i;

const PERIMETERX_MARKUP = /px-captcha|perimeterx|px-cdn|px-cloud|\/px\//i;

export function detectBlock(state: PageState): Block | null {
  const visible = `${state.title} ${state.text}`;
  const sources = { markup: [state.url, ...state.frames, state.html].join('\n'), text: visible, title: state.title };
  if (state.challengeShown) {
    return { vendor: PERIMETERX_MARKUP.test(sources.markup) ? 'perimeterx' : 'generic', signal: 'press and hold challenge shown' };
  }
  const thin = state.text.length < 2_500;
  for (const signature of BLOCK_SIGNATURES) {
    if (!thin && !signature.onRichPages) continue;
    if (signature.requires && !signature.requires.test(visible)) continue;
    const match = sources[signature.where].match(signature.pattern);
    if (match) return { vendor: signature.vendor, signal: match[0].slice(0, 80) };
  }
  return null;
}

export const LOGIN_URL =
  /\/(log-?in|sign-?in|signin|identity|auth|account\/login|ap\/signin)\b|^https?:\/\/(identity|login|auth|signin|account)\./i;

export const EMPTY_CART =
  /your (?:shopping )?(?:cart|bag|basket) is (?:currently )?empty|(?:cart|bag|basket) is empty|no items in (?:your )?(?:cart|bag|basket)|you have no items|(?:cart|bag|basket) \(0(?: items?)?\)|nothing in your (?:cart|bag|basket)|(?:cart|bag|basket) is currently empty/i;

export const OUT_OF_STOCK = /out of stock|sold out|currently unavailable|no longer available/i;

export const DETAILS_REJECTED =
  /(?:enter|provide) a valid (?:address|zip|postal|postcode|phone|email)|(?:address|zip code|postal code|postcode|phone number) (?:is|was) (?:invalid|not valid|not recogni[sz]ed)|(?:could not|couldn.t|cannot|can.t) (?:verify|validate|find) (?:this|your|that|the) address/i;

export const DELIVERY_UNAVAILABLE =
  /(?:do(?:es)? not|don.t|cannot|can.t|unable to) (?:ship|deliver) to (?:this|your|that) (?:address|location|area|country|postcode|zip)|(?:shipping|delivery) (?:is )?(?:not |un)available (?:to|for|in) (?:this|your)/i;

const ORDER_NUMBER =
  /\b(?:order|confirmation)\s*(?:number|no\.?|id|#)\s*(?:is\s+)?[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,})/i;

export const ORDER_CONFIRMED =
  /thank you for your (?:order|purchase)|your order (?:is|has been) (?:confirmed|placed|received)/i;

export function findOrderNumber(text: string): string | null {
  const value = ORDER_NUMBER.exec(text)?.[1];
  return value && /\d/.test(value) ? value : null;
}
