/**
 * INT-011 local source checks for redo_of_session_id (no shared DB apply).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const migration = read('supabase/migrations/20261108_interview_session_redo.sql');
assert.match(migration, /ADD COLUMN IF NOT EXISTS redo_of_session_id uuid/);
assert.match(migration, /REFERENCES public\.interview_sessions\(id\)/);
assert.match(migration, /ON DELETE SET NULL/);
assert.match(migration, /interview_sessions_redo_not_self/);
assert.match(migration, /redo_of_session_id IS DISTINCT FROM id/);
assert.match(migration, /idx_interview_sessions_redo_of/);
assert.match(migration, /interview redo parent must belong to the signed-in user/);
assert.match(migration, /interview redo parent must use the same template/);
assert.match(migration, /interview redo parent must be completed/);
assert.match(migration, /interview session redo link cannot be changed/);
assert.match(migration, /template_version_id IS DISTINCT FROM OLD\.template_version_id/);
assert.match(migration, /interview evaluation is written by the evaluator/);
console.log('pass: migration defines redo_of_session_id with ownership and immutability guards');

const catalog = read('src/app/interview/interview-catalog.service.ts');
assert.match(catalog, /async startRedoSession\(/);
assert.match(catalog, /redo_of_session_id: parent\.id/);
assert.match(catalog, /template_version_id/);
assert.match(catalog, /prompt_version: parent\.prompt_version/);
assert.match(catalog, /loadQuota\(/);
assert.equal(catalog.includes('latestPublishedTemplateVersion(parent'), false);
assert.ok(catalog.indexOf('async startRedoSession') > 0);
assert.ok(
  catalog.indexOf('latestPublishedTemplateVersion') < catalog.indexOf('async startRedoSession') ||
    catalog.includes('private async latestPublishedTemplateVersion')
);
// Redo must not call latestPublishedTemplateVersion inside startRedoSession body.
const redoStart = catalog.indexOf('async startRedoSession');
const redoEnd = catalog.indexOf('/** Latest published snapshot', redoStart);
const redoBody = catalog.slice(redoStart, redoEnd > 0 ? redoEnd : redoStart + 2500);
assert.equal(redoBody.includes('latestPublishedTemplateVersion'), false);
assert.match(redoBody, /Only a completed interview can be redone/);
console.log('pass: startRedoSession reuses parent snapshot and respects quota');

const result = read('src/app/interview/interview-result.ts');
assert.match(result, /Redo Interview/);
assert.match(result, /startRedoSession/);
assert.match(result, /compareInterviewEvaluations/);
assert.match(result, /Progress vs previous attempt/);
assert.match(result, /canStartInterviewRedo/);
console.log('pass: result page exposes redo and before/after comparison');

const history = read('src/app/interview/interview-history.ts');
assert.match(history, /redoOfSessionId/);
assert.match(history, /badge redo/);
console.log('pass: history marks redo attempts');

console.log('\nAll INT-011 redo checks passed.');
