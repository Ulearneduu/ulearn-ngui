import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTemplateVersionNumber,
  parseTemplateVersionNumber,
  pickTemplateFacts,
} from './interview-template-version.ts';

function positiveDurationMinutes(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

test('parseTemplateVersionNumber accepts positive integer strings only', () => {
  assert.equal(parseTemplateVersionNumber('1'), 1);
  assert.equal(parseTemplateVersionNumber('12'), 12);
  assert.equal(parseTemplateVersionNumber(' 3 '), 3);
  assert.equal(parseTemplateVersionNumber('0'), null);
  assert.equal(parseTemplateVersionNumber('-1'), null);
  assert.equal(parseTemplateVersionNumber('1.5'), null);
  assert.equal(parseTemplateVersionNumber('hr-behavioral:2026-01-01T00:00:00.000Z'), null);
  assert.equal(parseTemplateVersionNumber(null), null);
});

test('formatTemplateVersionNumber stores the integer as text for sessions', () => {
  assert.equal(formatTemplateVersionNumber(1), '1');
  assert.equal(formatTemplateVersionNumber(9), '9');
  assert.throws(() => formatTemplateVersionNumber(0));
});

test('pickTemplateFacts requires a prompt and positive duration', () => {
  assert.deepEqual(
    pickTemplateFacts(
      { system_prompt: ' Ask one question. ', duration_minutes: 20 },
      positiveDurationMinutes
    ),
    { systemPrompt: 'Ask one question.', durationMinutes: 20 }
  );
  assert.equal(
    pickTemplateFacts({ system_prompt: '  ', duration_minutes: 20 }, positiveDurationMinutes),
    null
  );
  assert.deepEqual(
    pickTemplateFacts({ system_prompt: 'Ask', duration_minutes: '20' }, positiveDurationMinutes),
    { systemPrompt: 'Ask', durationMinutes: 20 }
  );
});
