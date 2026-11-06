import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVAL_VERSION,
  EVALUATION_RULES,
  aggregateOverallScore,
  buildEvaluationPrompt,
  competenciesForTemplate,
  formatTranscript,
  parseEvaluationPayload,
  planEvaluation,
  requestEvaluationReply,
  rowsToInsert,
} from './interview-evaluate-policy.ts';
import { providerUrl } from './interview-turn-policy.ts';

const HR_RUBRIC = {
  scale: { min: 0, max: 100 },
  competencies: [
    { key: 'communication', label: 'Communication' },
    { key: 'teamwork', label: 'Teamwork' },
    { key: 'problem_solving', label: 'Problem solving' },
    { key: 'decision_making', label: 'Decision making' },
  ],
};

const TURNS = [
  { role: 'assistant' as const, content: 'Tell me about a team conflict.', seq: 1, createdAt: '2026-11-05T08:00:00.000Z' },
  { role: 'user' as const, content: 'I asked both people to restate the goal, then we split the work.', seq: 2, createdAt: '2026-11-05T08:01:00.000Z' },
];

function validJson(overall = 99): string {
  return JSON.stringify({
    overall_score: overall,
    summary: 'The candidate gave one relevant example and kept it brief.',
    strengths: ['The answer named a concrete action.'],
    improvements: ['Add the result of the conversation.'],
    competencies: [
      { name: 'Communication', applicable: true, score: 70, feedback: 'The point was easy to follow.', evidence: 'Restated the goal before splitting the work.' },
      { name: 'Teamwork', applicable: true, score: 80, feedback: 'The example involved both people.', evidence: 'Described asking both people to restate the goal.' },
      { name: 'Problem solving', applicable: false },
      { name: 'Decision making', applicable: true, score: 60, feedback: 'The decision was stated without the outcome.', evidence: 'The candidate stopped at splitting the work.' },
    ],
  });
}

test('a completed transcript is scored from saved turns and the AI overall is ignored', () => {
  const transcript = formatTranscript(TURNS);
  assert.equal(transcript.ok, true);
  if (!transcript.ok) return;
  assert.match(transcript.text, /\[1\] Interviewer/);
  assert.ok(transcript.text.indexOf('[1]') < transcript.text.indexOf('[2]'));
  const competencies = competenciesForTemplate('hr', HR_RUBRIC);
  const parsed = parseEvaluationPayload(validJson(99), competencies);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.evaluation.competencies.map((item) => item.competency), [
    'Communication',
    'Teamwork',
    'Decision making',
  ]);
  assert.equal(aggregateOverallScore(parsed.evaluation.competencies.map((item) => item.score)), 70);
  assert.equal(parsed.evaluation.competencies.some((item) => item.score === 99), false);
});

test('missing authentication and unfinished sessions never reach evaluation', () => {
  assert.equal(planEvaluation({
    sessionStatus: 'in_progress',
    evaluationStatus: null,
    storedVersion: null,
    requestedVersion: EVAL_VERSION,
    claimedAtMs: null,
    nowMs: Date.parse('2026-11-05T08:10:00.000Z'),
    userTurns: 1,
    assistantTurns: 1,
  }).action, 'not_completed');
  assert.equal(planEvaluation({
    sessionStatus: 'failed',
    evaluationStatus: null,
    storedVersion: null,
    requestedVersion: EVAL_VERSION,
    claimedAtMs: null,
    nowMs: 0,
    userTurns: 1,
    assistantTurns: 1,
  }).action, 'not_completed');
});

test('an empty or one-sided transcript is rejected', () => {
  assert.equal(formatTranscript([]).ok, false);
  const questionsOnly = formatTranscript([
    { role: 'assistant', content: 'What is a stack?', seq: 1 },
  ]);
  assert.equal(questionsOnly.ok, false);
  if (!questionsOnly.ok) assert.equal(questionsOnly.reason, 'incomplete_transcript');
  const plan = planEvaluation({
    sessionStatus: 'completed',
    evaluationStatus: null,
    storedVersion: null,
    requestedVersion: EVAL_VERSION,
    claimedAtMs: null,
    nowMs: 0,
    userTurns: 0,
    assistantTurns: 0,
  });
  assert.equal(plan.action, 'empty_transcript');
});

test('malformed JSON and scores outside 0 to 100 are rejected', () => {
  const expected = competenciesForTemplate('hr', HR_RUBRIC);
  const malformed = parseEvaluationPayload('not json', expected);
  assert.equal(malformed.ok, false);
  const payload = JSON.parse(validJson()) as { competencies: { score?: number }[] };
  const first = payload.competencies[0];
  if (!first) throw new Error('missing competency');
  first.score = 140;
  const parsed = parseEvaluationPayload(JSON.stringify(payload), expected);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.reason, 'score_range');
  assert.equal(aggregateOverallScore([101]), null);
  assert.equal(aggregateOverallScore([-1]), null);
});

