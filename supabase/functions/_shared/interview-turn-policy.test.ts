import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTERVIEW_TURN_INSTRUCTION,
  SAFE_REDIRECT,
  parseStoredTurnList,
  conversationForModel,
  interviewEndsAtMs,
  isInterviewExpired,
  applyTurnInsert,
  classifyUniqueViolation,
  CLAIM_STALE_MS,
  decideClaim,
  evaluateDirectTurnInsert,
  findSavedAnswer,
  finishSessionRecord,
  planAnswerAfterClose,
  nextSequence,
  normalizeAnswer,
  normalizeClientTurnId,
  normalizeSessionId,
  evaluateTurnMutation,
  persistencePlan,
  positiveDurationMinutes,
  reserveClaimSlot,
  providerUrl,
  readOpenAiAnswer,
  requestInterviewReply,
  retryDelayMs,
  rowsForSuccessfulReply,
  type StoredTurn,
} from './interview-turn-policy.ts';

const SESSION = '11111111-1111-4111-8111-111111111111';
const STARTED = '2026-10-27T08:00:00.000Z';
const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function turn(partial: Partial<StoredTurn> & Pick<StoredTurn, 'role' | 'content' | 'seq'>): StoredTurn {
  return {
    id: partial.id ?? `id-${partial.seq}`,
    role: partial.role,
    content: partial.content,
    seq: partial.seq,
    createdAt: partial.createdAt ?? STARTED,
    clientTurnId: partial.clientTurnId ?? null,
  };
}

test('answer and session validation reject empty and oversized input', () => {
  assert.equal(normalizeSessionId(SESSION), SESSION);
  assert.equal(normalizeSessionId('not-a-session'), null);
  assert.deepEqual(normalizeAnswer('  hello  '), { ok: true, answer: 'hello' });
  assert.equal(normalizeAnswer('   ').ok, false);
  assert.equal(normalizeAnswer('x'.repeat(8001)).ok, false);
  assert.deepEqual(normalizeClientTurnId(KEY_A), { ok: true, clientTurnId: KEY_A });
  assert.equal(normalizeClientTurnId(undefined).ok, false);
  assert.equal(normalizeClientTurnId('bad').ok, false);
});

test('insert rules are unit checks of the proposed trigger, not a live database test', () => {
  const during = Date.parse(STARTED) + 60_000;
  const ended = Date.parse(STARTED) + 20 * 60_000;
  const open = { userId: OWNER, status: 'in_progress', startedAt: STARTED, durationMinutes: 20 };
  assert.equal(
    evaluateDirectTurnInsert({ actorId: OWNER, bypassesOwnership: false, session: open, nowMs: during }).allow,
    true
  );
  const completed = evaluateDirectTurnInsert({
    actorId: OWNER,
    bypassesOwnership: false,
    session: { ...open, status: 'completed' },
    nowMs: during,
  });
  assert.equal(completed.allow, false);
  assert.equal(completed.allow === false && completed.reason, 'finished');
  const failed = evaluateDirectTurnInsert({
    actorId: OWNER,
    bypassesOwnership: false,
    session: { ...open, status: 'failed' },
    nowMs: during,
  });
  assert.equal(failed.allow, false);
  assert.equal(failed.allow === false && failed.reason, 'finished');
  const expired = evaluateDirectTurnInsert({
    actorId: OWNER,
    bypassesOwnership: false,
    session: open,
    nowMs: ended,
  });
  assert.equal(expired.allow, false);
  assert.equal(expired.allow === false && expired.reason, 'expired');
  const foreign = evaluateDirectTurnInsert({
    actorId: OTHER,
    bypassesOwnership: false,
    session: open,
    nowMs: during,
  });
  assert.equal(foreign.allow, false);
  assert.equal(foreign.allow === false && foreign.reason, 'not_owner');
  const missing = evaluateDirectTurnInsert({
    actorId: OWNER,
    bypassesOwnership: false,
    session: null,
    nowMs: during,
  });
  assert.equal(missing.allow, false);
  assert.equal(missing.allow === false && missing.reason, 'missing');
  const assistant = evaluateDirectTurnInsert({
    actorId: OWNER,
    bypassesOwnership: false,
    role: 'assistant',
    session: open,
    nowMs: during,
  });
  assert.equal(assistant.allow, false);
  assert.equal(assistant.allow === false && assistant.reason, 'assistant_role');
  assert.equal(
    evaluateDirectTurnInsert({
      actorId: null,
      bypassesOwnership: true,
      role: 'assistant',
      session: open,
      nowMs: during,
    }).allow,
    true
  );
  assert.equal(evaluateTurnMutation({ command: 'update', bypassesRls: false }).allow, false);
  assert.equal(evaluateTurnMutation({ command: 'delete', bypassesRls: false }).allow, false);
  assert.equal(evaluateTurnMutation({ command: 'update', bypassesRls: true }).allow, true);
});

