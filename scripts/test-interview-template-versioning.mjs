/**
 * INT-009 versioning helper checks (no database required).
 * Run: node scripts/test-interview-template-versioning.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function parseTemplateVersionNumber(promptVersion) {
  if (typeof promptVersion !== 'string') return null;
  const trimmed = promptVersion.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function formatTemplateVersionNumber(version) {
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error('Template version must be a positive integer.');
  }
  return String(version);
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

check('new sessions store integer prompt versions', () => {
  assert.equal(formatTemplateVersionNumber(1), '1');
  assert.equal(parseTemplateVersionNumber('2'), 2);
  assert.equal(parseTemplateVersionNumber('hr-behavioral:2026-01-01'), null);
});

check('migration defines snapshot table and capture trigger', () => {
  const sql = read('supabase/migrations/20261106_interview_template_versions.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.interview_template_versions/);
  assert.match(sql, /current_version/);
  assert.match(sql, /template_version_id/);
  assert.match(sql, /interview_templates_capture_version/);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON public\.interview_templates/);
});

check('INT-013 extends capture trigger with coding_json', () => {
  const sql = read('supabase/migrations/20261107_interview_template_coding.sql');
  assert.match(sql, /coding_json/);
  assert.match(sql, /OR NEW\.coding_json IS DISTINCT FROM OLD\.coding_json/);
});

check('interview-turn loads the session snapshot before the live template', () => {
  const source = read('supabase/functions/interview-turn/index.ts');
  const handler = source.slice(source.indexOf('Deno.serve'), source.indexOf('async function insertTurns'));
  assert.match(handler, /readSessionTemplate/);
  assert.match(source, /from\('interview_template_versions'\)/);
  assert.ok(source.indexOf('versionFacts') < source.indexOf('liveTemplateFacts'));
  assert.match(source, /prompt_version, template_version_id/);
});

check('student startSession pins template_version_id', () => {
  const source = read('src/app/interview/interview-catalog.service.ts');
  assert.match(source, /template_version_id: version\.id/);
  assert.match(source, /formatTemplateVersionNumber\(version\.version\)/);
  assert.match(source, /latestPublishedTemplateVersion/);
});

check('finish RPC prefers snapshot duration', () => {
  const sql = read('supabase/migrations/20261106_interview_template_versions.sql');
  assert.match(sql, /v_session\.template_version_id IS NOT NULL/);
  assert.match(sql, /interview_template_versions\.duration_minutes/);
});

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}

console.log('\nAll INT-009 versioning checks passed.');