test('a second request while processing does not start another evaluation', () => {
  const now = Date.parse('2026-11-05T08:10:00.000Z');
  assert.equal(planEvaluation({
    sessionStatus: 'completed',
    evaluationStatus: 'processing',
    storedVersion: null,
    requestedVersion: EVAL_VERSION,
    claimedAtMs: now - 30_000,
    nowMs: now,
    userTurns: 1,
    assistantTurns: 1,
  }).action, 'in_progress');
});

test('a failed evaluation can be retried and a completed version is preserved', () => {
  assert.equal(planEvaluation({
    sessionStatus: 'completed',
    evaluationStatus: 'failed',
    storedVersion: null,
    requestedVersion: EVAL_VERSION,
    claimedAtMs: null,
    nowMs: 0,
    userTurns: 1,
    assistantTurns: 1,
  }).action, 'evaluate');
  assert.equal(planEvaluation({
    sessionStatus: 'completed',
    evaluationStatus: 'completed',
    storedVersion: EVAL_VERSION,
    requestedVersion: EVAL_VERSION,
    claimedAtMs: null,
    nowMs: 0,
    userTurns: 1,
    assistantTurns: 1,
  }).action, 'return_existing');
  assert.equal(planEvaluation({
    sessionStatus: 'completed',
    evaluationStatus: 'completed',
    storedVersion: 'INT008-v0',
    requestedVersion: EVAL_VERSION,
    claimedAtMs: null,
    nowMs: 0,
    userTurns: 1,
    assistantTurns: 1,
  }).action, 'preserve_history');
});

test('retries do not insert duplicate competency rows and old versions stay put', () => {
  const existing = [
    { competency: 'Communication', evalVersion: 'INT008-v0', score: 55 },
    { competency: 'Communication', evalVersion: EVAL_VERSION, score: 70 },
  ];
  const incoming = [
    { competency: 'Communication', score: 10 },
    { competency: 'Teamwork', score: 80 },
    { competency: 'Communication', score: 12 },
  ];
  const inserted = rowsToInsert(existing, incoming, EVAL_VERSION);
  assert.deepEqual(inserted.map((row) => row.competency), ['Teamwork']);
  assert.equal(existing[0]?.score, 55);
  assert.equal(existing[1]?.score, 70);
});

test('the full transcript keeps order and the prompt forbids invented delivery cues', () => {
  const reversed = formatTranscript([...TURNS].reverse());
  assert.equal(reversed.ok, true);
  if (!reversed.ok) return;
  assert.ok(reversed.text.indexOf('Tell me about a team conflict.') < reversed.text.indexOf('I asked both people'));
  const prompt = buildEvaluationPrompt({
    kind: 'technical',
    title: 'SDE Technical Interview',
    durationMinutes: 30,
    competencies: competenciesForTemplate('technical', {}),
    context: 'Ask one question at a time.',
    transcript: reversed.text,
  });
  assert.match(prompt.system, /Do not infer facial expressions, vocal tone, or body language/);
  assert.match(prompt.system, /Technical Knowledge \/ Depth/);
  assert.match(prompt.user, /\[1\] Interviewer/);
  assert.equal(prompt.system.includes('OPENAI_API_KEY'), false);
  assert.match(EVALUATION_RULES, /Do not fabricate technical correctness/);
});

test('technical and HR templates do not share a hardcoded competency list', () => {
  assert.deepEqual(competenciesForTemplate('hr', HR_RUBRIC), [
    'Communication',
    'Teamwork',
    'Problem solving',
    'Decision making',
  ]);
  assert.deepEqual(competenciesForTemplate('technical', {}), [
    'Clarity',
    'Technical Knowledge / Depth',
    'Problem Solving',
    'Communication',
  ]);
  assert.equal(competenciesForTemplate('hr', {}).includes('Technical Knowledge / Depth'), false);
});

test('a provider failure can be retried without inventing a score', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    assert.equal(String(input), providerUrl());
    if (calls === 1) return new Response('busy', { status: 503 });
    return Response.json({ choices: [{ message: { content: validJson(100) } }] });
  };
  const failed = await requestEvaluationReply({
    model: 'gpt-6-luna',
    apiKey: 'test-key',
    system: 'evaluate',
    user: 'transcript',
    timeoutMs: 1000,
    maxRetries: 0,
    retryBaseMs: 1,
    fetchImpl,
    sleep: async () => undefined,
  });
  assert.equal(failed.ok, false);
  const retried = await requestEvaluationReply({
    model: 'gpt-6-luna',
    apiKey: 'test-key',
    system: 'evaluate',
    user: 'transcript',
    timeoutMs: 1000,
    maxRetries: 1,
    retryBaseMs: 1,
    fetchImpl: async () => Response.json({ choices: [{ message: { content: validJson(100) } }] }),
    sleep: async () => undefined,
    random: () => 0,
  });
  assert.equal(retried.ok, true);
  if (!retried.ok) return;
  const parsed = parseEvaluationPayload(retried.text, competenciesForTemplate('hr', HR_RUBRIC));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(aggregateOverallScore(parsed.evaluation.competencies.map((item) => item.score)), 70);
});
