import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatInterviewClock,
  formatInterviewSpent,
  interviewEndedBecauseTime,
  interviewEndsAtMs,
  interviewRemainingMs,
  positiveDurationMinutes,
  shouldAutoFinishSession,
} from './interview-timer.ts';
import { interviewEndsAtMs as serverEndsAtMs } from '../../../supabase/functions/_shared/interview-turn-policy.ts';

test('the visible timer uses the same end instant as the server', () => {
  const started = '2026-10-27T08:00:00.000Z';
  assert.equal(interviewEndsAtMs(started, 20), serverEndsAtMs(started, 20));
  assert.equal(interviewRemainingMs(started, 20, Date.parse(started) + 60_000), 19 * 60_000);
  assert.equal(interviewRemainingMs(started, 20, Date.parse(started) + 20 * 60_000), 0);
  assert.equal(interviewRemainingMs('bad', 20, Date.now()), null);
  assert.equal(positiveDurationMinutes('30'), 30);
  assert.equal(formatInterviewClock(61_000), '01:01');
  assert.equal(formatInterviewClock(0), '00:00');
  assert.equal(shouldAutoFinishSession('in_progress', 0), true);
  assert.equal(shouldAutoFinishSession('in_progress', 1), false);
  assert.equal(shouldAutoFinishSession('completed', 0), false);
  assert.equal(formatInterviewSpent(6 * 60_000 + 18_000), '06:18');
  assert.equal(interviewEndedBecauseTime(started, 20, '2026-10-27T08:20:00.000Z'), true);
  assert.equal(interviewEndedBecauseTime(started, 20, '2026-10-27T08:06:18.000Z'), false);
  assert.equal(interviewEndedBecauseTime(started, 20, null), false);
});
