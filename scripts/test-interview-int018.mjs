import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const migration = read('supabase/migrations/20261110180000_int018_quota_start_and_rls.sql');
const catalog = read('src/app/interview/interview-catalog.service.ts');
const service = read('src/app/interview/interview.service.ts');
const edge = read('supabase/functions/interview-start/index.ts');

assert.match(migration, /Asia\/Kolkata/);
assert.match(migration, /date_trunc\(\s*'week'/);
assert.match(migration, /has_permission\('interview\.access'\)/);
assert.match(migration, /'in_progress'/);
assert.match(migration, /WEEKLY_QUOTA_EXCEEDED/);
assert.match(migration, /FOR UPDATE/);
assert.match(migration, /WITH CHECK \(\s*auth\.uid\(\) = user_id\s*AND public\.has_permission\('interview\.access'\)\s*AND false\s*\)/s);
assert.equal(migration.includes("status = 'started'"), false);
assert.match(migration, /Interview template version is not current/);

const startBody = catalog.slice(
  catalog.indexOf('async startSession'),
  catalog.indexOf('async startRedoSession')
);
assert.match(startBody, /startInterview\(/);
assert.match(startBody, /templateVersionId: version\.id/);
assert.equal(startBody.includes(".insert("), false);
assert.equal(startBody.includes(".from('interview_sessions')"), false);

const redoBody = catalog.slice(
  catalog.indexOf('async startRedoSession'),
  catalog.indexOf('private async latestPublishedTemplateVersion')
);
assert.match(redoBody, /startInterview\(/);
assert.match(redoBody, /redoOfSessionId: parent\.id/);
assert.equal(redoBody.includes('.insert('), false);

assert.match(service, /template_id/);
assert.match(service, /prompt_version/);
assert.match(service, /redo_of_session_id/);
assert.match(edge, /p_template_id: templateId/);
assert.match(edge, /p_redo_of_session_id: redoOfSessionId/);
assert.equal(edge.includes('p_resume_session_id: resumeSessionId,\n    });'), false);

console.log('All INT-018 quota and RLS source checks passed.');
