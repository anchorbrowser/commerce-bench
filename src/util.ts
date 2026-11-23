import fs from 'node:fs';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const describeError = (error: unknown) =>
  error instanceof Error ? error.message.split('\n')[0] : String(error);

export const nowIso = () => new Date().toISOString();

export function sameSite(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    const target = domain.replace(/^www\./i, '').toLowerCase();
    return host === target || host.endsWith(`.${target}`) || target.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

const SECRET_PARAM = /key|token|secret|auth|sig|pass|credential/i;

export function secretsInUrl(url: string): string[] {
  try {
    const parsed = new URL(url);
    const named = [...parsed.searchParams.entries()].filter(([name]) => SECRET_PARAM.test(name)).map(([, value]) => value);
    return [url, ...named, parsed.password].filter(Boolean);
  } catch {
    return [url];
  }
}

export function redact(text: string, secrets: string[]): string {
  const ordered = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  return ordered.reduce((output, secret) => output.split(secret).join('[redacted]'), text);
}

export const redactDeep = <T>(value: T, secrets: string[]): T => JSON.parse(redact(JSON.stringify(value), secrets)) as T;

export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  );
