import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const migration = read('supabase/migrations/20261109_interview_score_overrides.sql');
const service = read('src/app/admin/services/admin-interview-reviews.service.ts');
const routes = read('src/app/admin/admin.routes.ts');
const permissions = read('src/app/admin/labels/staff-permissions.ts');
const catalog = read('src/app/interview/interview-catalog.service.ts');
const result = read('src/app/interview/interview-result.ts');

assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.interview_score_overrides/);
assert.match(migration, /mentor_review_published boolean NOT NULL DEFAULT false/);
assert.match(migration, /char_length\(btrim\(reason\)\) >= 10/);
assert.match(migration, /interview score override history cannot be changed/);
assert.match(migration, /interview score override history cannot be deleted/);
assert.match(migration, /ON DELETE CASCADE/);
assert.match(
  migration,
  /EXISTS \(\s*SELECT 1\s*FROM public\.interview_sessions AS s\s*WHERE s\.id = OLD\.session_id/s
);
assert.match(migration, /apply_interview_score_override/);
assert.match(migration, /set_interview_mentor_review_published/);
assert.match(migration, /list_interview_review_queue/);
assert.match(migration, /get_interview_review_detail/);
assert.match(migration, /has_permission\('interview\.reviews'\)/);
assert.match(migration, /mentor_id is always the authenticated reviewer/);
assert.match(migration, /v_session\.id,\s*v_uid,/s);
assert.match(migration, /AI overall score must remain unchanged/);
assert.equal(migration.includes('UPDATE public.interview_scores'), false);
assert.equal(/SET overall_score\s*=/.test(migration), false);
assert.match(migration, /Students read published overrides for own sessions/);
assert.match(migration, /REVOKE UPDATE \(mentor_review_published\)/);

assert.match(service, /list_interview_review_queue/);
assert.match(service, /apply_interview_score_override/);
assert.match(routes, /interview\/reviews/);
assert.match(routes, /interview\.reviews/);
assert.match(permissions, /interview\.reviews/);
assert.match(catalog, /mentor_review_published/);
assert.match(catalog, /interview_score_overrides/);
assert.match(catalog, /effectiveOverallScore/);
assert.match(catalog, /listOwnSessions/);
assert.match(result, /mentorAdjusted/);
assert.match(result, /Mentor-adjusted/);

const history = read('src/app/interview/interview-history.ts');
assert.match(history, /mentorAdjusted/);
assert.match(history, /Mentor-adjusted/);

const helpers = read('src/app/interview/interview-score-overrides.ts');
assert.match(helpers, /overridesForEvalVersion/);

console.log('pass: migration defines append-only overrides and review RPCs');
console.log('pass: cascade DELETE allowed only after parent session is gone');
console.log('pass: admin service/routes use interview.reviews');
console.log('pass: student result/history use published effective scores');
console.log('\nAll INT-015 override source checks passed.');
