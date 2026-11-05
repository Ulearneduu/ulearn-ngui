import {
  classifyInterviewRpcError,
  interviewRpcHttpStatus,
  sqlStateFromRpcError,
} from './interview-rpc-errors.ts';

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

Deno.test('sqlStateFromRpcError reads code field', () => {
  assertEqual(sqlStateFromRpcError({ code: '42501', message: 'x' }), '42501', 'code');
});

Deno.test('sqlStateFromRpcError reads SQLSTATE prefix from message', () => {
  assertEqual(
    sqlStateFromRpcError({
      code: 'PGRST202',
      message: '42501: Interview access denied',
    }),
    '42501',
    'message prefix',
  );
});

Deno.test('classifyInterviewRpcError permission via message', () => {
  assertEqual(
    classifyInterviewRpcError({
      code: 'PGRST116',
      message: 'Interview access denied',
    }),
    'permission',
    'permission message',
  );
});

Deno.test('interviewRpcHttpStatus maps config errors to 503', () => {
  assertEqual(
    interviewRpcHttpStatus({
      message: 'Interview quota configuration is missing or invalid',
      code: '22023',
    }),
    503,
    'config',
  );
});

Deno.test('interviewRpcHttpStatus maps not resumable to 404', () => {
  assertEqual(
    interviewRpcHttpStatus({
      message: 'Interview session not found or not resumable',
      code: 'P0002',
    }),
    404,
    'resume',
  );
});
