-- =============================================================================
-- INT-006 validation helper (NOT an automated test suite)
-- =============================================================================
-- Prerequisites: migrations applied in order on a LOCAL or disposable database:
--   1) 20261027_int006_weekly_mock_quota.sql
--   2) 20261027_int006_weekly_mock_quota_functions.sql
--
-- This file mixes:
--   A) RUNNABLE read-only checks (safe to run anytime)
--   B) MANUAL scenarios (require authenticated JWT / test users; run step-by-step)
--   C) DESTRUCTIVE scenarios (commented out; never run on shared/production DB)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) RUNNABLE — read-only (no data changes)
-- -----------------------------------------------------------------------------

-- A1) Default weekly limit should be 5 when seed row exists
SELECT id, weekly_limit
  FROM public.interview_quota_config
 WHERE id = 1;
-- Expect one row, weekly_limit = 5

-- A2) IST week boundary helper (read-only calculation; adjust timestamp as needed)
SELECT
  date_trunc('week', timestamptz '2026-10-26 18:30:00+00' AT TIME ZONE 'Asia/Kolkata')
    AT TIME ZONE 'Asia/Kolkata' AS sample_week_start_ist,
  date_trunc('week', timestamptz '2026-10-26 18:30:00+00' AT TIME ZONE 'Asia/Kolkata')
    AT TIME ZONE 'Asia/Kolkata' + interval '7 days' AS sample_week_end_ist_exclusive;

-- A3) Resume policy documentation (no execution)
-- Resume is allowed only when status = 'started' AND started_at is in the
-- current IST window [week_start, week_end). See start_interview_with_quota().

-- -----------------------------------------------------------------------------
-- B) MANUAL — requires Supabase SQL editor as a test user JWT or app calls
-- -----------------------------------------------------------------------------

-- B1) Initial quota: call get_interview_quota_status() as student with interview.access
--     Expect weekly_limit = 5, used = 0, remaining = 5, week_starts_at, resets_at.

-- B2) Each new start: SELECT public.start_interview_with_quota();
--     Expect used to increase by 1; session row inserted.

-- B3) Sixth start at limit 5: expect JSON with code = WEEKLY_QUOTA_EXCEEDED (not an exception).

-- B4) Rejected start: compare count(*) from interview_sessions before/after failed start.

-- B5) Two students: repeat B2–B4 under different auth.uid(); counts must be independent.

-- B6) Resume current week: start session, then
--     SELECT public.start_interview_with_quota('<that-session-id>'::uuid);
--     Expect resumed = true, used unchanged.

-- B7) Resume prior IST week (MANUAL negative test):
--     Insert or identify a session with status 'started' and started_at before current week_start,
--     then call start_interview_with_quota(session_id).
--     Expect P0002 / "not resumable" (Edge HTTP 404).

-- B8) Concurrent starts: two parallel interview-start calls at remaining = 1; only one succeeds.

-- B9) No interview.access: RPC raises 42501; Edge returns 403.

-- B10) Student UPDATE on interview_quota_config should fail (no grant / no policy).

-- B11) Admin with interview_quota.manage:
--      SELECT public.set_interview_weekly_quota_limit(7);
--      Verify weekly_limit = 7, then set back with set_interview_weekly_quota_limit(5).

-- B12) Edge error mapping: exercise interview-quota-status / interview-start without JWT (401),
--       without permission (403), and with quota exhausted (429 + WEEKLY_QUOTA_EXCEEDED body).

-- -----------------------------------------------------------------------------
-- C) DESTRUCTIVE — commented out; local disposable DB only; restores noted
-- -----------------------------------------------------------------------------

-- C1) Missing config (fail closed) — deletes global config; MUST restore after test:
-- BEGIN;
-- DELETE FROM public.interview_quota_config WHERE id = 1;
-- -- expect get_interview_quota_status / start to error (22023 / Edge 503)
-- INSERT INTO public.interview_quota_config (id, weekly_limit) VALUES (1, 5);
-- COMMIT;

-- -----------------------------------------------------------------------------
-- Optional: Deno unit tests for Edge RPC error mapping (no database):
--   deno test supabase/functions/_shared/interview-rpc-errors_test.ts
-- -----------------------------------------------------------------------------
