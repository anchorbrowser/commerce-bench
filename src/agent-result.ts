import { type Money, parseMoney } from './money.ts';
import { isStage, type Stage } from './stages.ts';

export type AgentResult = {
  status: 'completed' | 'blocked' | 'failed';
  claimed_stage?: Stage;
  reported_total?: Money;
  final_url?: string;
  evidence?: Record<string, string>;
  failure?: { code?: string; message?: string };
  steps?: number;
  cost_usd?: number;
};

const STATUS_ALIASES: Record<string, AgentResult['status']> = {
  completed: 'completed',
  complete: 'completed',
  success: 'completed',
  ok: 'completed',
  done: 'completed',
  blocked: 'blocked',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
};

const WRAPPER_KEYS = ['result', 'output', 'data', 'final_result', 'answer', 'response'];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asString = (value: unknown) => (typeof value === 'string' ? value : undefined);
const asNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function normalize(value: unknown, depth = 0): AgentResult | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') {
    try {
      return normalize(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = typeof record.status === 'string' ? STATUS_ALIASES[record.status.toLowerCase()] : undefined;
  if (!status) {
    for (const key of WRAPPER_KEYS) {
      const inner = normalize(record[key], depth + 1);
      if (inner) return inner;
    }
    return null;
  }
  const failure = asRecord(record.failure);
  return {
    status,
    claimed_stage: isStage(record.claimed_stage) ? record.claimed_stage : undefined,
    reported_total: parseMoney(record.reported_total) ?? undefined,
    final_url: asString(record.final_url),
    evidence: Object.fromEntries(Object.entries(asRecord(record.evidence)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    failure: { code: asString(failure.code), message: asString(failure.message) },
    steps: asNumber(record.steps),
    cost_usd: asNumber(record.cost_usd),
  };
}

export function parseAgentResult(text: string): AgentResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const whole = normalize(trimmed);
  if (whole) return whole;
  for (const line of trimmed.split('\n').reverse()) {
    const parsed = normalize(line.trim());
    if (parsed) return parsed;
  }
  const end = trimmed.lastIndexOf('}');
  for (let start = trimmed.indexOf('{'); start !== -1 && start < end; start = trimmed.indexOf('{', start + 1)) {
    const parsed = normalize(trimmed.slice(start, end + 1));
    if (parsed) return parsed;
  }
  return null;
}
