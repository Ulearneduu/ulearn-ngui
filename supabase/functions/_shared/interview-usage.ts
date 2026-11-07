/**
 * INT-016 interview usage tracking.
 *
 * Token counts come from the provider usage object. Missing metadata stays
 * unknown. Cost is an estimate only when an approved rate is supplied.
 * The dashboard SQL in 20261110_int016_interview_usage_analytics.sql follows
 * the same completion, duration, token, and cost rules.
 */

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  known: boolean;
}

export const UNKNOWN_USAGE: ProviderUsage = {
  inputTokens: null,
  outputTokens: null,
  known: false,
};

export interface ModelRate {
  provider: string;
  model: string;
  currency: string;
  /** Currency units per 1,000,000 input tokens. Decimal string, not a guessed default. */
  inputPerMillion: string;
  /** Currency units per 1,000,000 output tokens. */
  outputPerMillion: string;
  /** Inclusive ISO date (YYYY-MM-DD) when this rate becomes effective. */
  effectiveFrom: string;
}

export type CostStatus = 'estimated' | 'unavailable' | 'unconfigured' | 'mixed' | 'none' | 'no_usage';

export interface UsageEvent {
  key: string;
  provider: string;
  model: string;
  usage: ProviderUsage;
  /** UTC calendar date of the provider response, YYYY-MM-DD. */
  occurredOn: string;
}

export interface UsageFilter {
  from: string;
  to: string;
  college: string | null;
  batchId: string | null;
  status: 'in_progress' | 'completed' | 'failed' | null;
  templateId: string | null;
}

export interface UsageSessionFact {
  id: string;
  studentId: string;
  college: string | null;
  batchIds: string[];
  status: 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  endedAt: string | null;
  score: number | null;
  templateId: string;
  events: UsageEvent[];
}

export interface UsageSummary {
  sessionsStarted: number;
  sessionsCompleted: number;
  completionRate: number | null;
  averageScore: number | null;
  scoredSessions: number;
  uniqueStudents: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  knownCalls: number;
  unknownCalls: number;
  estimatedCostMicros: bigint | null;
  currency: string | null;
  costStatus: CostStatus;
  usageIncomplete: boolean;
  averageElapsedSeconds: number | null;
  totalElapsedSeconds: number | null;
  sessionsWithEnd: number;
  sessionsWithoutEnd: number;
}

export interface ProviderCall {
  responseId: string | null;
  /** Server-generated id for this provider attempt. Never taken from the client. */
  attemptId: string;
  usage: ProviderUsage;
}

const PROVIDER_RESPONSE_ID = /^[A-Za-z0-9._:-]{6,200}$/;
const SERVER_ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One provider HTTP response. A stable provider id dedupes a replay of that response. */
export function readProviderCall(body: unknown): Omit<ProviderCall, 'attemptId'> {
  const responseId = isRecord(body) && typeof body['id'] === 'string' ? body['id'].trim() : '';
  return {
    responseId: PROVIDER_RESPONSE_ID.test(responseId) ? responseId : null,
    usage: readOpenAiUsage(body),
  };
}

export function newProviderAttemptId(): string {
  return crypto.randomUUID();
}

/**
 * Provider response ids dedupe a replay of that response.
 * A response without an id uses the server attempt id created before that request.
 * Transport retries of one attempt share the id. A later request gets a new id.
 * The attempt id is never read from the browser.
 */
export function usageRecordKey(input: {
  responseId: string | null;
  attemptId: string;
}): string {
  if (input.responseId && PROVIDER_RESPONSE_ID.test(input.responseId)) {
    return `provider:${input.responseId}`;
  }
  if (!SERVER_ATTEMPT_ID.test(input.attemptId)) {
    throw new Error('invalid provider attempt id');
  }
  return `request:${input.attemptId}`;
}

export function readOpenAiUsage(body: unknown): ProviderUsage {
  if (!isRecord(body) || !isRecord(body['usage'])) return UNKNOWN_USAGE;
  const usage = body['usage'];
  const input = readCount(usage['prompt_tokens']) ?? readCount(usage['input_tokens']);
  const output = readCount(usage['completion_tokens']) ?? readCount(usage['output_tokens']);
  if (input === null || output === null) {
    return { inputTokens: input, outputTokens: output, known: false };
  }
  return { inputTokens: input, outputTokens: output, known: true };
}

export function usageEventKey(
  kind: 'turn' | 'evaluation',
  sessionId: string,
  claimId: string,
  index: number
): string {
  return `${kind}:${sessionId}:${claimId}:${index}`;
}

