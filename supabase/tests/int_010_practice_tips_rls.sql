-- INT-010 RLS assertions for a disposable local database.
-- Run as supabase_admin after 20261107_interview_practice_tips.sql is applied:
--   psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/int_010_practice_tips_rls.sql
-- Do not run this file against the linked project or any shared database.
-- Fixtures are created inside this transaction and removed by ROLLBACK.
-- The reserved production session 61ffb07f-b042-419c-8203-cec5af103d98 is never used.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = current_user
      AND rolsuper
  ) THEN
    RAISE EXCEPTION 'INT-010 RLS test must run as a local superuser (supabase_admin)';
  END IF;

  IF to_regprocedure('public.apply_interview_evaluation(uuid, text, text, jsonb, jsonb, jsonb, timestamptz, text[])') IS NULL
     OR to_regprocedure('public.apply_interview_evaluation(uuid, text, text, jsonb, jsonb, jsonb, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'INT-010 tips function or INT-008 apply function is not applied';
  END IF;
END $$;

BEGIN;

DO $fixtures$
DECLARE
  student_a uuid := 'a0101010-1010-4010-8010-101010101010';
  student_b uuid := 'b0101010-1010-4010-8010-101010101010';
  session_a uuid := 'c0101010-1010-4010-8010-101010101010';
  session_b uuid := 'd0101010-1010-4010-8010-101010101010';
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
       OR lower(email) IN ('int010-rls-a@example.test', 'int010-rls-b@example.test')
  ) THEN
    RAISE EXCEPTION 'INT-010 RLS fixture identities already exist';
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  )
  VALUES
    (
      '00000000-0000-0000-0000-000000000000', student_a, 'authenticated', 'authenticated',
      'int010-rls-a@example.test', '', now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', 'INT010 RLS A'), now(), now(), '', '', '', ''
    ),
    (
      '00000000-0000-0000-0000-000000000000', student_b, 'authenticated', 'authenticated',
      'int010-rls-b@example.test', '', now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', 'INT010 RLS B'), now(), now(), '', '', '', ''
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
    (session_a, student_a, template_id, 'in_progress', 'INT010-rls'),
    (session_b, student_b, template_id, 'in_progress', 'INT010-rls');

  UPDATE public.interview_sessions
  SET status = 'completed', ended_at = now()
  WHERE id IN (session_a, session_b);

  CREATE TEMP TABLE int010_fixture (
    student_a uuid NOT NULL,
    student_b uuid NOT NULL,
    session_a uuid NOT NULL,
    session_b uuid NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO int010_fixture VALUES (student_a, student_b, session_a, session_b);
  GRANT SELECT ON TABLE int010_fixture TO authenticator, authenticated, service_role;
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
  v_claimed timestamptz;
  v_tips text[];
  v_again text[];
  v_evaluated timestamptz;
  v_evaluated_again timestamptz;
  scores jsonb := '[
    {"competency":"Communication","score":70,"rationale":"Clear structure.","evidence":"Turn 2"},
    {"competency":"Decision making","score":40,"rationale":"The outcome was missing.","evidence":"Turn 2"}
  ]'::jsonb;
  tips text[] := ARRAY[
    'Explain your decision-making process step by step.',
    'Support the communication answer with one specific example.',
    'State the result of the action you took.'
  ];
BEGIN
  IF session_user IS DISTINCT FROM 'authenticator' THEN
    RAISE EXCEPTION 'student checks must run with session_user authenticator, got %', session_user;
  END IF;

  SELECT f.student_a, f.student_b, f.session_a, f.session_b
    INTO student_a, student_b, session_a, session_b
  FROM int010_fixture AS f;

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
    RAISE EXCEPTION 'student A read student B interview tips';
  END IF;

  BEGIN
    UPDATE public.interview_sessions
    SET evaluation_tips = tips
    WHERE id = session_a;
    RAISE EXCEPTION 'student A updated evaluation_tips';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%student A updated evaluation_tips%' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE '%interview evaluation is written by the evaluator%'
         AND SQLERRM NOT LIKE '%permission denied%' THEN
        RAISE EXCEPTION 'unexpected tips denial: % %', SQLSTATE, SQLERRM;
      END IF;
  END;

  BEGIN
    PERFORM 1
    FROM public.apply_interview_evaluation(
      session_a, 'INT008-v1', 'Student attempt.', '["note"]'::jsonb, '["note"]'::jsonb, scores, now(), tips
    );
    RAISE EXCEPTION 'student A executed apply_interview_evaluation with tips';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%student A executed apply_interview_evaluation with tips%' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE '%interview evaluation is written by the evaluator%' THEN
        RAISE EXCEPTION 'unexpected apply denial: % %', SQLSTATE, SQLERRM;
      END IF;
  END;

  SELECT evaluation_tips INTO v_tips
  FROM public.interview_sessions
  WHERE id = session_a;
  IF v_tips IS NOT NULL THEN
    RAISE EXCEPTION 'student A tips change persisted';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT c.outcome, c.claimed_at
    INTO v_outcome, v_claimed
  FROM public.claim_interview_evaluation(session_b, 'INT008-v1') AS c;
  IF v_outcome IS DISTINCT FROM 'claimed' OR v_claimed IS NULL THEN
    RAISE EXCEPTION 'service_role claim failed: %', v_outcome;
  END IF;

  SELECT a.outcome, a.evaluation_tips, a.evaluated_at
    INTO v_outcome, v_tips, v_evaluated
  FROM public.apply_interview_evaluation(
    session_b,
    'INT008-v1',
    'Decision making needs a clearer result.',
    '["Named the people involved"]'::jsonb,
    '["Add the result"]'::jsonb,
    scores,
    v_claimed,
    tips
  ) AS a;

  IF v_outcome IS DISTINCT FROM 'completed' OR v_tips IS DISTINCT FROM tips THEN
    RAISE EXCEPTION 'tips were not stored: % %', v_outcome, v_tips;
  END IF;

  SELECT a.outcome, a.evaluation_tips, a.evaluated_at
    INTO v_outcome, v_again, v_evaluated_again
  FROM public.apply_interview_evaluation(
    session_b,
    'INT008-v1',
    'A different summary must not replace the saved one.',
    '["Different strength"]'::jsonb,
    '["Different improvement"]'::jsonb,
    scores,
    v_claimed,
    ARRAY[
      'This later tip must not replace the saved tip one.',
      'This later tip must not replace the saved tip two.',
      'This later tip must not replace the saved tip three.'
    ]
  ) AS a;

  IF v_outcome IS DISTINCT FROM 'already_completed'
     OR v_again IS DISTINCT FROM tips
     OR v_evaluated_again IS DISTINCT FROM v_evaluated THEN
    RAISE EXCEPTION 'repeated evaluation did not keep the saved tips';
  END IF;

  BEGIN
    PERFORM 1
    FROM public.apply_interview_evaluation(
      session_a, 'INT008-v1', 'Too few tips.', '["note"]'::jsonb, '["note"]'::jsonb, scores, v_claimed,
      ARRAY['Only one tip']
    );
    RAISE EXCEPTION 'invalid tips were accepted';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%invalid tips were accepted%' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE '%invalid evaluation tips%' THEN
        RAISE EXCEPTION 'unexpected invalid-tips error: % %', SQLSTATE, SQLERRM;
      END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub', student_b::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', student_b, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT evaluation_tips INTO v_tips
  FROM public.interview_sessions
  WHERE id = session_b;
  IF v_tips IS DISTINCT FROM tips THEN
    RAISE EXCEPTION 'owner could not read saved tips';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', student_a, 'role', 'authenticated')::text,
    true
  );
  SELECT count(*) INTO v_count
  FROM public.interview_sessions
  WHERE id = session_b;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'student A read student B saved tips after evaluation';
  END IF;
END $assertions$;

ROLLBACK;

\echo INT010 practice tip RLS assertions passed
