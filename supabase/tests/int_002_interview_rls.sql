-- INT-002 RLS checks for the interview schema.
--
-- Run this only on the approved development database, after
-- supabase/migrations/20261024_interview_core.sql has been applied.
-- The script inserts probe rows, records pass/fail/pending, prints them,
-- and rolls the probe rows back. It does not create auth users.
--
-- Local fixtures, when present, are profiles with these emails:
--   int002-student-a@example.test      USER + allowed_interview
--   int002-student-b@example.test      USER with no interview label
--   int002-admin@example.test          role ADMIN
--   int002-label-admin@example.test    USER + main_admin label
--   int002-mentor@example.test         USER + mentor + allowed_interview
--
-- If those fixtures are absent, the script uses existing profiles.
-- Cases that need a specific label are marked pending rather than skipped
-- silently. This file does not claim success by itself; read the result rows.

DO $$
BEGIN
  IF to_regclass('public.interview_templates') IS NULL
     OR to_regclass('public.interview_sessions') IS NULL
     OR to_regclass('public.interview_turns') IS NULL
     OR to_regclass('public.interview_scores') IS NULL
     OR to_regprocedure('public.can_manage_interview_templates()') IS NULL THEN
    RAISE EXCEPTION 'INT-002 migration is not applied';
  END IF;
END $$;

BEGIN;

CREATE TEMP TABLE int002_actor (
    key text PRIMARY KEY,
    user_id uuid NOT NULL
);

CREATE TEMP TABLE int002_results (
    id serial PRIMARY KEY,
    name text NOT NULL,
    status text NOT NULL,
    detail text NOT NULL DEFAULT ''
);

INSERT INTO int002_actor (key, user_id)
SELECT 'student_a', p.id
FROM public.profiles AS p
WHERE lower(p.email) = 'int002-student-a@example.test'
LIMIT 1;

INSERT INTO int002_actor (key, user_id)
SELECT 'student_b', p.id
FROM public.profiles AS p
WHERE lower(p.email) = 'int002-student-b@example.test'
LIMIT 1;

INSERT INTO int002_actor (key, user_id)
SELECT 'admin', p.id
FROM public.profiles AS p
WHERE lower(p.email) = 'int002-admin@example.test'
LIMIT 1;

INSERT INTO int002_actor (key, user_id)
SELECT 'label_admin', p.id
FROM public.profiles AS p
WHERE lower(p.email) = 'int002-label-admin@example.test'
LIMIT 1;

INSERT INTO int002_actor (key, user_id)
SELECT 'mentor', p.id
FROM public.profiles AS p
WHERE lower(p.email) = 'int002-mentor@example.test'
LIMIT 1;

INSERT INTO int002_actor (key, user_id)
SELECT 'interview_student', p.id
FROM public.profiles AS p
JOIN public.staff_label_members AS m ON m.user_id = p.id
JOIN public.staff_labels AS l ON l.id = m.label_id
WHERE l.slug = 'allowed_interview'
  AND p.role IS DISTINCT FROM 'ADMIN'
  AND NOT EXISTS (
      SELECT 1
      FROM public.staff_label_members AS m2
      JOIN public.staff_labels AS l2 ON l2.id = m2.label_id
      WHERE m2.user_id = p.id
        AND l2.slug IN ('main_admin', 'admin')
  )
  AND NOT EXISTS (
      SELECT 1 FROM int002_actor AS existing WHERE existing.user_id = p.id AND existing.key = 'mentor'
  )
ORDER BY p.id
LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO int002_actor (key, user_id)
SELECT 'student_a', p.id
FROM public.profiles AS p
WHERE p.role = 'USER'
  AND NOT EXISTS (SELECT 1 FROM int002_actor WHERE key = 'student_a')
ORDER BY p.id
LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO int002_actor (key, user_id)
SELECT 'student_b', p.id
FROM public.profiles AS p
WHERE p.role = 'USER'
  AND NOT EXISTS (SELECT 1 FROM int002_actor WHERE key = 'student_b')
  AND NOT EXISTS (SELECT 1 FROM int002_actor AS a WHERE a.user_id = p.id)
ORDER BY p.id
LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO int002_actor (key, user_id)
SELECT 'admin', p.id
FROM public.profiles AS p
WHERE p.role = 'ADMIN'
  AND NOT EXISTS (SELECT 1 FROM int002_actor WHERE key = 'admin')
ORDER BY p.id
LIMIT 1
ON CONFLICT DO NOTHING;