/** Drop a repeated provider call that shares an idempotency key. */
export function acceptUsageEvents<T extends { key: string }>(seen: Set<string>, events: T[]): T[] {
  const accepted: T[] = [];
  for (const event of events) {
    if (seen.has(event.key)) continue;
    seen.add(event.key);
    accepted.push(event);
  }
  return accepted;
}

export function elapsedSeconds(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 1000);
}

export function completionRate(started: number, completed: number): number | null {
  if (!Number.isFinite(started) || started <= 0) return null;
  return Math.round((completed / started) * 1000) / 10;
}

export function averageScore(scores: Array<number | null | undefined>): number | null {
  const valid = scores.filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  if (valid.length === 0) return null;
  const mean = valid.reduce((sum, score) => sum + score, 0) / valid.length;
  return Math.round(mean * 100) / 100;
}

export function selectRate(
  rates: readonly ModelRate[],
  provider: string,
  model: string,
  onDate: string
): ModelRate | null {
  let selected: ModelRate | null = null;
  for (const rate of rates) {
    if (rate.provider !== provider || rate.model !== model) continue;
    if (rate.effectiveFrom > onDate) continue;
    if (!selected || rate.effectiveFrom > selected.effectiveFrom) selected = rate;
  }
  return selected;
}

/**
 * estimated_cost = (input_tokens × input_rate + output_tokens × output_rate) / 1_000_000
 * Rates are currency units per 1,000,000 tokens. The result is currency micros
 * (1 currency unit = 1_000_000 micros) so tests can compare exact integers.
 */
export function estimateCallCost(
  usage: ProviderUsage,
  rate: ModelRate | null
): { amountMicros: bigint | null; currency: string | null; status: 'estimated' | 'unavailable' | 'unconfigured' } {
  if (!usage.known || usage.inputTokens === null || usage.outputTokens === null) {
    return { amountMicros: null, currency: null, status: 'unavailable' };
  }
  if (!rate) return { amountMicros: null, currency: null, status: 'unconfigured' };
  const inputRate = decimalToMicros(rate.inputPerMillion);
  const outputRate = decimalToMicros(rate.outputPerMillion);
  if (inputRate === null || outputRate === null) {
    return { amountMicros: null, currency: null, status: 'unconfigured' };
  }
  const amount = (BigInt(usage.inputTokens) * inputRate + BigInt(usage.outputTokens) * outputRate) / 1_000_000n;
  return { amountMicros: amount, currency: rate.currency, status: 'estimated' };
}

export function matchesUsageFilter(session: UsageSessionFact, filter: UsageFilter): boolean {
  const started = Date.parse(session.startedAt);
  const from = Date.parse(filter.from);
  const to = Date.parse(filter.to);
  if (!Number.isFinite(started) || !Number.isFinite(from) || !Number.isFinite(to)) return false;
  if (started < from || started >= to) return false;
  if (filter.status && session.status !== filter.status) return false;
  if (filter.templateId && session.templateId !== filter.templateId) return false;
  if (filter.college === '__unassigned__') {
    if (normalizeLabel(session.college) !== null) return false;
  } else if (filter.college !== null && normalizeLabel(session.college) !== filter.college) {
    return false;
  }
  if (filter.batchId === '__unassigned__') {
    if (session.batchIds.length > 0) return false;
  } else if (filter.batchId !== null && !session.batchIds.includes(filter.batchId)) {
    return false;
  }
  return true;
}

