import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { requestInterviewReply } from './interview-turn-policy.ts';
import {
  acceptUsageEvents,
  averageScore,
  completionRate,
  decimalToMicros,
  elapsedSeconds,
  estimateCallCost,
  matchesUsageFilter,
  readOpenAiUsage,
  selectRate,
  summarizeUsage,
  usageEventKey,
  usageRecordKey,
  readProviderCall,
  type ModelRate,
  type UsageSessionFact,
} from './interview-usage.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const sql = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261110_int016_interview_usage_analytics.sql'),
  'utf8'
);

const USD: ModelRate = {
  provider: 'openai',
  model: 'gpt-6-luna',
  currency: 'USD',
  inputPerMillion: '2.50',
  outputPerMillion: '10',
  effectiveFrom: '2026-01-01',
};

const OTHER: ModelRate = {
  provider: 'openai',
  model: 'other-model',
  currency: 'EUR',
  inputPerMillion: '1',
  outputPerMillion: '2',
  effectiveFrom: '2026-01-01',
};

function session(partial: Partial<UsageSessionFact> & Pick<UsageSessionFact, 'id' | 'studentId'>): UsageSessionFact {
  return {
    college: null,
    batchIds: [],
    status: 'completed',
    startedAt: '2026-11-01T00:00:00.000Z',
    endedAt: '2026-11-01T00:20:00.000Z',
    score: 80,
    templateId: 'template-hr',
    events: [],
    ...partial,
  };
}

const period = {
  from: '2026-11-01T00:00:00.000Z',
  to: '2026-12-01T00:00:00.000Z',
  college: null,
  batchId: null,
  status: null,
  templateId: null,
};

test('provider usage is read from the response and is not invented', () => {
  assert.deepEqual(
    readOpenAiUsage({ usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }),
    { inputTokens: 12, outputTokens: 4, known: true }
  );
  assert.deepEqual(
    readOpenAiUsage({ usage: { input_tokens: 3, output_tokens: 0 } }),
    { inputTokens: 3, outputTokens: 0, known: true }
  );
  assert.equal(readOpenAiUsage({ choices: [{ message: { content: 'Hi' } }] }).known, false);
  assert.equal(readOpenAiUsage({ usage: { prompt_tokens: 8 } }).known, false);
  assert.equal(readOpenAiUsage({ usage: { prompt_tokens: -1, completion_tokens: 2 } }).known, false);
  assert.equal(readOpenAiUsage(null).known, false);
});

test('a retried provider call returns only the accepted response usage', async () => {
  let calls = 0;
  const result = await requestInterviewReply({
    model: 'gpt-6-luna',
    apiKey: 'test-key',
    systemPrompt: 'Ask one question.',
    conversation: [{ role: 'user', content: 'Ready' }],
    timeoutMs: 1000,
    maxRetries: 1,
    retryBaseMs: 1,
    sleep: async () => undefined,
    random: () => 0,
    createAttemptId: () => '11111111-1111-4111-8111-111111111111',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('busy', { status: 429, headers: { 'retry-after': '0' } });
      return Response.json({
        choices: [{ message: { content: 'Tell me about a project.' } }],
        usage: { prompt_tokens: 40, completion_tokens: 9 },
      });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, {
    ok: true,
    text: 'Tell me about a project.',
    usage: { inputTokens: 40, outputTokens: 9, known: true },
    calls: [{
      responseId: null,
      attemptId: '11111111-1111-4111-8111-111111111111',
      usage: { inputTokens: 40, outputTokens: 9, known: true },
    }],
  });
  const replay = usageRecordKey({
    responseId: null,
    attemptId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(usageRecordKey({ responseId: null, attemptId: result.calls[0]?.attemptId ?? '' }), replay);
});

test('an unreadable 200 is kept as unknown usage and a later response is not collapsed', async () => {
  let calls = 0;
  const attemptIds = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  const result = await requestInterviewReply({
    model: 'gpt-6-luna',
    apiKey: 'test-key',
    systemPrompt: 'Ask one question.',
    conversation: [{ role: 'user', content: 'Ready' }],
    timeoutMs: 1000,
    maxRetries: 1,
    retryBaseMs: 1,
    sleep: async () => undefined,
    random: () => 0,
    createAttemptId: () => attemptIds[calls] ?? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ id: 'chatcmpl-unreadable', usage: { prompt_tokens: 8, completion_tokens: 1 } });
      }
      return Response.json({
        id: 'chatcmpl-accepted',
        choices: [{ message: { content: 'What did you build?' } }],
        usage: { prompt_tokens: 11, output_tokens: 4 },
      });
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0]?.usage.known, true);
  assert.equal(result.calls[0]?.usage.inputTokens, 8);
  assert.equal(result.calls[1]?.responseId, 'chatcmpl-accepted');
  const firstKey = usageRecordKey({
    responseId: result.calls[0]?.responseId ?? null,
    attemptId: result.calls[0]?.attemptId ?? '',
  });
  const secondKey = usageRecordKey({
    responseId: result.calls[1]?.responseId ?? null,
    attemptId: result.calls[1]?.attemptId ?? '',
  });
  assert.equal(firstKey, 'provider:chatcmpl-unreadable');
  assert.equal(secondKey, 'provider:chatcmpl-accepted');
  assert.equal(usageRecordKey({
    responseId: 'chatcmpl-accepted',
    attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  }), secondKey);
  assert.equal(readProviderCall('not-json').usage.known, false);
});

