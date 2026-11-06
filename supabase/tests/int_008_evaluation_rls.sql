-- INT-008 RLS assertions for a disposable local database.
-- Run as supabase_admin after 20261105_interview_evaluation.sql is applied:
--   psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/int_008_evaluation_rls.sql
-- Do not run this file against the linked project or any shared database.
-- Fixtures are created inside this transaction and removed by ROLLBACK.
-- The reserved production session 61ffb07f-b042-419c-8203-cec5af103d98 is never used.
--
-- PostgREST connects as authenticator and then switches role. This script does
-- the same. Student checks use role authenticated and that student's JWT sub.
-- Service-role checks use role service_role. postgres is not used to stand in
-- for a student.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = current_user
      AND rolsuper
  ) THEN
    RAISE EXCEPTION 'INT-008 RLS test must run as a local superuser (supabase_admin)';
  END IF;

  IF to_regprocedure('public.claim_interview_evaluation(uuid, text)') IS NULL
     OR to_regprocedure('public.apply_interview_evaluation(uuid, text, text, jsonb, jsonb, jsonb, timestamptz)') IS NULL
     OR to_regclass('public.interview_scores') IS NULL THEN
    RAISE EXCEPTION 'INT-008 evaluation migration is not applied';
  END IF;
END $$;

BEGIN;

DO $fixtures$
DECLARE
  student_a uuid := 'a1111111-1111-4111-8111-111111111111';
  student_b uuid := 'b2222222-2222-4222-8222-222222222222';
  session_a uuid := 'd4444444-4444-4444-8444-444444444444';
  session_b uuid := 'c3333333-3333-4333-8333-333333333333';
  reserved uuid := '61ffb07f-b042-419c-8203-cec5af103d98';
  template_id uuid;
BEGIN
  IF student_a = reserved OR student_b = reserved
     OR session_a = reserved OR session_b = reserved THEN
    RAISE EXCEPTION 'refusing reserved production session';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM auth.users
    WHERE id IN (student_a, student_b)
       OR lower(email) IN ('int008-rls-a@example.test', 'int008-rls-b@example.test')
  ) THEN
    RAISE EXCEPTION 'INT-008 RLS fixture identities already exist';
  END IF;

  INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
  )
  VALUES
    (
      '00000000-0000-0000-0000-000000000000',
      student_a,
      'authenticated',
      'authenticated',
      'int008-rls-a@example.test',
      '',
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', 'INT008 RLS A'),
      now(),
      now(),
      '',
      '',
      '',
      ''
    ),
    (
      '00000000-0000-0000-0000-000000000000',
      student_b,
      'authenticated',
      'authenticated',
      'int008-rls-b@example.test',
      '',
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', 'INT008 RLS B'),
      now(),
      now(),
      '',
      '',
      '',
      ''
    );

  SELECT id INTO template_id
  FROM public.interview_templates
  WHERE slug = 'hr-behavioral'
    AND status = 'published';

  IF template_id IS NULL THEN
    RAISE EXCEPTION 'published hr-behavioral template is missing';
  END IF;

  INSERT INTO public.interview_sessions (id, user_id, template_id, status, prompt_version)
  VALUES
    (session_a, student_a, template_id, 'in_progress', 'INT008-rls'),
    (session_b, student_b, template_id, 'in_progress', 'INT008-rls');

  INSERT INTO public.interview_turns (session_id, role, content, seq)
  VALUES
    (session_b, 'assistant', 'Tell me about a time you worked with a team.', 1),
    (session_b, 'user', 'I coordinated a study group and we shipped the project on time.', 2);

  UPDATE public.interview_sessions
  SET status = 'completed',
      ended_at = now()
  WHERE id IN (session_a, session_b);

  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'interview_scores'
      AND grantee = 'authenticated'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'interview_scores'
      AND grantee = 'authenticated'
      AND privilege_type = 'SELECT'
  ) OR NOT has_table_privilege('authenticated', 'public.interview_scores', 'SELECT')
     OR has_table_privilege('authenticated', 'public.interview_scores', 'INSERT')
     OR has_table_privilege('authenticated', 'public.interview_scores', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.interview_scores', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated privileges on interview_scores are not SELECT only';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'interview_scores'
      AND policyname = 'Users read scores in own sessions'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'interview_turns'
      AND policyname = 'Users read turns in own sessions'
  ) THEN
    RAISE EXCEPTION 'owner read policies for turns or scores are missing';
  END IF;

  CREATE TEMP TABLE int008_fixture (
    student_a uuid NOT NULL,
    student_b uuid NOT NULL,
    session_a uuid NOT NULL,
    session_b uuid NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO int008_fixture VALUES (student_a, student_b, session_a, session_b);
  GRANT SELECT ON TABLE int008_fixture TO authenticator, authenticated, service_role;
END $fixtures$;

SET LOCAL SESSION AUTHORIZATION authenticator;

DO $assertions$
DECLARE
  student_a uuid;
  student_b uuid;
  session_a uuid;
  session_b uuid;
  v_count integer;
  v_outcome text;
  v_overall numeric;
  v_version text;
  v_status text;
  v_claimed timestamptz;
  v_score numeric;
  v_summary text;
  scores jsonb := '[
    {"competency":"Communication","score":70,"rationale":"Clear structure.","evidence":"Turn 2"},
    {"competency":"Problem solving","score":80,"rationale":"Structured approach.","evidence":"Turn 2"}
  ]'::jsonb;
