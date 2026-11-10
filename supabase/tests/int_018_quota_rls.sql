-- INT-018 quota and insert-policy checks for a disposable local database.
-- Apply 20261110180000_int018_quota_start_and_rls.sql first.
--   psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/int_018_quota_rls.sql
-- The transaction rolls back. Do not run this against a shared project.

\set ON_ERROR_STOP on

BEGIN;

DO $fixtures$
DECLARE
  student_ok uuid := 'a0181111-1111-4111-8111-111111111111';
  student_no uuid := 'b0182222-2222-4222-8222-222222222222';
  v_template_id uuid;
  v_version_id uuid;
  v_version_no integer;
  week_start timestamptz;
  label_ok uuid;
  label_no uuid;
BEGIN
  IF to_regprocedure('public.start_interview_with_quota(uuid, text, uuid, uuid, text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'INT-018 start function is not installed';
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  )
  VALUES
    ('00000000-0000-0000-0000-000000000000', student_ok, 'authenticated', 'authenticated',
     'int018-allowed@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', student_no, 'authenticated', 'authenticated',
     'int018-denied@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
     now(), now(), '', '', '', '');

  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES
    (student_ok, 'int018-allowed@example.test', 'INT018 Allowed', 'USER'),
    (student_no, 'int018-denied@example.test', 'INT018 Denied', 'USER')
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, role = EXCLUDED.role;

  INSERT INTO public.staff_labels (id, name, slug, description, portal_access)
  VALUES
    (gen_random_uuid(), 'INT018 Allowed', 'int018_allowed', 'local', false),
    (gen_random_uuid(), 'INT018 Denied', 'int018_denied', 'local', false)
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO label_ok FROM public.staff_labels WHERE slug = 'int018_allowed';
  SELECT id INTO label_no FROM public.staff_labels WHERE slug = 'int018_denied';
  INSERT INTO public.staff_label_members (label_id, user_id)
  VALUES (label_ok, student_ok), (label_no, student_no)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.staff_label_permissions (label_id, permission_key)
  VALUES (label_ok, 'interview.access')
  ON CONFLICT DO NOTHING;

  SELECT t.id, t.current_version
    INTO v_template_id, v_version_no
    FROM public.interview_templates t
   WHERE t.slug = 'hr-behavioral' AND t.status = 'published';
  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'published hr-behavioral template is missing';
  END IF;

  SELECT v.id INTO v_version_id
    FROM public.interview_template_versions v
   WHERE v.template_id = v_template_id AND v.version = v_version_no;
  IF v_version_id IS NULL THEN
    RAISE EXCEPTION 'current hr-behavioral template version is missing';
  END IF;

  week_start := date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';

  INSERT INTO public.interview_sessions (
    user_id, template_id, status, prompt_version, template_version_id, started_at
  )
  VALUES (
    student_ok, v_template_id, 'completed', v_version_no::text, v_version_id, week_start - interval '1 day'
  );

  PERFORM set_config('int018.template_id', v_template_id::text, true);
  PERFORM set_config('int018.version_id', v_version_id::text, true);
  PERFORM set_config('int018.version_no', v_version_no::text, true);
  PERFORM set_config('int018.week_start', week_start::text, true);
END;
$fixtures$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'b0182222-2222-4222-8222-222222222222', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
BEGIN
  BEGIN
    PERFORM public.start_interview_with_quota(
      current_setting('int018.template_id')::uuid,
      current_setting('int018.version_no'),
      current_setting('int018.version_id')::uuid,
      NULL, NULL, NULL
    );
    RAISE EXCEPTION 'denied student start should have failed';
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    IF SQLERRM LIKE '%denied student start should have failed%' THEN
      RAISE;
    END IF;
    IF SQLERRM NOT LIKE '%Interview access denied%' AND SQLERRM NOT LIKE '%42501%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    INSERT INTO public.interview_sessions (
      user_id, template_id, status, prompt_version, template_version_id
    )
    VALUES (
      'b0182222-2222-4222-8222-222222222222',
      current_setting('int018.template_id')::uuid,
      'in_progress',
      current_setting('int018.version_no'),
      current_setting('int018.version_id')::uuid
    );
    RAISE EXCEPTION 'direct insert without permission should have failed';
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    IF SQLERRM LIKE '%direct insert without permission should have failed%' THEN
      RAISE;
    END IF;
  END;
END $$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a0181111-1111-4111-8111-111111111111', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
  v_row jsonb;
  v_id uuid;
  v_count integer;
  v_limit integer;
BEGIN
  BEGIN
    INSERT INTO public.interview_sessions (
      user_id, template_id, status, prompt_version, template_version_id
    )
    VALUES (
      'a0181111-1111-4111-8111-111111111111',
      current_setting('int018.template_id')::uuid,
      'in_progress',
      current_setting('int018.version_no'),
      current_setting('int018.version_id')::uuid
    );
    RAISE EXCEPTION 'direct insert with permission should have failed';
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    IF SQLERRM LIKE '%direct insert with permission should have failed%' THEN
      RAISE;
    END IF;
  END;

  v_row := public.start_interview_with_quota(
    current_setting('int018.template_id')::uuid,
    current_setting('int018.version_no'),
    current_setting('int018.version_id')::uuid,
    NULL, NULL, NULL
  );
  IF v_row->>'status' IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'started session must be in_progress';
  END IF;
  IF coalesce((v_row->>'resumed')::boolean, false) THEN
    RAISE EXCEPTION 'a new start must not be resumed';
  END IF;
  v_id := (v_row->>'session_id')::uuid;

  IF (
    SELECT count(*)
      FROM public.interview_sessions
     WHERE id = v_id
       AND user_id = 'a0181111-1111-4111-8111-111111111111'
       AND template_id = current_setting('int018.template_id')::uuid
       AND template_version_id = current_setting('int018.version_id')::uuid
       AND prompt_version = current_setting('int018.version_no')
       AND status = 'in_progress'
  ) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'start did not store one current template snapshot';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM public.interview_sessions
   WHERE user_id = 'a0181111-1111-4111-8111-111111111111'
     AND started_at >= current_setting('int018.week_start')::timestamptz;
  IF v_count IS DISTINCT FROM (v_row->>'used')::integer THEN
    RAISE EXCEPTION 'quota used % does not match current-week sessions %', v_row->>'used', v_count;
  END IF;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'a previous-week session was counted toward this week';
  END IF;

END $$;

RESET ROLE;
SELECT set_config('int018.saved_limit', weekly_limit::text, true)
  FROM public.interview_quota_config
 WHERE id = 1;
UPDATE public.interview_quota_config SET weekly_limit = 1 WHERE id = 1;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a0181111-1111-4111-8111-111111111111', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
  v_row jsonb;
BEGIN
  v_row := public.start_interview_with_quota(
    current_setting('int018.template_id')::uuid,
    current_setting('int018.version_no'),
    current_setting('int018.version_id')::uuid,
    NULL, NULL, NULL
  );
  IF v_row->>'code' IS DISTINCT FROM 'WEEKLY_QUOTA_EXCEEDED' THEN
    RAISE EXCEPTION 'second start in a one-session week must be rejected';
  END IF;
  IF (
    SELECT count(*)
      FROM public.interview_sessions
     WHERE user_id = 'a0181111-1111-4111-8111-111111111111'
       AND started_at >= current_setting('int018.week_start')::timestamptz
  ) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'rejected start created another session';
  END IF;
END $$;

RESET ROLE;
UPDATE public.interview_quota_config
   SET weekly_limit = current_setting('int018.saved_limit')::integer
 WHERE id = 1;

ROLLBACK;
