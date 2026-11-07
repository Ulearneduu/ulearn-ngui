-- INT-015 RLS / RPC assertions for a disposable local database.
-- Run as supabase_admin after 20261109_interview_score_overrides.sql is applied:
--   psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/int_015_score_overrides_rls.sql
-- Do not run this file against the linked project or any shared database.
-- Fixtures are created inside this transaction and removed by ROLLBACK.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE EXCEPTION 'INT-015 RLS test must run as a local superuser (supabase_admin)';
  END IF;

  IF to_regclass('public.interview_score_overrides') IS NULL
     OR to_regprocedure('public.apply_interview_score_override(uuid, text, text, numeric, text)') IS NULL THEN
    RAISE EXCEPTION 'INT-015 override migration is not applied';
  END IF;
END $$;

BEGIN;

DO $fixtures$
DECLARE
  student_a uuid := 'a0151111-1111-4111-8111-111111111111';
  student_b uuid := 'b0152222-2222-4222-8222-222222222222';
  mentor_u uuid := 'c0153333-3333-4333-8333-333333333333';
  session_a uuid := 'd0154444-4444-4444-8444-444444444444';
  template_id uuid;
  label_id uuid;
BEGIN
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  )
  VALUES
    ('00000000-0000-0000-0000-000000000000', student_a, 'authenticated', 'authenticated',
     'int015-a@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb,
     '{}'::jsonb, now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', student_b, 'authenticated', 'authenticated',
     'int015-b@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb,
     '{}'::jsonb, now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', mentor_u, 'authenticated', 'authenticated',
     'int015-mentor@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('role', 'ADMIN'), now(), now(), '', '', '', '');

  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES
    (student_a, 'int015-a@example.test', 'INT015 A', 'USER'),
    (student_b, 'int015-b@example.test', 'INT015 B', 'USER'),
    (mentor_u, 'int015-mentor@example.test', 'INT015 Mentor', 'ADMIN')
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, role = EXCLUDED.role;

  INSERT INTO public.staff_labels (id, name, slug, description, portal_access)
  VALUES (gen_random_uuid(), 'INT015 Reviewers', 'int015_reviewers', 'test', true)
  ON CONFLICT DO NOTHING;

  SELECT id INTO label_id FROM public.staff_labels WHERE slug = 'int015_reviewers';
  INSERT INTO public.staff_label_members (label_id, user_id)
  VALUES (label_id, mentor_u)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.staff_label_permissions (label_id, permission_key)
  VALUES (label_id, 'interview.reviews')
  ON CONFLICT DO NOTHING;

  SELECT id INTO template_id
  FROM public.interview_templates
  WHERE slug = 'hr-behavioral' AND status = 'published';
  IF template_id IS NULL THEN
    RAISE EXCEPTION 'published hr-behavioral template is missing';
  END IF;

  INSERT INTO public.interview_sessions (
    id, user_id, template_id, status, prompt_version, started_at, ended_at,
    overall_score, evaluation_status, eval_version, evaluated_at, evaluation_summary
  )
  VALUES (
    session_a, student_a, template_id, 'completed', '1',
    now() - interval '30 minutes', now() - interval '10 minutes',
    75, 'completed', 'INT008-v1', now() - interval '5 minutes', 'Summary'
  );

  INSERT INTO public.interview_scores (session_id, competency, score, rationale, evidence, eval_version)
  VALUES
    (session_a, 'Communication', 70, 'Clear', 'Evidence', 'INT008-v1'),
    (session_a, 'Coding', 100, 'Passed', '2/2', 'INT008-v1');
END;
$fixtures$;

-- Student cannot insert overrides.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  'a0151111-1111-4111-8111-111111111111',
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
BEGIN
  BEGIN
    PERFORM public.apply_interview_score_override(
      'd0154444-4444-4444-8444-444444444444',
      'overall',
      NULL,
      80,
      'Student must never be able to create overrides.'
    );
    RAISE EXCEPTION 'student override should have failed';
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    IF SQLERRM LIKE '%permission%' OR SQLERRM LIKE '%Sign in%' OR SQLERRM LIKE '%42501%' THEN
      NULL;
    ELSIF SQLERRM LIKE '%student override should have failed%' THEN
      RAISE;
    END IF;
  END;
END $$;

-- Mentor with interview.reviews can override and publish.
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  'c0153333-3333-4333-8333-333333333333',
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
  v_ai numeric;
  v_row jsonb;
BEGIN
  SELECT overall_score INTO v_ai
  FROM public.interview_sessions
  WHERE id = 'd0154444-4444-4444-8444-444444444444';

  v_row := public.apply_interview_score_override(
    'd0154444-4444-4444-8444-444444444444',
    'competency',
    'Coding',
    90,
    'Coding override for INT-015 security fixture check.'
  );

  IF (v_row->>'oldScore')::numeric IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'old_score must be server-derived from AI Coding score';
  END IF;

  IF (
    SELECT overall_score
    FROM public.interview_sessions
    WHERE id = 'd0154444-4444-4444-8444-444444444444'
  ) IS DISTINCT FROM v_ai THEN
    RAISE EXCEPTION 'AI overall_score must remain unchanged after override';
  END IF;

  BEGIN
    UPDATE public.interview_score_overrides SET reason = 'tamper' WHERE session_id = 'd0154444-4444-4444-8444-444444444444';
    RAISE EXCEPTION 'override update should have failed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%override update should have failed%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    DELETE FROM public.interview_score_overrides
    WHERE session_id = 'd0154444-4444-4444-8444-444444444444';
    RAISE EXCEPTION 'direct override delete should have failed while session exists';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%direct override delete should have failed while session exists%' THEN
      RAISE;
    END IF;
  END;

  PERFORM public.set_interview_mentor_review_published(
    'd0154444-4444-4444-8444-444444444444',
    true
  );
END $$;

RESET ROLE;
SELECT set_config(
  'request.jwt.claim.sub',
  'a0151111-1111-4111-8111-111111111111',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.interview_score_overrides
  WHERE session_id = 'd0154444-4444-4444-8444-444444444444';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'student should see published overrides for own session';
  END IF;
END $$;

RESET ROLE;
SELECT set_config(
  'request.jwt.claim.sub',
  'b0152222-2222-4222-8222-222222222222',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.interview_score_overrides
  WHERE session_id = 'd0154444-4444-4444-8444-444444444444';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'other student must not read overrides';
  END IF;
END $$;

-- Cascade cleanup: deleting the parent session must succeed even with overrides.
RESET ROLE;

DO $$
DECLARE
  v_left integer;
BEGIN
  DELETE FROM public.interview_sessions
  WHERE id = 'd0154444-4444-4444-8444-444444444444';

  SELECT count(*) INTO v_left
  FROM public.interview_score_overrides
  WHERE session_id = 'd0154444-4444-4444-8444-444444444444';

  IF v_left <> 0 THEN
    RAISE EXCEPTION 'cascade delete should remove override rows with the session';
  END IF;
END $$;

DO $$
BEGIN
  RAISE NOTICE 'INT015 score override assertions passed';
END $$;

ROLLBACK;
