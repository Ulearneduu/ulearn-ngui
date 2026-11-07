import assert from 'node:assert/strict';
import test from 'node:test';
import type { InterviewTurn } from '../models/index.ts';
import {
  canReclaimEvaluation,
  evaluationPhase,
  formatScore,
  parseEvaluationSnapshot,
  parseInterviewEvaluationResponse,
  practiceTips,
  scoreBarPercent,
  shouldPollEvaluation,
  shouldStartEvaluation,
} from './interview-evaluation.ts';

const turns: InterviewTurn[] = [
  { id: 'a', role: 'assistant', content: 'Question two', seq: 2, createdAt: '2026-11-05T08:01:00.000Z' },
  { id: 'u', role: 'user', content: 'Answer one', seq: 1, createdAt: '2026-11-05T08:00:00.000Z' },
];

const sessionRow = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'completed',
  template_id: '22222222-2222-4222-8222-222222222222',
  prompt_version: 'hr-behavioral:2026-10-24',
  started_at: '2026-11-05T08:00:00.000Z',
  ended_at: '2026-11-05T08:12:00.000Z',
  overall_score: '75.00',
  evaluation_status: 'completed',
  eval_version: 'INT008-v1',
  evaluated_at: '2026-11-05T08:13:00.000Z',
  evaluation_summary: 'A clear example with a missing result.',
  evaluation_strengths: ['Named a specific action.'],
  evaluation_improvements: ['State what changed afterward.'],
  evaluation_claimed_at: '2026-11-05T08:12:30.000Z',
  interview_templates: { title: 'HR Behavioral Interview', kind: 'hr', duration_minutes: 20 },
};

test('the results snapshot uses saved scores and keeps the transcript in order', () => {
  const snapshot = parseEvaluationSnapshot(sessionRow, [
    {
      id: 's2',
      competency: 'Teamwork',
      score: 80,
      rationale: 'Both people were included.',
      evidence: 'Asked both people to restate the goal.',
      eval_version: 'INT008-v1',
    },
    {
      id: 'old',
      competency: 'Teamwork',
      score: 10,
      rationale: 'Older rubric.',
      evidence: 'Old evidence.',
      eval_version: 'INT008-v0',
    },
    {
      id: 's1',
      competency: 'Communication',
      score: 70,
      rationale: 'The point was direct.',
      evidence: 'The answer was two sentences.',
      eval_version: 'INT008-v1',
    },
  ], turns);
  assert.ok(snapshot);
  if (!snapshot) return;
  assert.equal(snapshot.overallScore, 75);
  assert.deepEqual(snapshot.competencies.map((item) => item.score), [80, 70]);
  assert.equal(snapshot.competencies[0]?.feedback, 'Both people were included.');
  assert.deepEqual(snapshot.strengths, ['Named a specific action.']);
  assert.deepEqual(snapshot.improvements, ['State what changed afterward.']);
  assert.deepEqual(snapshot.tips, []);
  assert.deepEqual(snapshot.turns.map((turn) => turn.seq), [1, 2]);
  assert.equal(scoreBarPercent(snapshot.competencies[0]?.score ?? 0), 80);
  assert.equal(formatScore(75), '75');
  assert.equal(evaluationPhase({
    sessionStatus: snapshot.session.status,
    evaluationStatus: snapshot.evaluationStatus,
    overallScore: snapshot.overallScore,
    competencyCount: snapshot.competencies.length,
    userTurns: 1,
    assistantTurns: 1,
    pollTimedOut: false,
  }), 'completed');
});

