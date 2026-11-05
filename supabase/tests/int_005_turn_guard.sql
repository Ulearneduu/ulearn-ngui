-- INT-005 database checks. NOT EXECUTED.
-- Do not run this script against the shared project.
-- The Node tests cover the same decisions in memory and check that the
-- migration text contains these rules. They do not prove Postgres enforces them.

-- After 20261027_interview_turn_security.sql is applied on a disposable
-- database, inside one transaction that ends in ROLLBACK:
--
-- 1. As the session owner, INSERT a user turn into an in_progress session
--    whose duration has not elapsed. Expect success.
-- 2. INSERT role = assistant as that student. Expect denial.
-- 3. UPDATE or DELETE a saved turn as that student. Expect denial.
-- 4. INSERT another user turn with the same (session_id, client_turn_id).
--    Expect unique_violation on interview_turns_session_client_turn.
-- 5. INSERT two turns with the same (session_id, seq).
--    Expect unique_violation on the sequence constraint.
-- 6. Set the session status to completed, then INSERT. Expect 42501
--    "interview turns cannot be added to a finished session".
-- 7. Set status back to in_progress and move started_at so the duration has
--    elapsed, then INSERT. Expect 42501
--    "interview turns cannot be added after the session duration".
-- 8. As a second student, INSERT into the first student's session.
--    Expect 42501 "interview turn is not allowed".
-- 9. As service_role, INSERT a user row and an assistant row in one statement
--    for an open owned session. Expect success. Repeat after the session is
--    completed and expect 42501.
-- 10. Confirm the trigger does not select or return system_prompt.
-- 11. Confirm "Users read turns in own sessions" still exists and the old
--     insert, update, and delete policies do not.

BEGIN;
-- Intentionally empty. The checks above need fixture users and would take
-- locks on the shared database even if this transaction rolls back.
ROLLBACK;
