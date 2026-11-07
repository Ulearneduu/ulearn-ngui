import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeInterviewCodingProblem,
  normalizeInterviewCodingLanguage,
  parseInterviewCodingProblem,
  parseInterviewSessionCodingRow,
  toInterviewCodingJson,
} from './interview-coding.ts';

test('parseInterviewCodingProblem reads snake_case DB payload', () => {
  const problem = parseInterviewCodingProblem({
    enabled: true,
    title: 'Sum two numbers',
    prompt: 'Read two ints and print the sum.',
    starter_code: 'print(1)',
    language: 'python',
    public_test_cases: [{ input: '1 2', expectedOutput: '3' }],
  });
  assert.ok(problem);
  assert.equal(problem.enabled, true);
  assert.equal(problem.language, 'python');
  assert.equal(problem.starterCode, 'print(1)');
  assert.deepEqual(problem.publicTestCases, [{ input: '1 2', expectedOutput: '3' }]);
});

test('activeInterviewCodingProblem requires enabled + prompt', () => {
  assert.equal(
    activeInterviewCodingProblem({
      enabled: false,
      title: 'X',
      prompt: 'Do it',
      starter_code: '',
      language: 'javascript',
      public_test_cases: [],
    }),
    null
  );
  assert.ok(
    activeInterviewCodingProblem({
      enabled: true,
      title: 'X',
      prompt: 'Do it',
      starter_code: '',
      language: 'js',
      public_test_cases: [],
    })
  );
});

test('toInterviewCodingJson round-trips for admin save', () => {
  const json = toInterviewCodingJson({
    enabled: true,
    title: 'Sum',
    prompt: 'Add',
    starterCode: 'x',
    language: 'javascript',
    publicTestCases: [{ input: '1 1', expectedOutput: '2' }],
  });
  assert.deepEqual(json, {
    enabled: true,
    title: 'Sum',
    prompt: 'Add',
    starter_code: 'x',
    language: 'javascript',
    public_test_cases: [{ input: '1 1', expectedOutput: '2' }],
  });
  assert.equal(toInterviewCodingJson(null), null);
});

test('normalizeInterviewCodingLanguage aliases', () => {
  assert.equal(normalizeInterviewCodingLanguage('py'), 'python');
  assert.equal(normalizeInterviewCodingLanguage('c++'), 'cpp');
  assert.equal(normalizeInterviewCodingLanguage('unknown'), 'javascript');
});

test('parseInterviewSessionCodingRow maps session persistence', () => {
  const row = parseInterviewSessionCodingRow({
    session_id: 'sess-1',
    language: 'python',
    code: 'print(3)',
    passed_count: 1,
    total_count: 1,
    all_passed: true,
    results_json: [
      {
        input: '1 2',
        expectedOutput: '3',
        actualOutput: '3',
        passed: true,
      },
    ],
    problem_snapshot: {
      enabled: true,
      title: 'Sum',
      prompt: 'Add',
      starter_code: '',
      language: 'python',
      public_test_cases: [],
    },
    updated_at: '2026-11-07T00:00:00.000Z',
    submitted_at: '2026-11-07T00:01:00.000Z',
  });
  assert.ok(row);
  assert.equal(row.sessionId, 'sess-1');
  assert.equal(row.allPassed, true);
  assert.equal(row.results.length, 1);
});
