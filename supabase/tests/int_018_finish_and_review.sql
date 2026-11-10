-- INT-018 local checks: finishing a session does not consume another attempt,
-- and INT-015 override requires interview.reviews. Rolls back.
\set ON_ERROR_STOP on
BEGIN;

DO $setup$
DECLARE
  student uuid := 'a0181111-1111-4111-8111-111111111111';
  reviewer uuid := 'c0183333-3333-4333-8333-333333333333';
  stranger uuid := 'd0184444-4444-4444-8444-444444444444';
  v_template uuid;
  v_version uuid;
  v_number integer;
  v_label uuid;
BEGIN
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  )
  VALUES
    ('00000000-0000-0000-0000-000000000000', student, 'authenticated', 'authenticated',
     'int018-allowed@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', reviewer, 'authenticated', 'authenticated',
     'int018-reviewer@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', stranger, 'authenticated', 'authenticated',
     'int018-noreview@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', '');

  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES
    (student, 'int018-allowed@example.test', 'INT018 Allowed', 'USER'),
    (reviewer, 'int018-reviewer@example.test', 'INT018 Reviewer', 'USER'),
    (stranger, 'int018-noreview@example.test', 'INT018 No Review', 'USER')
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name;

  INSERT INTO public.staff_permissions (key, group_name, label, sort_order)
  VALUES ('interview.reviews', 'Student features', 'Review interview scores', 230)
  ON CONFLICT (key) DO NOTHING;

  INSERT INTO public.staff_labels (name, slug, description, portal_access)
  VALUES ('INT018 Reviewers', 'int018_reviewers', 'local', true)
  ON CONFLICT (slug) DO NOTHING;
  SELECT id INTO v_label FROM public.staff_labels WHERE slug = 'int018_reviewers';
  INSERT INTO public.staff_label_members (label_id, user_id) VALUES (v_label, reviewer) ON CONFLICT DO NOTHING;
  INSERT INTO public.staff_label_permissions (label_id, permission_key)
  VALUES (v_label, 'interview.reviews'), (v_label, 'interview.access')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.staff_labels (name, slug, description, portal_access)
  VALUES ('INT018 Allowed', 'int018_allowed', 'local', false)
  ON CONFLICT (slug) DO NOTHING;
  SELECT id INTO v_label FROM public.staff_labels WHERE slug = 'int018_allowed';
  INSERT INTO public.staff_label_members (label_id, user_id) VALUES (v_label, student) ON CONFLICT DO NOTHING;
  INSERT INTO public.staff_label_permissions (label_id, permission_key)
  VALUES (v_label, 'interview.access')
  ON CONFLICT DO NOTHING;

  SELECT t.id, t.current_version INTO v_template, v_number
    FROM public.interview_templates t
   WHERE t.slug = 'hr-behavioral' AND t.status = 'published';
  SELECT v.id INTO v_version
    FROM public.interview_template_versions v
   WHERE v.template_id = v_template AND v.version = v_number;
  PERFORM set_config('int018.template_id', v_template::text, true);
  PERFORM set_config('int018.version_id', v_version::text, true);
  PERFORM set_config('int018.version_no', v_number::text, true);
END;
$setup$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a0181111-1111-4111-8111-111111111111', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
  v_start jsonb;
  v_id uuid;
  v_before integer;
  v_after integer;
BEGIN
  v_start := public.start_interview_with_quota(
    current_setting('int018.template_id')::uuid,
    current_setting('int018.version_no'),
    current_setting('int018.version_id')::uuid,
    NULL, NULL, NULL
  );
  v_id := (v_start->>'session_id')::uuid;
  v_before := (v_start->>'used')::integer;
  PERFORM public.finish_own_interview_session(v_id, 'manual');
  SELECT count(*)::integer INTO v_after
    FROM public.interview_sessions
   WHERE user_id = 'a0181111-1111-4111-8111-111111111111'
     AND started_at >= date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'finishing changed the weekly session count from % to %', v_before, v_after;
  END IF;
  IF (SELECT status FROM public.interview_sessions WHERE id = v_id) IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'finish did not complete the session';
  END IF;
  PERFORM set_config('int018.session_id', v_id::text, true);
END $$;

RESET ROLE;
UPDATE public.interview_sessions
   SET evaluation_status = 'completed',
       eval_version = 'INT008-v1',
       overall_score = 70,
       evaluated_at = now(),
       evaluation_summary = 'Local fixture summary'
 WHERE id = current_setting('int018.session_id')::uuid;
INSERT INTO public.interview_scores (session_id, competency, score, rationale, evidence, eval_version)
VALUES (
  current_setting('int018.session_id')::uuid,
  'Communication', 70, 'Clear', 'Local evidence', 'INT008-v1'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'd0184444-4444-4444-8444-444444444444', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
BEGIN
  BEGIN
    PERFORM public.apply_interview_score_override(
      current_setting('int018.session_id')::uuid,
      'competency', 'Communication', 80, 'This reviewer is not allowed to override.'
    );
    RAISE EXCEPTION 'reviewer without permission should have failed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%reviewer without permission should have failed%' THEN
      RAISE;
    END IF;
    IF SQLERRM NOT LIKE '%permission%' THEN
      RAISE;
    END IF;
  END;
END $$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c0183333-3333-4333-8333-333333333333', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
  v_row jsonb;
  v_ai numeric;
  v_status text;
BEGIN
  SELECT overall_score, status INTO v_ai, v_status
    FROM public.interview_sessions
   WHERE id = current_setting('int018.session_id')::uuid;
  v_row := public.apply_interview_score_override(
    current_setting('int018.session_id')::uuid,
    'competency', 'Communication', 80, 'Local mentor adjustment for the QA fixture.'
  );
  IF (v_row->>'oldScore')::numeric IS DISTINCT FROM 70 THEN
    RAISE EXCEPTION 'override did not record the AI score';
  END IF;
  IF (v_row->>'aiOverallScore')::numeric IS DISTINCT FROM 70 THEN
    RAISE EXCEPTION 'override changed the stored AI overall score';
  END IF;
  v_row := public.set_interview_mentor_review_published(
    current_setting('int018.session_id')::uuid, true
  );
  IF (v_row->>'mentorReviewPublished')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'review was not published';
  END IF;
END $$;

ROLLBACK;
