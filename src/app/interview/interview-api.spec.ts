import assert from 'node:assert/strict';
import test from 'node:test';
import {
  interviewFunctionError,
  parseInterviewTurnResponse,
  sanitizeInterviewErrorMessage,
} from './interview-api.ts';

test('function errors stay safe and keep a stable code', async () => {
  assert.equal(
    sanitizeInterviewErrorMessage('The interviewer is taking too long. Please try again.', 'fallback'),
    'The interviewer is taking too long. Please try again.'
  );
  assert.equal(sanitizeInterviewErrorMessage('key AIzaSySecret', 'fallback'), 'fallback');

  const error = await interviewFunctionError({
    context: new Response(JSON.stringify({
      error: 'You do not have access to interviews.',
      code: 'FORBIDDEN',
    }), { status: 403 }),
  });
  assert.equal(error.code, 'FORBIDDEN');
  assert.equal(error.message, 'You do not have access to interviews.');
});

test('a turn response must include the assistant text that will be shown', () => {
  const parsed = parseInterviewTurnResponse({
    assistantMessage: 'What was your role?',
    replayed: false,
    turns: [
      { id: 'u1', role: 'user', content: 'I led it.', seq: 1, createdAt: '2026-10-27T08:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: 'What was your role?', seq: 2, createdAt: '2026-10-27T08:00:01.000Z' },
    ],
  });
  assert.equal(parsed?.turns[0]?.role, 'user');
  assert.equal(parsed?.turns[1]?.seq, 2);
  assert.equal(parseInterviewTurnResponse({ assistantMessage: 'Missing', turns: [] }), null);
});