test('missing provider ids stay distinct per attempt and a replay reuses the attempt', () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const missing = usageRecordKey({ responseId: null, attemptId: first });
  assert.equal(usageRecordKey({ responseId: null, attemptId: first }), missing);
  assert.notEqual(usageRecordKey({ responseId: null, attemptId: second }), missing);
  assert.equal(usageRecordKey({ responseId: 'chatcmpl-known', attemptId: first }), 'provider:chatcmpl-known');
  assert.throws(() => usageRecordKey({ responseId: null, attemptId: 'client-supplied' }));
  const unknown = readProviderCall({ id: 'chatcmpl-unknown-usage' });
  assert.equal(unknown.usage.known, false);
  assert.equal(unknown.usage.inputTokens, null);
  assert.equal(unknown.usage.outputTokens, null);
});

test('a failed request stores nothing and two id-less requests stay separate', async () => {
  const ids = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ];
  let issued = 0;
  const failed = await requestInterviewReply({
    model: 'gpt-6-luna',
    apiKey: 'test-key',
    systemPrompt: 'Ask one question.',
    conversation: [{ role: 'user', content: 'Ready' }],
    timeoutMs: 1000,
    maxRetries: 1,
    retryBaseMs: 1,
    sleep: async () => undefined,
    fetchImpl: async () => new Response('no', { status: 400 }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.calls.length, 0);

  let fetches = 0;
  const distinct = await requestInterviewReply({
    model: 'gpt-6-luna',
    apiKey: 'test-key',
    systemPrompt: 'Ask one question.',
    conversation: [{ role: 'user', content: 'Ready' }],
    timeoutMs: 1000,
    maxRetries: 1,
    retryBaseMs: 1,
    sleep: async () => undefined,
    createAttemptId: () => {
      const id = ids[issued];
      issued += 1;
      return id ?? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    },
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) return Response.json({ choices: [] });
      return Response.json({ choices: [{ message: { content: 'Next question?' } }] });
    },
  });
  assert.equal(distinct.ok, true);
  if (!distinct.ok) return;
  assert.equal(distinct.calls.length, 2);
  assert.equal(distinct.calls[0]?.usage.known, false);
  assert.equal(distinct.calls[1]?.usage.known, false);
  assert.notEqual(distinct.calls[0]?.attemptId, distinct.calls[1]?.attemptId);
  assert.notEqual(
    usageRecordKey({ responseId: null, attemptId: distinct.calls[0]?.attemptId ?? '' }),
    usageRecordKey({ responseId: null, attemptId: distinct.calls[1]?.attemptId ?? '' }),
  );
});

