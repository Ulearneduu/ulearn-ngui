import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('the edge function authorizes before it calls the provider or inserts turns', () => {
  const source = read('supabase/functions/interview-turn/index.ts');
  const handler = source.slice(source.indexOf('Deno.serve'), source.indexOf('async function insertTurns'));
  const replyAt = handler.indexOf('requestInterviewReply');
  const saveAt = handler.indexOf('insertTurns(');
  assert.ok(replyAt > 0);
  assert.ok(saveAt > replyAt);
  assert.equal(handler.includes('.insert('), false);
  assert.match(handler, /has_permission/);
  assert.match(handler, /interview\.access/);
  assert.match(handler, /session\.userId !== userId/);
  assert.ok(handler.indexOf('findSavedAnswer') < replyAt);
  assert.ok(handler.indexOf('finishIfExpired') < handler.indexOf('replayResponse'));
  assert.ok(handler.indexOf('finishIfExpired') < replyAt);
  assert.ok(handler.indexOf('SESSION_EXPIRED') < replyAt);
  assert.equal(handler.includes('completeExpired'), false);
  assert.match(source, /rpc\('finish_own_interview_session'/);
  const finishSql = read('supabase/migrations/20261031_interview_session_finish.sql');
  assert.match(finishSql, /security invoker/);
  assert.match(finishSql, /for update/);
  assert.match(finishSql, /auth\.uid\(\)/);
  assert.match(finishSql, /p_mode = 'manual'/);
  assert.match(finishSql, /ended_at = v_now/);
  assert.match(finishSql, /p_mode = 'expired' and v_ends <= v_now/);
  assert.match(finishSql, /ended_at = v_ends/);
  assert.match(finishSql, /status = 'in_progress'/);
  assert.match(finishSql, /grant execute on function public\.finish_own_interview_session\(uuid, text\) to authenticated/);
  assert.equal(finishSql.includes('system_prompt'), false);
  assert.equal(source.includes('planTurn'), false);
  assert.match(source, /client_turn_id/);
  assert.equal(/AIza[0-9A-Za-z_-]{10,}/.test(source), false);
  assert.equal(/sk-[A-Za-z0-9]{10,}/.test(source), false);
  assert.equal(source.includes('GEMINI_API_KEY'), false);
  assert.equal(source.includes('generativelanguage'), false);
  assert.match(source, /Deno\.env\.get\('OPENAI_API_KEY'\)/);
  assert.match(source, /gpt-6-luna/);
  assert.match(handler, /serviceDb\(\)/);
  assert.match(handler, /readSessionTemplate/);
  assert.match(handler, /template_version_id/);
  assert.match(source, /interview_template_versions/);
  assert.match(source, /parseTemplateVersionNumber/);
  assert.match(source, /versionFacts/);
  assert.match(source, /liveTemplateFacts/);
  assert.equal(source.includes('async function readTemplate('), false);
  const versionSql = read('supabase/migrations/20261106_interview_template_versions.sql');
  assert.match(versionSql, /CREATE TABLE IF NOT EXISTS public\.interview_template_versions/);
  assert.match(versionSql, /interview_templates_capture_version/);
  assert.match(versionSql, /template_version_id/);
  assert.match(versionSql, /finish_own_interview_session/);
  const sql = read('supabase/migrations/20261027_interview_turn_security.sql');
  assert.match(sql, /client_turn_id uuid/);
  assert.match(sql, /interview_turns_session_client_turn/);
  assert.match(sql, /Users insert own user turns in open sessions/);
  assert.match(sql, /DROP POLICY IF EXISTS "Users update turns in own sessions"/);
  assert.match(sql, /DROP POLICY IF EXISTS "Users delete turns in own sessions"/);
  assert.match(sql, /DROP POLICY IF EXISTS "Users insert turns in own sessions"/);
  assert.equal(sql.includes('CREATE POLICY "Users update'), false);
  assert.equal(sql.includes('CREATE POLICY "Users delete'), false);
});

test('an AI failure marks the session failed before any turn is inserted', () => {
  const source = read('supabase/functions/interview-turn/index.ts');
  const handler = source.slice(source.indexOf('Deno.serve'), source.indexOf('async function insertTurns'));
  const calls = handler.match(/markSessionFailed\(/g) ?? [];
  assert.equal(calls.length, 2);
  assert.ok(handler.lastIndexOf('markSessionFailed(') < handler.indexOf('insertTurns('));
  assert.ok(handler.indexOf("code: 'AI_NOT_CONFIGURED'") > handler.indexOf('markSessionFailed('));
  const unsuccessful = handler.slice(handler.indexOf('if (!reply.ok)'), handler.indexOf('noteAssistantText'));
  assert.match(unsuccessful, /markSessionFailed\(/);
  assert.equal(unsuccessful.includes('insertTurns('), false);
  const failSession = source.slice(source.indexOf('async function markSessionFailed'));
  assert.match(failSession, /status: 'failed'/);
  assert.match(failSession, /ended_at: new Date\(\)\.toISOString\(\)/);
  assert.match(failSession, /\.eq\('status', 'in_progress'\)/);
  assert.equal(source.includes(".from('interview_turns').delete"), false);
  assert.equal(/from\('interview_turns'\)[\s\S]{0,40}\.delete\(/.test(source), false);
});

test('Angular interview code does not select prompts or privileged keys', () => {
  const files = [
    'src/app/interview/interview-catalog.service.ts',
    'src/app/interview/interview-session.ts',
    'src/app/interview/interview-voice.ts',
    'src/app/interview/interview-api.ts',
    'src/app/interview/interview.ts',
  ];
  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes('system_prompt'), false, file);
    assert.equal(source.includes('SUPABASE_SERVICE_ROLE'), false, file);
    assert.equal(source.includes('GEMINI_API_KEY'), false, file);
    assert.equal(source.includes('OPENAI_API_KEY'), false, file);
  }
});