export function summarizeUsage(
  sessions: readonly UsageSessionFact[],
  rates: readonly ModelRate[]
): UsageSummary {
  const empty: UsageSummary = {
    sessionsStarted: 0,
    sessionsCompleted: 0,
    completionRate: null,
    averageScore: null,
    scoredSessions: 0,
    uniqueStudents: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    knownCalls: 0,
    unknownCalls: 0,
    estimatedCostMicros: null,
    currency: null,
    costStatus: 'none',
    usageIncomplete: false,
    averageElapsedSeconds: null,
    totalElapsedSeconds: null,
    sessionsWithEnd: 0,
    sessionsWithoutEnd: 0,
  };
  if (sessions.length === 0) return empty;

  const students = new Set<string>();
  const scores: number[] = [];
  let completed = 0;
  let knownInput = 0;
  let knownOutput = 0;
  let knownCalls = 0;
  let unknownCalls = 0;
  let unpricedKnown = 0;
  let elapsedTotal = 0;
  let withEnd = 0;
  const currencies = new Set<string>();
  let pricedMicros = 0n;
  let anyCall = false;

  for (const session of sessions) {
    students.add(session.studentId);
    if (session.status === 'completed') {
      completed += 1;
      if (typeof session.score === 'number' && Number.isFinite(session.score)) scores.push(session.score);
    }
    const elapsed = elapsedSeconds(session.startedAt, session.endedAt);
    if (elapsed !== null) {
      withEnd += 1;
      elapsedTotal += elapsed;
    }
    for (const event of session.events) {
      anyCall = true;
      if (!event.usage.known || event.usage.inputTokens === null || event.usage.outputTokens === null) {
        unknownCalls += 1;
        continue;
      }
      knownCalls += 1;
      knownInput += event.usage.inputTokens;
      knownOutput += event.usage.outputTokens;
      const priced = estimateCallCost(event.usage, selectRate(rates, event.provider, event.model, event.occurredOn));
      if (priced.status !== 'estimated' || priced.amountMicros === null || !priced.currency) {
        unpricedKnown += 1;
        continue;
      }
      currencies.add(priced.currency);
      pricedMicros += priced.amountMicros;
    }
  }

  let costStatus: CostStatus;
  let estimatedCostMicros: bigint | null = null;
  let currency: string | null = null;
  if (!anyCall) costStatus = 'unavailable';
  else if (knownCalls === 0) costStatus = 'unavailable';
  else if (unpricedKnown > 0) costStatus = 'unconfigured';
  else if (currencies.size > 1) costStatus = 'mixed';
  else if (currencies.size === 1) {
    costStatus = 'estimated';
    estimatedCostMicros = pricedMicros;
    currency = [...currencies][0] ?? null;
  } else costStatus = 'unconfigured';

  return {
    sessionsStarted: sessions.length,
    sessionsCompleted: completed,
    completionRate: completionRate(sessions.length, completed),
    averageScore: averageScore(scores),
    scoredSessions: scores.length,
    uniqueStudents: students.size,
    inputTokens: knownCalls > 0 ? knownInput : null,
    outputTokens: knownCalls > 0 ? knownOutput : null,
    totalTokens: knownCalls > 0 && unknownCalls === 0 ? knownInput + knownOutput : null,
    knownCalls,
    unknownCalls,
    estimatedCostMicros,
    currency,
    costStatus,
    usageIncomplete: unknownCalls > 0,
    averageElapsedSeconds: withEnd > 0 ? Math.round(elapsedTotal / withEnd) : null,
    totalElapsedSeconds: withEnd > 0 ? elapsedTotal : null,
    sessionsWithEnd: withEnd,
    sessionsWithoutEnd: sessions.length - withEnd,
  };
}

export interface UsageInsert {
  sessionId: string;
  userId: string;
  callKind: 'turn' | 'evaluation';
  idempotencyKey: string;
  provider: string;
  model: string;
  usage: ProviderUsage;
}

export interface UsageWriter {
  from(table: string): {
    upsert(
      values: Record<string, unknown>,
      options: { onConflict: string; ignoreDuplicates: boolean }
    ): PromiseLike<{ error: { message?: string } | null }>;
  };
}

/** Server-side insert. A repeated key is ignored. Failures are logged and do not change the interview. */
export async function recordInterviewAiUsage(writer: UsageWriter, row: UsageInsert): Promise<void> {
  const known = row.usage.known && row.usage.inputTokens !== null && row.usage.outputTokens !== null;
  const { error } = await writer.from('interview_ai_usage').upsert(
    {
      session_id: row.sessionId,
      user_id: row.userId,
      call_kind: row.callKind,
      idempotency_key: row.idempotencyKey,
      provider: row.provider,
      model: row.model,
      input_tokens: known ? row.usage.inputTokens : null,
      output_tokens: known ? row.usage.outputTokens : null,
      usage_known: known,
    },
    { onConflict: 'idempotency_key', ignoreDuplicates: true }
  );
  if (error) {
    console.error(JSON.stringify({
      source: 'interview-usage',
      code: 'USAGE_NOT_RECORDED',
      message: error.message ?? 'insert failed',
      sessionId: row.sessionId,
      callKind: row.callKind,
    }));
  }
}

export function decimalToMicros(value: string): bigint | null {
  const text = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const padded = (fraction + '000000').slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(padded);
}

function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function normalizeLabel(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