test('token totals accumulate known calls and leave missing metadata unknown', () => {
  const seen = new Set<string>();
  const first = acceptUsageEvents(seen, [
    { key: usageEventKey('turn', 's1', 'c1', 0), input: 10, output: 5 },
    { key: usageEventKey('turn', 's1', 'c1', 1), input: 4, output: 2 },
  ]);
  const retry = acceptUsageEvents(seen, [
    { key: usageEventKey('turn', 's1', 'c1', 0), input: 99, output: 99 },
    { key: usageEventKey('evaluation', 's1', 'claim', 0), input: 7, output: 3 },
  ]);
  assert.equal(first.length, 2);
  assert.equal(retry.length, 1);
  assert.equal(retry[0]?.key.startsWith('evaluation:'), true);

  const summary = summarizeUsage([
    session({
      id: 's1',
      studentId: 'student-a',
      events: [
        { key: 'a', provider: 'openai', model: 'gpt-6-luna', occurredOn: '2026-11-01', usage: { inputTokens: 10, outputTokens: 5, known: true } },
        { key: 'b', provider: 'openai', model: 'gpt-6-luna', occurredOn: '2026-11-01', usage: { inputTokens: null, outputTokens: null, known: false } },
      ],
    }),
  ], [USD]);
  assert.equal(summary.inputTokens, 10);
  assert.equal(summary.outputTokens, 5);
  assert.equal(summary.totalTokens, null);
  assert.equal(summary.usageIncomplete, true);
  assert.equal(summary.costStatus, 'estimated');
  assert.equal(summary.estimatedCostMicros, 75n);
});

test('cost uses configured per-million rates and does not invent a zero', () => {
  assert.equal(decimalToMicros('2.50'), 2_500_000n);
  const known = { inputTokens: 1_000_000, outputTokens: 500_000, known: true };
  const priced = estimateCallCost(known, USD);
  assert.equal(priced.status, 'estimated');
  assert.equal(priced.currency, 'USD');
  assert.equal(priced.amountMicros, 7_500_000n);

  const missingRate = estimateCallCost(known, null);
  assert.equal(missingRate.status, 'unconfigured');
  assert.equal(missingRate.amountMicros, null);

  const missingUsage = estimateCallCost({ inputTokens: null, outputTokens: null, known: false }, USD);
  assert.equal(missingUsage.status, 'unavailable');
  assert.equal(missingUsage.amountMicros, null);

  const later = selectRate(
    [USD, { ...USD, inputPerMillion: '5', outputPerMillion: '15', effectiveFrom: '2026-06-01' }],
    'openai',
    'gpt-6-luna',
    '2026-07-01'
  );
  assert.equal(later?.inputPerMillion, '5');
  assert.equal(selectRate([USD], 'openai', 'gpt-6-luna', '2025-12-31'), null);

  const mixed = summarizeUsage([
    session({
      id: 's1',
      studentId: 'student-a',
      events: [
        { key: 'a', provider: 'openai', model: 'gpt-6-luna', occurredOn: '2026-11-01', usage: { inputTokens: 100, outputTokens: 50, known: true } },
        { key: 'b', provider: 'openai', model: 'other-model', occurredOn: '2026-11-01', usage: { inputTokens: 100, outputTokens: 50, known: true } },
      ],
    }),
  ], [USD, OTHER]);
  assert.equal(mixed.costStatus, 'mixed');
  assert.equal(mixed.estimatedCostMicros, null);
  assert.equal(mixed.currency, null);
});

test('duration uses start and end, and an open session has no elapsed time', () => {
  assert.equal(elapsedSeconds('2026-11-01T00:00:00.000Z', '2026-11-01T00:20:30.000Z'), 1230);
  assert.equal(elapsedSeconds('2026-11-01T00:00:00.000Z', null), null);
  const summary = summarizeUsage([
    session({ id: 'open', studentId: 'student-a', status: 'in_progress', endedAt: null, score: null }),
    session({ id: 'done', studentId: 'student-b', endedAt: '2026-11-01T00:10:00.000Z', score: null, status: 'completed' }),
    session({ id: 'failed', studentId: 'student-c', status: 'failed', endedAt: '2026-11-01T00:05:00.000Z', score: 10 }),
  ], []);
  assert.equal(summary.sessionsStarted, 3);
  assert.equal(summary.sessionsCompleted, 1);
  assert.equal(summary.completionRate, 33.3);
  assert.equal(summary.averageScore, null);
  assert.equal(summary.scoredSessions, 0);
  assert.equal(summary.sessionsWithEnd, 2);
  assert.equal(summary.sessionsWithoutEnd, 1);
  assert.equal(summary.totalElapsedSeconds, 900);
  assert.equal(summary.averageElapsedSeconds, 450);
  assert.equal(summary.costStatus, 'unavailable');
  assert.equal(summary.inputTokens, null);
});