test('HR template duration expires 20 minutes after the stored start', () => {
  assert.equal(positiveDurationMinutes(20), 20);
  assert.equal(positiveDurationMinutes('20'), 20);
  assert.equal(positiveDurationMinutes(0), null);
  const ends = interviewEndsAtMs(STARTED, 20);
  assert.equal(ends, Date.parse(STARTED) + 20 * 60_000);
  assert.equal(isInterviewExpired(STARTED, 20, ends! - 1), false);
  assert.equal(isInterviewExpired(STARTED, 20, ends!), true);
  assert.equal(isInterviewExpired('not-a-date', 20, ends!), null);
});

test('an unreadable turn rejects the whole history instead of leaving a sequence gap', () => {
  const rows = [
    { id: 'u1', role: 'user', content: 'I led it.', seq: 1, created_at: STARTED },
    { id: 'bad', role: 'system', content: 'hidden', seq: 2, created_at: STARTED },
  ];
  assert.equal(parseStoredTurnList(rows), null);
  const parsed = parseStoredTurnList([rows[0]]);
  assert.equal(parsed?.[0]?.role, 'user');
  assert.equal(parsed?.[0]?.createdAt, STARTED);
});

test('the same idempotency key replays the saved pair and a new key appends', () => {
  const user = turn({ role: 'user', content: 'I led the rollout.', seq: 1, clientTurnId: KEY_A });
  const assistant = turn({ role: 'assistant', content: 'What happened next?', seq: 2 });
  assert.equal(findSavedAnswer([assistant, user], KEY_A).type, 'replay');
  assert.equal(findSavedAnswer([user], KEY_A).type, 'repair');
  assert.equal(findSavedAnswer([user, assistant], KEY_B).type, 'append');
  assert.equal(
    findSavedAnswer(
      [user, turn({ role: 'user', content: 'Another answer.', seq: 3, clientTurnId: KEY_B })],
      KEY_A
    ).type,
    'blocked'
  );
  assert.equal(classifyUniqueViolation('duplicate key value violates unique constraint "interview_turns_session_client_turn"'), 'client_turn');
  assert.equal(classifyUniqueViolation('interview_turns_session_seq_unique'), 'seq');
  assert.equal(classifyUniqueViolation('idx_interview_turns_session_seq'), 'seq');
  assert.equal(classifyUniqueViolation('unrelated constraint'), null);
  assert.equal(nextSequence([user, assistant]), 3);
  assert.equal(persistencePlan(false, 'append'), 'none');
  assert.equal(persistencePlan(true, 'blocked'), 'none');
  const rows = rowsForSuccessfulReply({
    sessionId: SESSION,
    answer: 'Because the team was blocked.',
    assistant: 'How did you measure it?',
    mode: 'append',
    nextSeq: 3,
    clientTurnId: KEY_A,
  });
  assert.deepEqual(rows.map((row) => row.role), ['user', 'assistant']);
  assert.equal(rows[0]?.client_turn_id, KEY_A);
  assert.equal(rows[1]?.client_turn_id, null);
});

test('simulated retries and concurrent answers keep one pair per key and unique sequence', () => {
  const store: StoredTurn[] = [];
  const first = rowsForSuccessfulReply({
    sessionId: SESSION,
    answer: 'I led it.',
    assistant: 'What was your role?',
    mode: 'append',
    nextSeq: 1,
    clientTurnId: KEY_A,
  });
  assert.equal(applyTurnInsert(store, first).ok, true);
  store.push(
    turn({ role: 'user', content: 'I led it.', seq: 1, clientTurnId: KEY_A }),
    turn({ role: 'assistant', content: 'What was your role?', seq: 2 })
  );

  const replay = findSavedAnswer(store, KEY_A);
  assert.equal(replay.type, 'replay');
  assert.equal(replay.type === 'replay' && replay.assistant.content, 'What was your role?');
  assert.equal(applyTurnInsert(store, [{ seq: 9, clientTurnId: KEY_A }]).ok, false);
  assert.equal(
    applyTurnInsert([], [{ seq: 1, clientTurnId: KEY_A }, { seq: 1, clientTurnId: KEY_B }]).ok,
    false
  );

  const other = rowsForSuccessfulReply({
    sessionId: SESSION,
    answer: 'A different answer.',
    assistant: 'Tell me more.',
    mode: 'append',
    nextSeq: 1,
    clientTurnId: KEY_B,
  });
  assert.equal(applyTurnInsert(store, other).ok, false);
  const retried = rowsForSuccessfulReply({
    sessionId: SESSION,
    answer: 'A different answer.',
    assistant: 'Tell me more.',
    mode: 'append',
    nextSeq: nextSequence(store),
    clientTurnId: KEY_B,
  });
  assert.equal(applyTurnInsert(store, retried).ok, true);
  store.push(
    turn({ role: 'user', content: 'A different answer.', seq: 3, clientTurnId: KEY_B }),
    turn({ role: 'assistant', content: 'Tell me more.', seq: 4 })
  );
  assert.deepEqual(store.map((row) => row.seq), [1, 2, 3, 4]);
  assert.equal(new Set(store.map((row) => row.seq)).size, store.length);
  assert.equal(persistencePlan(false, 'append'), 'none');
});