DO $tests$
#variable_conflict use_variable
DECLARE
    student_a uuid;
    student_b uuid;
    admin_id uuid;
    label_admin uuid;
    mentor_id uuid;
    interview_student uuid;
    template_id uuid;
    session_id uuid;
    turn_id uuid;
    draft_id uuid;
    v_count integer;
    v_flag boolean;
    v_access boolean;
    v_manage boolean;
BEGIN
    SELECT user_id INTO student_a FROM int002_actor WHERE key = 'student_a';
    SELECT user_id INTO student_b FROM int002_actor WHERE key = 'student_b';
    SELECT user_id INTO admin_id FROM int002_actor WHERE key = 'admin';
    SELECT user_id INTO label_admin FROM int002_actor WHERE key = 'label_admin';
    SELECT user_id INTO mentor_id FROM int002_actor WHERE key = 'mentor';
    SELECT user_id INTO interview_student FROM int002_actor WHERE key = 'interview_student';

    SELECT id INTO template_id
    FROM public.interview_templates
    WHERE slug = 'hr-behavioral' AND status = 'published';

    IF template_id IS NULL THEN
        INSERT INTO int002_results (name, status, detail)
        VALUES ('seed templates', 'fail', 'hr-behavioral is not published');
    ELSE
        INSERT INTO int002_results (name, status, detail)
        VALUES ('seed templates', 'pass', 'hr-behavioral published');
    END IF;

    IF student_a IS NULL OR student_b IS NULL THEN
        INSERT INTO int002_results (name, status, detail)
        VALUES (
            'fixtures',
            'pending',
            'Need two distinct USER profiles before session isolation can be tested'
        );
    END IF;

    -- 1. Published templates are readable by an authenticated student.
    IF student_a IS NULL THEN
        INSERT INTO int002_results (name, status, detail)
        VALUES ('1 published templates readable', 'pending', 'no student_a');
    ELSE
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object(
                    'sub', student_a,
                    'role', 'authenticated',
                    'user_metadata', json_build_object()
                )::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            SELECT count(*) INTO v_count
            FROM public.interview_templates
            WHERE slug IN ('hr-behavioral', 'sde-technical')
              AND status = 'published';
            EXECUTE 'RESET ROLE';
            IF v_count = 2 THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('1 published templates readable', 'pass', 'both slugs visible');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('1 published templates readable', 'fail', 'visible=' || v_count);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('1 published templates readable', 'fail', SQLERRM);
        END;
    END IF;

    -- 2. Draft templates are not readable by students.
    IF admin_id IS NULL OR student_a IS NULL THEN
        INSERT INTO int002_results (name, status, detail)
        VALUES ('2 draft hidden from student', 'pending', 'need an ADMIN profile and a student');
    ELSE
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object(
                    'sub', admin_id,
                    'role', 'authenticated',
                    'user_metadata', json_build_object('role', 'ADMIN')
                )::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            INSERT INTO public.interview_templates (slug, title, kind, duration_minutes, status, system_prompt)
            VALUES ('int002-draft-probe', 'INT-002 draft probe', 'domain', 10, 'draft', 'probe')
            RETURNING id INTO draft_id;
            EXECUTE 'RESET ROLE';

            PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object(
                    'sub', student_a,
                    'role', 'authenticated',
                    'user_metadata', json_build_object()
                )::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            SELECT count(*) INTO v_count
            FROM public.interview_templates
            WHERE id = draft_id OR status = 'draft';
            EXECUTE 'RESET ROLE';
            IF v_count = 0 THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('2 draft hidden from student', 'pass', 'draft count 0');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('2 draft hidden from student', 'fail', 'visible drafts=' || v_count);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('2 draft hidden from student', 'fail', SQLERRM);
        END;
    END IF;

    IF student_a IS NULL OR student_b IS NULL OR template_id IS NULL THEN
        INSERT INTO int002_results (name, status, detail)
        VALUES ('3-7 session isolation', 'pending', 'need two students and the HR template');
    ELSE
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_a, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            INSERT INTO public.interview_sessions (user_id, template_id, prompt_version)
            VALUES (student_a, template_id, 'int002-test')
            RETURNING id INTO session_id;
            INSERT INTO public.interview_turns (session_id, role, content, seq)
            VALUES (session_id, 'user', 'student A answer', 1)
            RETURNING id INTO turn_id;
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('own session and turn insert', 'pass', session_id::text);
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('own session and turn insert', 'fail', SQLERRM);
        END;

        -- 3. Student B cannot read student A's session.
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_b::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_b, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            SELECT count(*) INTO v_count
            FROM public.interview_sessions
            WHERE id = session_id;
            EXECUTE 'RESET ROLE';
            IF session_id IS NOT NULL AND v_count = 0 THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('3 student B cannot read student A session', 'pass', '');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('3 student B cannot read student A session', 'fail', 'visible=' || COALESCE(v_count, -1));
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('3 student B cannot read student A session', 'fail', SQLERRM);
        END;

        -- 4. Student B cannot update or delete student A's session.
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_b::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_b, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            UPDATE public.interview_sessions
            SET status = 'failed', ended_at = started_at
            WHERE id = session_id;
            GET DIAGNOSTICS v_count = ROW_COUNT;
            DELETE FROM public.interview_sessions WHERE id = session_id;
            IF v_count <> 0 THEN
                RAISE EXCEPTION 'update touched % rows', v_count;
            END IF;
            GET DIAGNOSTICS v_count = ROW_COUNT;
            EXECUTE 'RESET ROLE';
            IF v_count = 0 THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('4 student B cannot update or delete session', 'pass', '');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('4 student B cannot update or delete session', 'fail', 'delete touched ' || v_count);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('4 student B cannot update or delete session', 'fail', SQLERRM);
        END;

        -- 5. Student B cannot insert a turn or a score into student A's session.
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_b::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_b, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            INSERT INTO public.interview_turns (session_id, role, content, seq)
            VALUES (session_id, 'user', 'intrusion', 2);
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('5 student B cannot insert turn', 'fail', 'insert succeeded');
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('5 student B cannot insert turn', 'pass', SQLERRM);
        END;

        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_b::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_b, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            INSERT INTO public.interview_scores (session_id, competency, score, rationale, eval_version)
            VALUES (session_id, 'communication', 10, 'nope', 'v1');
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('5 student B cannot insert score', 'fail', 'insert succeeded');
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('5 student B cannot insert score', 'pass', SQLERRM);
        END;

        -- 6. Student B cannot read, update, or delete student A's turn.
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_b::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_b, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            SELECT count(*) INTO v_count FROM public.interview_turns WHERE id = turn_id;
            UPDATE public.interview_turns SET content = 'changed' WHERE id = turn_id;
            IF v_count <> 0 THEN
                RAISE EXCEPTION 'turn visible';
            END IF;
            GET DIAGNOSTICS v_count = ROW_COUNT;
            IF v_count <> 0 THEN
                RAISE EXCEPTION 'turn updated';
            END IF;
            DELETE FROM public.interview_turns WHERE id = turn_id;
            GET DIAGNOSTICS v_count = ROW_COUNT;
            EXECUTE 'RESET ROLE';
            IF v_count = 0 THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('6 student B cannot read update or delete turn', 'pass', '');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('6 student B cannot read update or delete turn', 'fail', 'delete touched ' || v_count);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('6 student B cannot read update or delete turn', 'fail', SQLERRM);
        END;

        -- 7. Student A cannot change ownership or write overall_score.
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_a, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            UPDATE public.interview_sessions
            SET user_id = student_b
            WHERE id = session_id;
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('7 ownership change blocked', 'fail', 'update succeeded');
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('7 ownership change blocked', 'pass', SQLERRM);
        END;

        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_a, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            UPDATE public.interview_sessions
            SET overall_score = 99
            WHERE id = session_id;
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('7 student cannot write overall_score', 'fail', 'update succeeded');
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('7 student cannot write overall_score', 'pass', SQLERRM);
        END;

        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_a, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            INSERT INTO public.interview_scores (session_id, competency, score, rationale, eval_version)
            VALUES (session_id, 'communication', 80, 'self score', 'v1');
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('7 student cannot insert own score', 'fail', 'insert succeeded');
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('7 student cannot insert own score', 'pass', SQLERRM);
        END;

        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_a, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            UPDATE public.interview_sessions
            SET status = 'completed', ended_at = started_at
            WHERE id = session_id;
            GET DIAGNOSTICS v_count = ROW_COUNT;
            BEGIN
                UPDATE public.interview_sessions
                SET status = 'in_progress'
                WHERE id = session_id;
                RAISE EXCEPTION 'reopen succeeded';
            EXCEPTION
                WHEN check_violation OR raise_exception THEN
                    IF SQLERRM = 'reopen succeeded' THEN
                        RAISE;
                    END IF;
            END;
            EXECUTE 'RESET ROLE';
            IF v_count = 1 THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('session can be completed and not reopened', 'pass', '');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('session can be completed and not reopened', 'fail', 'complete touched ' || v_count);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('session can be completed and not reopened', 'fail', SQLERRM);
        END;
    END IF;

    -- Evaluator write, then owner read / other student denied.
    IF session_id IS NOT NULL THEN
        BEGIN
            EXECUTE 'SET LOCAL ROLE service_role';
            INSERT INTO public.interview_scores (session_id, competency, score, rationale, eval_version)
            VALUES (session_id, 'communication', 88, 'clear structure', 'v1');
            UPDATE public.interview_sessions
            SET overall_score = 88
            WHERE id = session_id;
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('evaluator can write score', 'pass', '');
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('evaluator can write score', 'fail', SQLERRM);
        END;

        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_a, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            SELECT count(*) INTO v_count
            FROM public.interview_scores
            WHERE interview_scores.session_id = session_id;
            EXECUTE 'RESET ROLE';
            IF v_count = 1 THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('student A can read own score', 'pass', '');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('student A can read own score', 'fail', 'visible=' || v_count);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('student A can read own score', 'fail', SQLERRM);
        END;

        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_a, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            UPDATE public.interview_turns
            SET session_id = gen_random_uuid()
            WHERE id = turn_id;
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('turn cannot move to another session', 'fail', 'update succeeded');
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            IF SQLERRM LIKE '%interview turn session cannot be changed%' THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('turn cannot move to another session', 'pass', SQLERRM);
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('turn cannot move to another session', 'fail', SQLERRM);
            END IF;
        END;

        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_b::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_b, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            SELECT count(*) INTO v_count
            FROM public.interview_scores
            WHERE interview_scores.session_id = session_id;
            IF v_count <> 0 THEN
                RAISE EXCEPTION 'score visible to student B';
            END IF;
            BEGIN
                UPDATE public.interview_scores SET score = 1 WHERE interview_scores.session_id = session_id;
                GET DIAGNOSTICS v_count = ROW_COUNT;
                IF v_count <> 0 THEN
                    RAISE EXCEPTION 'score updated by student B';
                END IF;
            EXCEPTION WHEN insufficient_privilege THEN
                NULL;
            END;
            BEGIN
                DELETE FROM public.interview_scores WHERE interview_scores.session_id = session_id;
                GET DIAGNOSTICS v_count = ROW_COUNT;
                IF v_count <> 0 THEN
                    RAISE EXCEPTION 'score deleted by student B';
                END IF;
            EXCEPTION WHEN insufficient_privilege THEN
                NULL;
            END;
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('6 student B cannot read update or delete score', 'pass', '');
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('6 student B cannot read update or delete score', 'fail', SQLERRM);
        END;

        BEGIN
            PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', student_a, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            DELETE FROM public.interview_sessions WHERE id = session_id;
            GET DIAGNOSTICS v_count = ROW_COUNT;
            EXECUTE 'RESET ROLE';
            IF v_count = 1 THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('owner can delete session with scores', 'pass', '');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('owner can delete session with scores', 'fail', 'delete touched ' || v_count);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('owner can delete session with scores', 'fail', SQLERRM);
        END;
    END IF;

    -- 8. Authorized administrators can manage templates.
    IF admin_id IS NULL THEN
        INSERT INTO int002_results (name, status, detail)
        VALUES ('8 administrator can manage templates', 'pending', 'no ADMIN profile');
    ELSIF draft_id IS NULL THEN
        INSERT INTO int002_results (name, status, detail)
        VALUES ('8 administrator can manage templates', 'pending', 'draft probe was not created');
    ELSE
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object(
                    'sub', admin_id,
                    'role', 'authenticated',
                    'user_metadata', json_build_object('role', 'ADMIN')
                )::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            UPDATE public.interview_templates
            SET title = 'INT-002 draft probe updated'
            WHERE id = draft_id;
            GET DIAGNOSTICS v_count = ROW_COUNT;
            IF v_count <> 1 THEN
                RAISE EXCEPTION 'admin update touched %', v_count;
            END IF;
            DELETE FROM public.interview_templates WHERE id = draft_id;
            GET DIAGNOSTICS v_count = ROW_COUNT;
            EXECUTE 'RESET ROLE';
            IF v_count = 1 THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('8 administrator can manage templates', 'pass', '');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('8 administrator can manage templates', 'fail', 'delete touched ' || v_count);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('8 administrator can manage templates', 'fail', SQLERRM);
        END;
    END IF;

    IF label_admin IS NULL THEN
        INSERT INTO int002_results (name, status, detail)
        VALUES ('8b main_admin label can manage templates', 'pending', 'no main_admin fixture');
    ELSE
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', label_admin::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', label_admin, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            SELECT public.can_manage_interview_templates() INTO v_manage;
            INSERT INTO public.interview_templates (slug, title, kind, duration_minutes, status, system_prompt)
            VALUES ('int002-label-admin-probe', 'Label admin probe', 'hr', 15, 'draft', 'probe');
            DELETE FROM public.interview_templates WHERE slug = 'int002-label-admin-probe';
            EXECUTE 'RESET ROLE';
            IF v_manage THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('8b main_admin label can manage templates', 'pass', '');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES ('8b main_admin label can manage templates', 'fail', 'can_manage returned false');
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('8b main_admin label can manage templates', 'fail', SQLERRM);
        END;
    END IF;

    -- 9. interview.access alone does not grant template administration.
    IF interview_student IS NULL THEN
        INSERT INTO int002_results (name, status, detail)
        VALUES (
            '9 interview.access cannot manage templates',
            'pending',
            'no USER who has allowed_interview and is not main_admin/admin'
        );
    ELSE
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', interview_student::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', interview_student, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            SELECT public.has_permission('interview.access') INTO v_access;
            SELECT public.can_manage_interview_templates() INTO v_manage;
            SELECT public.is_admin() INTO v_flag;
            BEGIN
                INSERT INTO public.interview_templates (slug, title, kind, duration_minutes, status, system_prompt)
                VALUES ('int002-student-probe', 'Student probe', 'hr', 15, 'draft', 'probe');
                RAISE EXCEPTION 'insert succeeded';
            EXCEPTION
                WHEN insufficient_privilege THEN
                    NULL;
            END;
            EXECUTE 'RESET ROLE';
            IF v_access IS TRUE AND v_manage IS FALSE AND v_flag IS FALSE THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('9 interview.access cannot manage templates', 'pass', 'insert denied');
            ELSIF v_access IS NOT TRUE THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('9 interview.access cannot manage templates', 'pending', 'user does not have interview.access');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES (
                    '9 interview.access cannot manage templates',
                    'fail',
                    'access=' || COALESCE(v_access::text, 'null')
                        || ' manage=' || COALESCE(v_manage::text, 'null')
                        || ' is_admin=' || COALESCE(v_flag::text, 'null')
                );
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('9 interview.access cannot manage templates', 'fail', SQLERRM);
        END;
    END IF;

    IF mentor_id IS NULL THEN
        INSERT INTO int002_results (name, status, detail)
        VALUES (
            '9b mentor with interview.access cannot manage templates',
            'pending',
            'no mentor fixture'
        );
    ELSE
        BEGIN
            PERFORM set_config('request.jwt.claim.sub', mentor_id::text, true);
            PERFORM set_config(
                'request.jwt.claims',
                json_build_object('sub', mentor_id, 'role', 'authenticated', 'user_metadata', json_build_object())::text,
                true
            );
            EXECUTE 'SET LOCAL ROLE authenticated';
            SELECT public.is_admin() INTO v_flag;
            SELECT public.has_permission('interview.access') INTO v_access;
            SELECT public.can_manage_interview_templates() INTO v_manage;
            BEGIN
                INSERT INTO public.interview_templates (slug, title, kind, duration_minutes, status, system_prompt)
                VALUES ('int002-mentor-probe', 'Mentor probe', 'technical', 15, 'draft', 'probe');
                RAISE EXCEPTION 'insert succeeded';
            EXCEPTION
                WHEN insufficient_privilege THEN
                    NULL;
            END;
            EXECUTE 'RESET ROLE';
            IF v_flag IS TRUE AND v_access IS TRUE AND v_manage IS FALSE THEN
                INSERT INTO int002_results (name, status, detail)
                VALUES ('9b mentor with interview.access cannot manage templates', 'pass', 'insert denied');
            ELSE
                INSERT INTO int002_results (name, status, detail)
                VALUES (
                    '9b mentor with interview.access cannot manage templates',
                    'fail',
                    'is_admin=' || COALESCE(v_flag::text, 'null')
                        || ' access=' || COALESCE(v_access::text, 'null')
                        || ' manage=' || COALESCE(v_manage::text, 'null')
                );
            END IF;
        EXCEPTION WHEN OTHERS THEN
            EXECUTE 'RESET ROLE';
            INSERT INTO int002_results (name, status, detail)
            VALUES ('9b mentor with interview.access cannot manage templates', 'fail', SQLERRM);
        END;
    END IF;
END $tests$;

SELECT status, name, detail
FROM int002_results
ORDER BY id;

ROLLBACK;