test('empty, unscored, and filtered sessions stay consistent', () => {
  assert.equal(completionRate(0, 0), null);
  assert.equal(averageScore([null, undefined]), null);
  assert.equal(averageScore([70, 80, 90]), 80);
  const rows = [
    session({ id: 'a', studentId: 'student-a', college: 'Alpha', batchIds: ['batch-1'], templateId: 'hr', score: 70 }),
    session({ id: 'b', studentId: 'student-b', college: 'Beta', batchIds: ['batch-2'], templateId: 'tech', score: 90, startedAt: '2026-10-01T00:00:00.000Z' }),
    session({ id: 'c', studentId: 'student-c', college: '  ', batchIds: [], status: 'in_progress', endedAt: null, score: null }),
  ];
  const november = rows.filter((row) => matchesUsageFilter(row, period));
  assert.deepEqual(november.map((row) => row.id), ['a', 'c']);
  const alpha = november.filter((row) => matchesUsageFilter(row, { ...period, college: 'Alpha' }));
  assert.deepEqual(alpha.map((row) => row.id), ['a']);
  const batch = november.filter((row) => matchesUsageFilter(row, { ...period, batchId: 'batch-1' }));
  assert.deepEqual(batch.map((row) => row.id), ['a']);
  const both = november.filter((row) => matchesUsageFilter(row, { ...period, college: 'Alpha', batchId: 'batch-1', templateId: 'hr' }));
  assert.deepEqual(both.map((row) => row.id), ['a']);
  const unassigned = november.filter((row) => matchesUsageFilter(row, { ...period, college: '__unassigned__', batchId: '__unassigned__' }));
  assert.deepEqual(unassigned.map((row) => row.id), ['c']);
  const summary = summarizeUsage(both, []);
  assert.equal(summary.sessionsStarted, 1);
  assert.equal(summary.sessionsCompleted, 1);
  assert.equal(summary.completionRate, 100);
  assert.equal(summary.averageScore, 70);
  assert.equal(summary.uniqueStudents, 1);
  assert.deepEqual(summarizeUsage([], []), {
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
  });
});

test('the analytics migration authorizes staff, prices explicitly, and hides private text', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.interview_ai_usage/);
  assert.match(sql, /interview_ai_usage_idempotency UNIQUE \(idempotency_key\)/);
  assert.match(sql, /usage_known = true AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.interview_model_rates/);
  assert.equal(sql.includes('INSERT INTO public.interview_model_rates'), false);
  assert.match(sql, /\(u\.input_tokens::numeric \* rate\.input_per_million/);
  assert.match(sql, /\+ u\.output_tokens::numeric \* rate\.output_per_million\) \/ 1000000/);
  assert.match(sql, /public\.has_permission\('dashboard\.view'\)/);
  assert.match(sql, /unauthenticated/);
  assert.match(sql, /forbidden/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.interview_ai_usage FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.interview_usage_report/);
  assert.match(sql, /__unassigned__/);
  assert.match(sql, /status = 'completed' AND overall_score IS NOT NULL/);
  assert.match(sql, /elapsed_start_to_end/);
  assert.match(sql, /idx_interview_sessions_started_at/);
  assert.equal(sql.includes('interview_turns'), false);
  assert.equal(sql.includes('resume_text'), false);
  assert.equal(sql.includes('resume_summary'), false);
  assert.equal(sql.includes('system_prompt'), false);
  const turn = fs.readFileSync(path.join(root, 'supabase/functions/interview-turn/index.ts'), 'utf8');
  const evaluate = fs.readFileSync(path.join(root, 'supabase/functions/interview-evaluate/index.ts'), 'utf8');
  assert.match(turn, /recordInterviewAiUsage/);
  assert.match(turn, /usageRecordKey\(/);
  assert.match(evaluate, /usageRecordKey\(/);
  assert.equal(turn.includes('prompt_tokens'), false);
  assert.equal(/sk-[A-Za-z0-9]{10,}/.test(sql + turn + evaluate), false);
});
