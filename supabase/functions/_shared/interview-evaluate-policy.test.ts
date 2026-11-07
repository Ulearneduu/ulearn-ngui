import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODING_COMPETENCY,
  EVAL_VERSION,
  EVALUATION_RULES,
  MAX_EVALUATION_SCORES,
  aggregateOverallScore,
  buildEvaluationPrompt,
  codingCompetencyFromSessionRow,
  competenciesForTemplate,
  fallbackPracticeTips,
  formatTranscript,
  lowestApplicableCompetencies,
  mergeCodingCompetency,
  normalizePracticeTips,
  parseEvaluationPayload,
  planEvaluation,
  requestEvaluationReply,
  resolvePracticeTips,
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

const TIP_SCORES = [
  { competency: 'Communication', score: 70, feedback: 'The point was easy to follow.', evidence: 'Restated the goal before splitting the work.' },
  { competency: 'Teamwork', score: 90, feedback: 'The example involved both people.', evidence: 'Asked both people to restate the goal.' },
  { competency: 'Decision making', score: 40, feedback: 'The decision was stated without the outcome.', evidence: 'The candidate stopped at splitting the work.' },
  { competency: 'Aptitude', score: -1, feedback: '', evidence: '' },
];

test('practice tips follow the lowest applicable competencies and ignore N/A rows', () => {
  assert.deepEqual(
    lowestApplicableCompetencies(TIP_SCORES).map((row) => row.competency),
    ['Decision making', 'Communication', 'Teamwork']
  );
  const relevant = [
    'Explain the decision making outcome you skipped.',
    'Make the communication point before the example.',
    'State the decision constraint you used.',
  ];
  assert.deepEqual(resolvePracticeTips({
    rawTips: relevant,
    competencies: TIP_SCORES,
    strengths: ['The answer named a concrete action.'],
    improvements: ['Add the result of the conversation.'],
  }), relevant);

  const duplicated = normalizePracticeTips([
    relevant[0],
    `  ${relevant[0]}  `,
    relevant[1],
    relevant[2],
    relevant[2],
  ]);
  assert.deepEqual(duplicated, relevant);

  assert.equal(normalizePracticeTips(['Only one tip', '   ']), null);
  assert.equal(normalizePracticeTips({ tips: true }), null);
  assert.equal(normalizePracticeTips(['One', 'Two', 3]), null);

  const fallback = resolvePracticeTips({ rawTips: ['', 'not-enough'], competencies: TIP_SCORES });
  assert.ok(fallback.length >= 3 && fallback.length <= 5);
  assert.equal(fallback.some((tip) => tip.includes('Decision making')), true);
  assert.equal(fallback.some((tip) => /aptitude/i.test(tip)), false);
  assert.equal(fallback.some((tip) => tip.includes('Teamwork')), false);
  assert.deepEqual(fallback, fallbackPracticeTips(TIP_SCORES));
  assert.deepEqual(fallback, resolvePracticeTips({ rawTips: null, competencies: TIP_SCORES }));

  const unrelated = [
    'Keep using teamwork examples with both people.',
    'Describe how teamwork split the work.',
    'Repeat the teamwork goal with both people.',
  ];
  const replaced = resolvePracticeTips({ rawTips: unrelated, competencies: TIP_SCORES });
  assert.equal(replaced.some((tip) => tip.includes('Decision making')), true);
  assert.equal(replaced.some((tip) => /aptitude/i.test(tip)), false);

  const repeated = resolvePracticeTips({
    rawTips: [fallback[0], fallback[0], fallback[0]],
    competencies: TIP_SCORES,
    improvements: [fallback[0] ?? ''],
  });
  assert.equal(repeated.includes(fallback[0] ?? ''), false);
  assert.ok(repeated.length >= 3 && repeated.length <= 5);
});