test('processing, failure, retry, and unauthorized states stay distinct', () => {
  assert.equal(shouldPollEvaluation('processing'), true);
  assert.equal(shouldStartEvaluation('ready', false), true);
  assert.equal(shouldStartEvaluation('failed', false), false);
  assert.equal(shouldStartEvaluation('failed', true), true);
  assert.equal(shouldStartEvaluation('processing', true), false);
  assert.equal(evaluationPhase({
    sessionStatus: 'completed',
    evaluationStatus: 'processing',
    overallScore: null,
    competencyCount: 0,
    userTurns: 1,
    assistantTurns: 1,
    pollTimedOut: false,
  }), 'processing');
  assert.equal(evaluationPhase({
    sessionStatus: 'completed',
    evaluationStatus: 'processing',
    overallScore: null,
    competencyCount: 0,
    userTurns: 1,
    assistantTurns: 1,
    pollTimedOut: true,
  }), 'processing_timeout');
  assert.equal(evaluationPhase({
    sessionStatus: 'completed',
    evaluationStatus: 'failed',
    overallScore: null,
    competencyCount: 0,
    userTurns: 1,
    assistantTurns: 1,
    pollTimedOut: false,
  }), 'failed');
  assert.equal(evaluationPhase({
    sessionStatus: 'completed',
    evaluationStatus: null,
    overallScore: null,
    competencyCount: 0,
    userTurns: 0,
    assistantTurns: 0,
    pollTimedOut: false,
  }), 'empty_transcript');
  assert.equal(evaluationPhase({
    sessionStatus: 'in_progress',
    evaluationStatus: null,
    overallScore: null,
    competencyCount: 0,
    userTurns: 1,
    assistantTurns: 1,
    pollTimedOut: false,
  }), 'not_completed');
  const claimed = Date.parse('2026-11-05T08:12:30.000Z');
  assert.equal(canReclaimEvaluation('processing', '2026-11-05T08:12:30.000Z', claimed + 60_000), false);
  assert.equal(canReclaimEvaluation('processing', '2026-11-05T08:12:30.000Z', claimed + 180_000), true);
  assert.equal(parseEvaluationSnapshot(null, [], []), null);
});

test('the function response is accepted only when it has saved score fields', () => {
  const parsed = parseInterviewEvaluationResponse({
    status: 'completed',
    evalVersion: 'INT008-v1',
    overallScore: 70,
    summary: 'Brief and relevant.',
    strengths: ['Named an action.'],
    improvements: ['Add the result.'],
    evaluatedAt: '2026-11-05T08:13:00.000Z',
    competencies: [
      { competency: 'Communication', score: 70, feedback: 'Clear.', evidence: 'Two sentences.' },
    ],
  });
  assert.equal(parsed?.competencies[0]?.score, 70);
  assert.deepEqual(parsed?.tips, []);
  assert.equal(parseInterviewEvaluationResponse({ status: 'completed', overallScore: 140 }), null);
  assert.equal(parseInterviewEvaluationResponse({ status: 'processing' }), null);
});

test('saved practice tips survive a reload and older scorecards stay usable', () => {
  const saved = [
    'Explain your decision-making process step by step.',
    '  Support the communication answer with one specific example.  ',
    'Use the STAR method to structure the teamwork answer.',
  ];
  const snapshot = parseEvaluationSnapshot({
    ...sessionRow,
    evaluation_tips: saved,
  }, [], turns);
  assert.deepEqual(snapshot?.tips, [
    'Explain your decision-making process step by step.',
    'Support the communication answer with one specific example.',
    'Use the STAR method to structure the teamwork answer.',
  ]);

  const again = parseEvaluationSnapshot({
    ...sessionRow,
    evaluation_tips: snapshot?.tips,
  }, [], turns);
  assert.deepEqual(again?.tips, snapshot?.tips);

  const legacy = parseEvaluationSnapshot(sessionRow, [], turns);
  assert.deepEqual(legacy?.tips, []);
  assert.equal(legacy?.summary, 'A clear example with a missing result.');
  assert.deepEqual(practiceTips(['Only one tip', 'Second tip']), []);
  assert.deepEqual(practiceTips([
    'Explain the decision.',
    'Explain the decision.',
    'Support the example.',
    'State the result.',
  ]), [
    'Explain the decision.',
    'Support the example.',
    'State the result.',
  ]);

  const response = parseInterviewEvaluationResponse({
    status: 'completed',
    evalVersion: 'INT008-v1',
    overallScore: 70,
    summary: 'Brief and relevant.',
    strengths: ['Named an action.'],
    improvements: ['Add the result.'],
    tips: snapshot?.tips,
    evaluatedAt: '2026-11-05T08:13:00.000Z',
    competencies: [
      { competency: 'Communication', score: 70, feedback: 'Clear.', evidence: 'Two sentences.' },
    ],
  });
  assert.deepEqual(response?.tips, snapshot?.tips);
});