BEGIN
  IF session_user IS DISTINCT FROM 'authenticator' THEN
    RAISE EXCEPTION 'student checks must run with session_user authenticator, got %', session_user;
  END IF;

  SELECT f.student_a, f.student_b, f.session_a, f.session_b
    INTO student_a, student_b, session_a, session_b
  FROM int008_fixture AS f;

  PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', student_a, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS DISTINCT FROM student_a THEN
    RAISE EXCEPTION 'student A JWT was not applied';
  END IF;

  SELECT count(*) INTO v_count FROM public.interview_sessions WHERE id = session_b;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'student A read student B interview session';
  END IF;

  SELECT count(*) INTO v_count FROM public.interview_turns WHERE session_id = session_b;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'student A read student B interview turns';
  END IF;

  SELECT count(*) INTO v_count FROM public.interview_sessions WHERE id = session_a;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'student A cannot read own session; isolation fixture is invalid';
  END IF;

  BEGIN
    INSERT INTO public.interview_scores (session_id, competency, score, rationale, eval_version)
    VALUES (session_a, 'Communication', 99, 'student write', 'INT008-v1');
    RAISE EXCEPTION 'student A inserted an interview score';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%student A inserted an interview score%' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE '%interview scores are written by the evaluator%' THEN
        RAISE EXCEPTION 'unexpected score insert denial: % %', SQLSTATE, SQLERRM;
      END IF;
  END;

  BEGIN
    UPDATE public.interview_sessions
    SET overall_score = 12
    WHERE id = session_a;
    RAISE EXCEPTION 'student A updated overall_score';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%student A updated overall_score%' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE '%overall_score is written by the evaluator%' THEN
        RAISE EXCEPTION 'unexpected overall_score denial: % %', SQLSTATE, SQLERRM;
      END IF;
  END;

  BEGIN
    UPDATE public.interview_sessions
    SET evaluation_status = 'completed'
    WHERE id = session_a;
    RAISE EXCEPTION 'student A updated evaluation_status';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%student A updated evaluation_status%' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE '%interview evaluation is written by the evaluator%' THEN
        RAISE EXCEPTION 'unexpected evaluation_status denial: % %', SQLSTATE, SQLERRM;
      END IF;
  END;

  SELECT overall_score INTO v_overall
  FROM public.interview_sessions
  WHERE id = session_a;
  IF v_overall IS NOT NULL THEN
    RAISE EXCEPTION 'student A overall_score change persisted';
  END IF;

  BEGIN
    PERFORM 1
    FROM public.apply_interview_evaluation(
      session_a,
      'INT008-v1',
      'Student attempt.',
      '["note"]'::jsonb,
      '["note"]'::jsonb,
      scores,
      now()
    );
    RAISE EXCEPTION 'student A executed apply_interview_evaluation';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%student A executed apply_interview_evaluation%' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE '%interview evaluation is written by the evaluator%' THEN
        RAISE EXCEPTION 'unexpected apply denial: % %', SQLSTATE, SQLERRM;
      END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';

  IF current_user IS DISTINCT FROM 'service_role' OR coalesce(auth.role(), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role context was not applied';
  END IF;

  SELECT c.outcome, c.claimed_at
    INTO v_outcome, v_claimed
  FROM public.claim_interview_evaluation(session_b, 'INT008-v1') AS c;

  IF v_outcome IS DISTINCT FROM 'claimed' OR v_claimed IS NULL THEN
    RAISE EXCEPTION 'service_role claim failed: %', v_outcome;
  END IF;

  SELECT a.outcome, a.overall_score, a.eval_version, a.evaluation_status, a.evaluation_summary
    INTO v_outcome, v_overall, v_version, v_status, v_summary
  FROM public.apply_interview_evaluation(
    session_b,
    'INT008-v1',
    'Solid behavioral answers with a concrete team example.',
    '["Explained a team example"]'::jsonb,
    '["Add a measurable result"]'::jsonb,
    scores,
    v_claimed
  ) AS a;

  IF v_outcome IS DISTINCT FROM 'completed'
     OR v_overall IS DISTINCT FROM 75.00
     OR v_version IS DISTINCT FROM 'INT008-v1'
     OR v_status IS DISTINCT FROM 'completed'
     OR v_summary IS NULL THEN
    RAISE EXCEPTION 'service_role apply failed: % overall=% version=% status=%',
      v_outcome, v_overall, v_version, v_status;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.interview_scores
  WHERE session_id = session_b
    AND eval_version = 'INT008-v1';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected 2 competency rows, found %', v_count;
  END IF;

  SELECT a.outcome, a.overall_score
    INTO v_outcome, v_overall
  FROM public.apply_interview_evaluation(
    session_b,
    'INT008-v1',
    'Solid behavioral answers with a concrete team example.',
    '["Explained a team example"]'::jsonb,
    '["Add a measurable result"]'::jsonb,
    scores,
    v_claimed
  ) AS a;

  IF v_outcome IS DISTINCT FROM 'already_completed' OR v_overall IS DISTINCT FROM 75.00 THEN
    RAISE EXCEPTION 'duplicate apply was not idempotent: % overall=%', v_outcome, v_overall;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.interview_scores
  WHERE session_id = session_b
    AND eval_version = 'INT008-v1';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'duplicate apply changed competency row count to %', v_count;
  END IF;

  BEGIN
    UPDATE public.interview_scores
    SET score = 1
    WHERE session_id = session_b
      AND competency = 'Communication'
      AND eval_version = 'INT008-v1';
    RAISE EXCEPTION 'stored score was overwritten';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%stored score was overwritten%' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE '%interview score history cannot be changed%' THEN
        RAISE EXCEPTION 'unexpected score update denial: % %', SQLSTATE, SQLERRM;
      END IF;
  END;

  SELECT score INTO v_score
  FROM public.interview_scores
  WHERE session_id = session_b
    AND competency = 'Communication'
    AND eval_version = 'INT008-v1';
  IF v_score IS DISTINCT FROM 70 THEN
    RAISE EXCEPTION 'Communication score changed to %', v_score;
  END IF;

  BEGIN
    INSERT INTO public.interview_scores (session_id, competency, score, rationale, evidence, eval_version)
    VALUES (session_b, 'Communication', 70, 'duplicate', 'duplicate', 'INT008-v1');
    RAISE EXCEPTION 'duplicate competency version row was inserted';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%duplicate competency version row was inserted%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'unexpected duplicate insert denial: % %', SQLSTATE, SQLERRM;
  END;

  SELECT a.outcome, a.eval_version, a.overall_score
    INTO v_outcome, v_version, v_overall
  FROM public.apply_interview_evaluation(
    session_b,
    'INT008-v2',
    'A later rubric must not replace v1.',
    '["Later strength"]'::jsonb,
    '["Later improvement"]'::jsonb,
    '[
      {"competency":"Communication","score":10,"rationale":"Replacement attempt.","evidence":"none"}
    ]'::jsonb,
    v_claimed
  ) AS a;

  IF v_outcome IS DISTINCT FROM 'version_preserved'
     OR v_version IS DISTINCT FROM 'INT008-v1'
     OR v_overall IS DISTINCT FROM 75.00 THEN
    RAISE EXCEPTION 'v2 replaced v1: % version=% overall=%', v_outcome, v_version, v_overall;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.interview_scores
  WHERE session_id = session_b
    AND eval_version = 'INT008-v2';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'v2 inserted % score rows', v_count;
  END IF;

  SELECT score INTO v_score
  FROM public.interview_scores
  WHERE session_id = session_b
    AND competency = 'Communication'
    AND eval_version = 'INT008-v1';
  IF v_score IS DISTINCT FROM 70 THEN
    RAISE EXCEPTION 'v1 Communication score changed after v2 to %', v_score;
  END IF;

  SELECT s.evaluation_summary INTO v_summary
  FROM public.interview_sessions AS s
  WHERE s.id = session_b;
  IF v_summary IS DISTINCT FROM 'Solid behavioral answers with a concrete team example.' THEN
    RAISE EXCEPTION 'v1 summary was replaced';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', student_a, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_count
  FROM public.interview_scores
  WHERE session_id = session_b;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'student A read student B interview scores';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', student_b::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', student_b, 'role', 'authenticated')::text,
    true
  );

  IF auth.uid() IS DISTINCT FROM student_b THEN
    RAISE EXCEPTION 'student B JWT was not applied';
  END IF;

  SELECT count(*) INTO v_count FROM public.interview_sessions WHERE id = session_b;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'student B cannot read own completed session';
  END IF;

  SELECT count(*) INTO v_count FROM public.interview_turns WHERE session_id = session_b;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'student B cannot read own transcript';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.interview_scores
  WHERE session_id = session_b
    AND eval_version = 'INT008-v1';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'student B cannot read own scores';
  END IF;

  RAISE NOTICE 'INT008 permanent RLS assertions passed';
END $assertions$;

ROLLBACK;