test('coding competency comes from persisted public-test results, not the transcript model', () => {
  assert.equal(codingCompetencyFromSessionRow(null), null);
  assert.equal(codingCompetencyFromSessionRow(undefined), null);

  const passed = codingCompetencyFromSessionRow({
    language: 'javascript',
    code: 'return 1',
    passed_count: 2,
    total_count: 2,
    all_passed: true,
  });
  assert.ok(passed);
  assert.equal(passed?.competency, CODING_COMPETENCY);
  assert.equal(passed?.score, 100);
  assert.match(passed?.feedback ?? '', /Passed all 2 public tests/);
  assert.match(passed?.evidence ?? '', /2\/2/);

  const partial = codingCompetencyFromSessionRow({
    language: 'python',
    code: 'print(1)',
    passed_count: 1,
    total_count: 3,
    all_passed: false,
  });
  assert.ok(partial);
  assert.equal(partial?.score, Math.round((100 * 1) / 3 * 100) / 100);
  assert.match(partial?.feedback ?? '', /Passed 1 of 3/);

  const emptyTests = codingCompetencyFromSessionRow({
    language: 'java',
    code: 'class Main {}',
    passed_count: 0,
    total_count: 0,
    all_passed: false,
  });
  assert.ok(emptyTests);
  assert.equal(emptyTests?.score, 0);
});

test('mergeCodingCompetency appends Judge0 Coding and replaces a model Coding row', () => {
  const base = [
    { competency: 'Clarity', score: 70, feedback: 'Clear', evidence: 'Said X' },
    { competency: 'Coding', score: 90, feedback: 'AI guess', evidence: 'Talked about code' },
  ];
  assert.deepEqual(mergeCodingCompetency(base, null).map((item) => item.competency), ['Clarity']);

  const coding = codingCompetencyFromSessionRow({
    language: 'javascript',
    passed_count: 1,
    total_count: 2,
    all_passed: false,
  });
  const merged = mergeCodingCompetency(base, coding);
  assert.deepEqual(merged.map((item) => item.competency), ['Clarity', 'Coding']);
  assert.equal(merged[1]?.score, 50);
  assert.match(merged[1]?.evidence ?? '', /interview_session_coding/);
  assert.equal(merged.some((item) => item.feedback === 'AI guess'), false);

  const hrOnly = mergeCodingCompetency(
    [{ competency: 'Communication', score: 80, feedback: 'ok', evidence: 'y' }],
    null
  );
  assert.deepEqual(hrOnly.map((item) => item.competency), ['Communication']);
  assert.equal(aggregateOverallScore(hrOnly.map((item) => item.score)), 80);
});

test('technical interviews without a coding attempt keep transcript competencies only', () => {
  const technical = competenciesForTemplate('technical', null);
  const parsed = parseEvaluationPayload(JSON.stringify({
    summary: 'Solid technical answers with clear trade-offs.',
    strengths: ['Named a concrete approach.'],
    improvements: ['State complexity.'],
    competencies: technical.map((name) => ({
      name,
      applicable: true,
      score: 70,
      feedback: 'Shown in the transcript.',
      evidence: 'Described an approach.',
    })),
  }), technical);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const merged = mergeCodingCompetency(parsed.evaluation.competencies, codingCompetencyFromSessionRow(null));
  assert.equal(merged.some((item) => item.competency === CODING_COMPETENCY), false);
  assert.equal(merged.length, technical.length);
});

test('eight rubric competencies plus one Coding score fit the apply limit of nine', () => {
  const eight = Array.from({ length: 8 }, (_, index) => ({
    competency: `Competency ${index + 1}`,
    score: 60 + index,
    feedback: `Feedback ${index + 1}`,
    evidence: `Evidence ${index + 1}`,
  }));
  const withModelCoding = [
    ...eight,
    { competency: 'Coding', score: 99, feedback: 'AI guess', evidence: 'Talked about code' },
  ];
  const coding = codingCompetencyFromSessionRow({
    language: 'javascript',
    code: 'return 42',
    passed_count: 2,
    total_count: 2,
    all_passed: true,
  });
  assert.ok(coding);
  const merged = mergeCodingCompetency(withModelCoding, coding);
  assert.equal(merged.length, 9);
  assert.ok(merged.length <= MAX_EVALUATION_SCORES);
  assert.equal(merged.filter((item) => item.competency === CODING_COMPETENCY).length, 1);
  assert.equal(merged[8]?.competency, CODING_COMPETENCY);
  assert.equal(merged[8]?.score, 100);
  assert.equal(merged.some((item) => item.feedback === 'AI guess'), false);
  assert.equal(
    aggregateOverallScore(merged.map((item) => item.score)),
    Math.round(((60 + 61 + 62 + 63 + 64 + 65 + 66 + 67 + 100) / 9) * 100) / 100
  );
});
