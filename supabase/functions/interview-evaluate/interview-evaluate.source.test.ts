import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('interview-evaluate authorizes and validates before it calls the provider or writes scores', () => {
  const source = read('supabase/functions/interview-evaluate/index.ts');
  const handler = source.slice(source.indexOf('Deno.serve'), source.indexOf('function readAiConfig'));
  const replyAt = handler.indexOf('requestEvaluationReply');
  const applyAt = handler.indexOf('applyEvaluation(');
  assert.ok(replyAt > 0);
  assert.ok(applyAt > replyAt);
  assert.ok(handler.indexOf('auth.getUser') < replyAt);
  assert.ok(handler.indexOf('has_permission') < replyAt);
  assert.ok(handler.indexOf('interview.access') < replyAt);
  assert.ok(handler.indexOf('session.userId !== userId') < replyAt);
  assert.ok(handler.indexOf('planEvaluation') < replyAt);
  assert.ok(handler.indexOf('parseEvaluationPayload') < applyAt);
  assert.equal(handler.includes('record[\'overallScore\']'), false);
  assert.equal(handler.includes('record["score"]'), false);
  assert.match(source, /Deno\.env\.get\('OPENAI_API_KEY'\)/);
  assert.match(source, /gpt-6-luna/);
  assert.match(source, /EVAL_VERSION/);
  assert.equal(source.includes('GEMINI_API_KEY'), false);
  assert.equal(/sk-[A-Za-z0-9]{10,}/.test(source), false);
  assert.equal(handler.includes('system_prompt'), false);
});

test('the evaluation migration keeps student score writes closed and preserves versions', () => {
  const sql = read('supabase/migrations/20261105_interview_evaluation.sql');
  assert.match(sql, /evaluation_status IN \('pending', 'processing', 'completed', 'failed'\)/);
  assert.match(sql, /overall_score is written by the evaluator/);
  assert.match(sql, /interview evaluation is written by the evaluator/);
  assert.match(sql, /interview score history cannot be changed/);
  assert.match(sql, /ON CONFLICT ON CONSTRAINT interview_scores_session_competency_version_unique DO NOTHING/);
  assert.match(sql, /version_preserved/);
  assert.match(sql, /round\(avg\(score\), 2\)/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.interview_scores FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /Users read scores in own sessions/);
  assert.equal(sql.includes('CREATE POLICY "Users insert scores'), false);
  assert.equal(sql.includes('CREATE POLICY "Users update scores'), false);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.apply_interview_evaluation\(uuid, text, text, jsonb, jsonb, jsonb, timestamptz\) TO service_role/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.claim_interview_evaluation\(uuid, text\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /evaluation_status = 'failed'/);
  assert.match(sql, /AND s\.status = 'completed'/);
  assert.equal(sql.includes('DROP POLICY IF EXISTS "Users read turns in own sessions"'), false);
  assert.equal(sql.includes('DROP POLICY IF EXISTS "Users read own interview sessions"'), false);
});

test('Angular evaluation code does not carry provider or service-role secrets', () => {
  const files = [
    'src/app/interview/interview-result.ts',
    'src/app/interview/interview-evaluation.ts',
    'src/app/interview/interview-catalog.service.ts',
    'src/app/interview/interview-session.ts',
  ];
  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes('SUPABASE_SERVICE_ROLE'), false, file);
    assert.equal(source.includes('OPENAI_API_KEY'), false, file);
    assert.equal(source.includes('system_prompt'), false, file);
  }
  const session = read('src/app/interview/interview-session.ts');
  const end = session.indexOf('async confirmEndNow');
  assert.ok(end > 0);
  const body = session.slice(end, session.indexOf('private noteSubmitFailure'));
  assert.ok(body.indexOf('completeOwnSession') < body.indexOf('requestEvaluation'));
  assert.ok(body.indexOf('requestEvaluation') < body.indexOf("'/interview/session'"));
  const result = read('src/app/interview/interview-result.ts');
  assert.match(result, /data\.competencies/);
  assert.match(result, /data\.turns/);
  assert.match(result, /@media \(max-width: 1024px\)/);
  assert.match(result, /@media \(max-width: 720px\)/);
  assert.equal(result.includes('score: 80'), false);
  const routes = read('src/app/app.routes.ts');
  assert.match(routes, /session\/:id\/result/);
});
