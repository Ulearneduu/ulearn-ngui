/**
 * INT-013 coding helper checks (no database required).
 * Run: node scripts/test-interview-coding.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`pass: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`fail: ${name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

check('migration versions coding_json with templates', () => {
  const sql = read('supabase/migrations/20261107_interview_template_coding.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS coding_json jsonb/);
  assert.match(sql, /OR NEW\.coding_json IS DISTINCT FROM OLD\.coding_json/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.interview_session_coding/);
  assert.match(sql, /problem_snapshot/);
});

check('interview-run-code owns session and uses Judge0', () => {
  const source = read('supabase/functions/interview-run-code/index.ts');
  assert.match(source, /interview_sessions/);
  assert.match(source, /user_id/);
  assert.match(source, /in_progress/);
  assert.match(source, /JUDGE0/);
  assert.match(source, /language_id/);
  assert.match(source, /interview_session_coding/);
  assert.equal(/from\('exam_attempts'\)/.test(source), false);
});

check('admin service persists coding_json', () => {
  const source = read('src/app/admin/services/admin-interview-templates.service.ts');
  assert.match(source, /coding_json/);
  assert.match(source, /toInterviewCodingJson/);
});

check('catalog loads coding from version snapshot', () => {
  const source = read('src/app/interview/interview-catalog.service.ts');
  assert.match(source, /coding_json/);
  assert.match(source, /activeInterviewCodingProblem/);
  assert.match(source, /interview_session_coding/);
  assert.match(source, /interview-run-code/);
});

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}

console.log('\nAll INT-013 coding checks passed.');
