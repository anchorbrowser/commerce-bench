export type Money = { amount: number; currency: string | null };

const SYMBOL_CURRENCY: Record<string, string> = { $: 'USD', '£': 'GBP', '€': 'EUR' };
const AMOUNT = String.raw`(?:(USD|GBP|EUR)\s*)?([$£€])\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\s?\.\d{2})?)`;
const TOTAL_TIERS = ['order total|grand total|total to pay|total due|amount due', 'estimated total|total'];
const NOT_A_TOTAL = /sav|discount|item|tax|shipping|delivery|points|reward|off\b/i;

const toAmount = (digits: string) => Number(digits.replace(/[,\s]/g, ''));

export function parseTotal(text: string): Money | null {
  for (const labels of TOTAL_TIERS) {
    const pattern = new RegExp(`(?<![a-z-])(?:${labels})([^\\d$£€]{0,40}?)${AMOUNT}`, 'gi');
    let found: Money | null = null;
    for (const match of text.matchAll(pattern)) {
      if (NOT_A_TOTAL.test(match[1].replace(/\([^)]*\)/g, ''))) continue;
      const amount = toAmount(match[4]);
      if (Number.isFinite(amount)) found = { amount, currency: match[2] ?? SYMBOL_CURRENCY[match[3]] ?? null };
    }
    if (found) return found;
  }
  return null;
}

export function parseMoney(value: unknown): Money | null {
  if (typeof value === 'number') return Number.isFinite(value) ? { amount: value, currency: null } : null;
  if (typeof value === 'string') {
    const match = /(?:(USD|GBP|EUR)\s*)?([$£€])?\s?(\d[\d,]*(?:\.\d+)?)/i.exec(value);
    if (!match) return null;
    return { amount: toAmount(match[3]), currency: match[1]?.toUpperCase() ?? SYMBOL_CURRENCY[match[2] ?? ''] ?? null };
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const inner = parseMoney(record.amount ?? record.value ?? record.total);
    if (!inner) return null;
    return { amount: inner.amount, currency: typeof record.currency === 'string' ? record.currency.toUpperCase() : inner.currency };
  }
  return null;
}
