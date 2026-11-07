import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectiveCompetencyScore,
  effectiveOverallScore,
  hasMentorAdjustments,
  isValidOverrideReason,
  isValidInterviewScore,
  latestOverrideForTarget,
  overridesForEvalVersion,
  parseOverrideRows,
  type InterviewScoreOverrideRecord,
} from './interview-score-overrides.ts';

const base: InterviewScoreOverrideRecord = {
  id: '1',
  sessionId: 's1',
  mentorId: 'm1',
  targetKind: 'competency',
  competency: 'Communication',
  evalVersion: 'INT008-v1',
  oldScore: 70,
  newScore: 80,
  reason: 'Enough characters for a valid reason.',
  createdAt: '2026-11-07T10:00:00.000Z',
};

test('reason and score validation match INT-015 rules', () => {
  assert.equal(isValidOverrideReason('too short'), false);
  assert.equal(isValidOverrideReason('1234567890'), true);
  assert.equal(isValidInterviewScore(-1), false);
  assert.equal(isValidInterviewScore(100.01), false);
  assert.equal(isValidInterviewScore(88.5), true);
});

test('latest override wins and Coding is treated like any competency', () => {
  const overrides: InterviewScoreOverrideRecord[] = [
    { ...base, id: '1', newScore: 80, createdAt: '2026-11-07T10:00:00.000Z' },
    {
      ...base,
      id: '2',
      competency: 'Coding',
      oldScore: 0,
      newScore: 100,
      createdAt: '2026-11-07T10:01:00.000Z',
    },
    {
      ...base,
      id: '3',
      newScore: 90,
      createdAt: '2026-11-07T10:02:00.000Z',
    },
  ];
  assert.equal(latestOverrideForTarget(overrides, 'competency', 'Communication')?.newScore, 90);
  assert.equal(effectiveCompetencyScore('Communication', 70, overrides), 90);
  assert.equal(effectiveCompetencyScore('Coding', 0, overrides), 100);
  assert.equal(effectiveCompetencyScore('Teamwork', 60, overrides), 60);
});

test('effective overall prefers latest overall override otherwise means competencies', () => {
  const competencies = [
    { competency: 'Communication', score: 70 },
    { competency: 'Coding', score: 100 },
  ];
  const competencyOverrides: InterviewScoreOverrideRecord[] = [
    { ...base, competency: 'Communication', newScore: 80 },
  ];
  assert.equal(effectiveOverallScore(competencies, competencyOverrides, 85), 90);

  const withOverall: InterviewScoreOverrideRecord[] = [
    ...competencyOverrides,
    {
      ...base,
      id: 'overall',
      targetKind: 'overall',
      competency: null,
      oldScore: 90,
      newScore: 87.5,
      createdAt: '2026-11-07T11:00:00.000Z',
    },
  ];
  assert.equal(effectiveOverallScore(competencies, withOverall, 85), 87.5);
  assert.equal(hasMentorAdjustments(competencies, withOverall), true);
});

test('parseOverrideRows accepts snake_case RPC payloads', () => {
  const rows = parseOverrideRows([
    {
      id: 'o1',
      session_id: 's1',
      mentor_id: 'm1',
      mentor_name: 'Ada',
      target_kind: 'overall',
      competency: null,
      eval_version: 'INT008-v1',
      old_score: '70.00',
      new_score: 75,
      reason: 'Valid reason text here.',
      created_at: '2026-11-07T12:00:00.000Z',
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.targetKind, 'overall');
  assert.equal(rows[0]?.oldScore, 70);
  assert.equal(rows[0]?.mentorName, 'Ada');
});

test('overridesForEvalVersion ignores rows from another evaluation version', () => {
  const rows: InterviewScoreOverrideRecord[] = [
    { ...base, id: 'v1', evalVersion: 'INT008-v1', newScore: 80 },
    {
      ...base,
      id: 'v0',
      evalVersion: 'INT008-v0',
      newScore: 10,
      createdAt: '2026-11-07T12:00:00.000Z',
    },
  ];
  const filtered = overridesForEvalVersion(rows, 'INT008-v1');
  assert.equal(filtered.length, 1);
  assert.equal(effectiveCompetencyScore('Communication', 70, filtered), 80);
  assert.equal(overridesForEvalVersion(rows, null).length, 0);
});

test('history-style effective overall stays AI until a published override exists', () => {
  const competencies = [
    { competency: 'Communication', score: 70 },
    { competency: 'Coding', score: 100 },
  ];
  assert.equal(effectiveOverallScore(competencies, [], 85), 85);
  const published = overridesForEvalVersion(
    [
      {
        ...base,
        targetKind: 'overall',
        competency: null,
        oldScore: 85,
        newScore: 92,
        reason: 'Published mentor overall after transcript review.',
      },
    ],
    'INT008-v1'
  );
  assert.equal(effectiveOverallScore(competencies, published, 85), 92);
  assert.equal(hasMentorAdjustments(competencies, published), true);
});