test('a claim lets one worker own an id and a later worker resume or wait', () => {
  const now = Date.parse('2026-10-31T08:00:00.000Z');
  const store = new Map();
  const first = reserveClaimSlot(store, KEY_A, 'I led it.', now);
  const second = reserveClaimSlot(store, KEY_B, 'A different answer.', now);
  const duplicate = reserveClaimSlot(store, KEY_A, 'Changed text.', now + 1);
  assert.equal(first.decision, 'owned');
  assert.equal(second.decision, 'owned');
  assert.equal(duplicate.decision, 'wait');
  assert.equal(store.get(KEY_A)?.answer, 'I led it.');
  assert.equal(decideClaim(store.get(KEY_A) ?? null, now + CLAIM_STALE_MS), 'takeover');

  store.get(KEY_A)!.assistantText = 'What was your role?';
  store.get(KEY_A)!.claimedAtMs = now;
  const resume = reserveClaimSlot(store, KEY_A, 'I led it.', now + CLAIM_STALE_MS);
  assert.equal(resume.decision, 'resume');
  assert.equal(resume.state.assistantText, 'What was your role?');

  store.set(KEY_A, { answer: 'I led it.', status: 'failed', assistantText: null, claimedAtMs: now });
  assert.equal(reserveClaimSlot(store, KEY_A, 'I led it.', now + 1).decision, 'owned');
  assert.equal(persistencePlan(false, 'append'), 'none');
});

test('model conversation keeps history in order and starts with a user turn', () => {
  const conversation = conversationForModel(
    [
      { role: 'assistant', content: 'Tell me about a conflict.' },
      { role: 'user', content: 'I mediated it.' },
    ],
    'We shipped the fix.',
    'append'
  );
  assert.equal(conversation[0]?.role, 'user');
  assert.equal(conversation.at(-1)?.content, 'We shipped the fix.');
  assert.equal(conversation.filter((item) => item.content === 'I mediated it.').length, 1);
});

test('provider calls keep the API key out of the URL and retry only transient failures', async () => {
  const calls: { url: string; body: string; authorization: string; idempotencyKey: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      body: String(init?.body ?? ''),
      authorization: headers.get('authorization') ?? '',
      idempotencyKey: headers.get('idempotency-key') ?? '',
    });
    if (calls.length === 1) return new Response('busy', { status: 429, headers: { 'retry-after': '1' } });
    return Response.json({
      choices: [{ message: { content: 'What was your role?' } }],
    });
  };

  const result = await requestInterviewReply({
    model: 'test-model',
    apiKey: 'test-key',
    systemPrompt: 'You are an HR interviewer.',
    conversation: [{ role: 'user', content: 'I am ready.' }],
    timeoutMs: 1000,
    maxRetries: 1,
    retryBaseMs: 10,
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
    createAttemptId: () => '11111111-1111-4111-8111-111111111111',
  });

  assert.deepEqual(result, {
    ok: true,
    text: 'What was your role?',
    usage: { inputTokens: null, outputTokens: null, known: false },
    calls: [{
      responseId: null,
      attemptId: '11111111-1111-4111-8111-111111111111',
      usage: { inputTokens: null, outputTokens: null, known: false },
    }],
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.idempotencyKey, '11111111-1111-4111-8111-111111111111');
  assert.equal(calls[1]?.idempotencyKey, calls[0]?.idempotencyKey);
  assert.equal(calls[0]?.url, providerUrl());
  assert.equal(calls[0]?.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0]?.url.includes('test-key'), false);
  assert.equal(calls[0]?.body.includes('test-key'), false);
  assert.equal(calls[0]?.body.includes('"model":"test-model"'), true);
  assert.equal(calls[0]?.body.includes('"reasoning_effort":"low"'), true);
  assert.equal(calls[0]?.body.includes('temperature'), false);
  assert.equal(calls[0]?.body.includes('"max_completion_tokens":2048'), true);
  assert.equal(calls[0]?.authorization, 'Bearer test-key');
  assert.equal(calls[0]?.body.includes('You are an HR interviewer.'), true);
  assert.equal(calls[0]?.body.includes(INTERVIEW_TURN_INSTRUCTION), true);
  assert.equal(retryDelayMs(0, 1000, '2', () => 0), 2000);
});

