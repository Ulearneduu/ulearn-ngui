import assert from 'node:assert/strict';
import test from 'node:test';
import type { InterviewTurn } from '../models/index.ts';
import {
  canReclaimEvaluation,
  canStartInterviewRedo,
  compareInterviewEvaluations,
  evaluationPhase,
  formatScore,
  formatScoreDelta,
  interviewRedoBlockedReason,
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
  assert.equal(snapshot.aiOverallScore, 75);
  assert.equal(snapshot.mentorReviewPublished, false);
  assert.equal(snapshot.mentorAdjusted, false);
  assert.deepEqual(snapshot.competencies.map((item) => item.score), [80, 70]);
  assert.deepEqual(snapshot.competencies.map((item) => item.aiScore), [80, 70]);
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

test('published mentor overrides change displayed scores without erasing AI baselines', () => {
  const snapshot = parseEvaluationSnapshot(
    { ...sessionRow, mentor_review_published: true },
    [
      {
        id: 's1',
        competency: 'Communication',
        score: 70,
        rationale: 'Clear.',
        evidence: 'Short answer.',
        eval_version: 'INT008-v1',
      },
      {
        id: 's2',
        competency: 'Coding',
        score: 100,
        rationale: 'Public tests passed.',
        evidence: '2/2',
        eval_version: 'INT008-v1',
      },
    ],
    turns,
    [
      {
        id: 'o1',
        session_id: sessionRow.id,
        mentor_id: 'mentor-1',
        target_kind: 'competency',
        competency: 'Communication',
        eval_version: 'INT008-v1',
        old_score: 70,
        new_score: 85,
        reason: 'Transcript shows stronger clarity than the model credited.',
        created_at: '2026-11-07T10:00:00.000Z',
      },
      {
        id: 'o2',
        session_id: sessionRow.id,
        mentor_id: 'mentor-1',
        target_kind: 'overall',
        competency: null,
        eval_version: 'INT008-v1',
        old_score: 92.5,
        new_score: 90,
        reason: 'Overall capped after coaching discussion with the student.',
        created_at: '2026-11-07T10:05:00.000Z',
      },
    ]
  );
  assert.ok(snapshot);
  if (!snapshot) return;
  assert.equal(snapshot.mentorReviewPublished, true);
  assert.equal(snapshot.mentorAdjusted, true);
  assert.equal(snapshot.aiOverallScore, 75);
  assert.equal(snapshot.overallScore, 90);
  assert.equal(snapshot.competencies.find((row) => row.competency === 'Communication')?.score, 85);
  assert.equal(snapshot.competencies.find((row) => row.competency === 'Communication')?.aiScore, 70);
  assert.equal(snapshot.competencies.find((row) => row.competency === 'Coding')?.score, 100);
  assert.equal(snapshot.competencies.find((row) => row.competency === 'Coding')?.mentorAdjusted, false);
});

test('overrides from a different eval_version do not affect the displayed scorecard', () => {
  const snapshot = parseEvaluationSnapshot(
    { ...sessionRow, mentor_review_published: true },
    [
      {
        id: 's1',
        competency: 'Communication',
        score: 70,
        rationale: 'Clear.',
        evidence: 'Short answer.',
        eval_version: 'INT008-v1',
      },
    ],
    turns,
    [
      {
        id: 'old-version',
        session_id: sessionRow.id,
        mentor_id: 'mentor-1',
        target_kind: 'competency',
        competency: 'Communication',
        eval_version: 'INT008-v0',
        old_score: 70,
        new_score: 99,
        reason: 'Stale override from a previous evaluation version.',
        created_at: '2026-11-07T10:00:00.000Z',
      },
    ]
  );
  assert.ok(snapshot);
  if (!snapshot) return;
  assert.equal(snapshot.competencies[0]?.score, 70);
  assert.equal(snapshot.mentorAdjusted, false);
});

test('unpublished mentor overrides stay hidden from the student snapshot', () => {
  const snapshot = parseEvaluationSnapshot(
    { ...sessionRow, mentor_review_published: false },
    [
      {
        id: 's1',
        competency: 'Communication',
        score: 70,
        rationale: 'Clear.',
        evidence: 'Short answer.',
        eval_version: 'INT008-v1',
      },
    ],
    turns,
    [
      {
        id: 'o1',
        session_id: sessionRow.id,
        mentor_id: 'mentor-1',
        target_kind: 'competency',
        competency: 'Communication',
        eval_version: 'INT008-v1',
        old_score: 70,
        new_score: 95,
        reason: 'Should remain hidden until published to the student.',
        created_at: '2026-11-07T10:00:00.000Z',
      },
    ]
  );
  assert.ok(snapshot);
  if (!snapshot) return;
  assert.equal(snapshot.overallScore, 75);
  assert.equal(snapshot.competencies[0]?.score, 70);
  assert.equal(snapshot.mentorAdjusted, false);
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

test('redo is allowed for completed sessions except while evaluation is processing', () => {
  assert.equal(canStartInterviewRedo('completed', 'completed'), true);
  assert.equal(canStartInterviewRedo('completed', 'failed'), true);
  assert.equal(canStartInterviewRedo('completed', null), true);
  assert.equal(canStartInterviewRedo('completed', 'processing'), false);
  assert.equal(canStartInterviewRedo('in_progress', 'completed'), false);
  assert.match(interviewRedoBlockedReason('completed', 'processing') ?? '', /scoring finishes/);
});

test('compareInterviewEvaluations reports overall and competency deltas without inventing missing scores', () => {
  const before = parseEvaluationSnapshot(sessionRow, [
    {
      id: 'b1',
      competency: 'Communication',
      score: 60,
      rationale: 'Okay.',
      evidence: 'Short answer.',
      eval_version: 'INT008-v1',
    },
    {
      id: 'b2',
      competency: 'Teamwork',
      score: 70,
      rationale: 'Shared work.',
      evidence: 'Asked both people.',
      eval_version: 'INT008-v1',
    },
  ], turns);
  const afterRow = {
    ...sessionRow,
    id: '33333333-3333-4333-8333-333333333333',
    overall_score: '80.00',
    redo_of_session_id: sessionRow.id,
  };
  const after = parseEvaluationSnapshot(afterRow, [
    {
      id: 'a1',
      competency: 'Communication',
      score: 80,
      rationale: 'Clearer.',
      evidence: 'Named the result.',
      eval_version: 'INT008-v1',
    },
    {
      id: 'a3',
      competency: 'Coding',
      score: 100,
      rationale: 'Passed all public tests.',
      evidence: '2/2 javascript',
      eval_version: 'INT008-v1',
    },
  ], turns);
  assert.ok(before);
  assert.ok(after);
  if (!before || !after) return;

  assert.equal(after.session.redoOfSessionId, sessionRow.id);
  const compared = compareInterviewEvaluations(before, after);
  assert.equal(compared.overall.before, 75);
  assert.equal(compared.overall.after, 80);
  assert.equal(compared.overall.delta, 5);
  assert.equal(compared.overall.trend, 'improved');
  assert.equal(formatScoreDelta(5), '+5');

  const communication = compared.competencies.find((row) => row.competency === 'Communication');
  const teamwork = compared.competencies.find((row) => row.competency === 'Teamwork');
  const coding = compared.competencies.find((row) => row.competency === 'Coding');
  assert.equal(communication?.delta, 20);
  assert.equal(communication?.trend, 'improved');
  assert.equal(teamwork?.before, 70);
  assert.equal(teamwork?.after, null);
  assert.equal(teamwork?.delta, null);
  assert.equal(teamwork?.trend, 'unavailable');
  assert.equal(coding?.before, null);
  assert.equal(coding?.after, 100);
  assert.equal(coding?.trend, 'unavailable');
  assert.equal(compared.competencies.filter((row) => row.competency === 'Coding').length, 1);

  const regressed = compareInterviewEvaluations(after, before);
  assert.equal(regressed.overall.trend, 'regressed');
  assert.equal(regressed.overall.delta, -5);

  const missingOverall = compareInterviewEvaluations(null, {
    ...after,
    overallScore: null,
    competencies: after.competencies,
  });
  assert.equal(missingOverall.overall.trend, 'unavailable');
  assert.equal(missingOverall.overall.delta, null);
});
