/** Keep in sync with supabase/functions/_shared/interview-turn-policy.ts. */

export const INTERVIEW_LOW_TIME_MS = 2 * 60 * 1000;

export function positiveDurationMinutes(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** Session end instant from the stored start time and template duration. */
export function interviewEndsAtMs(startedAt: string, durationMinutes: number): number | null {
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  return started + durationMinutes * 60_000;
}

export function interviewRemainingMs(
  startedAt: string,
  durationMinutes: number,
  nowMs: number
): number | null {
  const endsAt = interviewEndsAtMs(startedAt, durationMinutes);
  if (endsAt === null || !Number.isFinite(nowMs)) return null;
  return Math.max(0, endsAt - nowMs);
}

/** The page may ask the database to close the session only when its own clock already shows zero. */
export function shouldAutoFinishSession(
  status: string | null | undefined,
  remainingMs: number | null
): boolean {
  return status === 'in_progress' && remainingMs === 0;
}

/** Elapsed time between the stored start and ended_at, floored to the second. */
export function formatInterviewSpent(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  if (hours > 0) return `${hours}:${clock}`;
  return clock;
}

/** True when the stored end is the allotted end, within a two-second reading tolerance. */
export function interviewEndedBecauseTime(
  startedAt: string,
  durationMinutes: number,
  endedAt: string | null
): boolean {
  if (!endedAt) return false;
  const endsAt = interviewEndsAtMs(startedAt, durationMinutes);
  const ended = Date.parse(endedAt);
  if (endsAt === null || !Number.isFinite(ended)) return false;
  return ended >= endsAt - 2000;
}

export function formatInterviewClock(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  if (hours > 0) return `${hours}:${clock}`;
  return clock;
}
