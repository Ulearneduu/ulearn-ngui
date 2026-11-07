import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTemplateVersionNumber,
  parseTemplateVersionNumber,
} from './interview-prompt-version.ts';

test('parseTemplateVersionNumber accepts INT-009 version strings', () => {
  assert.equal(parseTemplateVersionNumber('1'), 1);
  assert.equal(parseTemplateVersionNumber('42'), 42);
  assert.equal(parseTemplateVersionNumber('hr-behavioral:2026-11-05T00:00:00.000Z'), null);
});

test('formatTemplateVersionNumber matches what startSession stores', () => {
  assert.equal(formatTemplateVersionNumber(1), '1');
  assert.equal(formatTemplateVersionNumber(2), '2');
});