test('provider failures do not invent an answer', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response('no', { status: 400 });
  };
  const result = await requestInterviewReply({
    model: 'test-model',
    apiKey: 'test-key',
    systemPrompt: 'Technical interviewer',
    conversation: [{ role: 'user', content: 'A stack.' }],
    timeoutMs: 1000,
    maxRetries: 2,
    retryBaseMs: 1,
    fetchImpl,
    sleep: async () => undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(result.calls.length, 0);
  assert.equal(readOpenAiAnswer({ choices: [{ message: { refusal: 'no' } }] }), 'blocked');
});

test('a safety block becomes the fixed professional redirect', async () => {
  const fetchImpl: typeof fetch = async () => Response.json({ choices: [{ message: { refusal: 'no' } }] });
  const result = await requestInterviewReply({
    model: 'test-model',
    apiKey: 'test-key',
    systemPrompt: 'HR interviewer',
    conversation: [{ role: 'user', content: 'hello' }],
    timeoutMs: 1000,
    maxRetries: 0,
    retryBaseMs: 1,
    fetchImpl,
    createAttemptId: () => '33333333-3333-4333-8333-333333333333',
  });
  assert.deepEqual(result, {
    ok: true,
    text: SAFE_REDIRECT,
    usage: { inputTokens: null, outputTokens: null, known: false },
    calls: [{
      responseId: null,
      attemptId: '33333333-3333-4333-8333-333333333333',
      usage: { inputTokens: null, outputTokens: null, known: false },
    }],
  });
});

test('expiry completion uses the allotted end time and does not reopen a finished session', () => {
  const endsAt = '2026-10-27T08:20:00.000Z';
  const open = finishSessionRecord({
    mode: 'expired',
    status: 'in_progress',
    endedAt: null,
    endsAt,
    serverNow: '2026-10-27T08:19:59.000Z',
  });
  assert.equal(open.status, 'in_progress');
  assert.equal(open.timeUp, false);

  const due = finishSessionRecord({
    mode: 'expired',
    status: 'in_progress',
    endedAt: null,
    endsAt,
    serverNow: endsAt,
  });
  assert.deepEqual(due, { status: 'completed', endedAt: endsAt, timeUp: true });

  const late = finishSessionRecord({
    mode: 'expired',
    status: 'in_progress',
    endedAt: null,
    endsAt,
    serverNow: '2026-10-27T08:25:00.000Z',
  });
  assert.equal(late.endedAt, endsAt);

  const manual = finishSessionRecord({
    mode: 'manual',
    status: 'in_progress',
    endedAt: null,
    endsAt,
    serverNow: '2026-10-27T08:05:00.000Z',
  });
  assert.deepEqual(manual, {
    status: 'completed',
    endedAt: '2026-10-27T08:05:00.000Z',
    timeUp: false,
  });

  const repeated = finishSessionRecord({
    mode: 'manual',
    status: 'completed',
    endedAt: '2026-10-27T08:05:00.000Z',
    endsAt,
    serverNow: '2026-10-27T08:30:00.000Z',
  });
  assert.equal(repeated.endedAt, '2026-10-27T08:05:00.000Z');
  assert.equal(repeated.status, 'completed');

  const expiredRepeat = finishSessionRecord({
    mode: 'expired',
    status: 'completed',
    endedAt: '2026-10-27T08:05:00.000Z',
    endsAt,
    serverNow: '2026-10-27T08:30:00.000Z',
  });
  assert.equal(expiredRepeat.endedAt, '2026-10-27T08:05:00.000Z');

  const failed = finishSessionRecord({
    mode: 'expired',
    status: 'failed',
    endedAt: '2026-10-27T08:10:00.000Z',
    endsAt,
    serverNow: '2026-10-27T08:30:00.000Z',
  });
  assert.equal(failed.status, 'failed');
});

test('an expired new answer is rejected and a saved answer is replayed without another model call', () => {
  assert.equal(planAnswerAfterClose({ saved: 'append', timeUp: true, status: 'in_progress' }), 'expired');
  assert.equal(planAnswerAfterClose({ saved: 'repair', timeUp: true, status: 'in_progress' }), 'expired');
  assert.equal(planAnswerAfterClose({ saved: 'replay', timeUp: true, status: 'in_progress' }), 'replay');
  assert.equal(planAnswerAfterClose({ saved: 'append', timeUp: false, status: 'completed' }), 'closed');
  assert.equal(planAnswerAfterClose({ saved: 'append', timeUp: false, status: 'in_progress' }), 'continue');
  assert.equal(planAnswerAfterClose({ saved: 'blocked', timeUp: false, status: 'in_progress' }), 'continue');
});
