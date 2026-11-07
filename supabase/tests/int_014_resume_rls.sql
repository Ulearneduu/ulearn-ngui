-- INT-014 resume ownership checks.
-- Run on a disposable database after 20261108_int014_interview_resume.sql.
-- Do not run this against production project yllfccuxohnipleyseup.
-- The script rolls back. It needs two existing profiles.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'interview_sessions'
      AND column_name = 'resume_text'
  ) THEN
    RAISE EXCEPTION 'INT-014 resume columns are not applied';
  END IF;
END $$;

BEGIN;

CREATE TEMP TABLE int014_actor (
  key text PRIMARY KEY,
  user_id uuid NOT NULL
);

INSERT INTO int014_actor (key, user_id)
SELECT 'student_a', p.id
FROM public.profiles AS p
ORDER BY p.id
LIMIT 1;

INSERT INTO int014_actor (key, user_id)
SELECT 'student_b', p.id
FROM public.profiles AS p
WHERE p.id <> (SELECT user_id FROM int014_actor WHERE key = 'student_a')
ORDER BY p.id
LIMIT 1;

DO $$
DECLARE
  student_a uuid;
  student_b uuid;
  v_template_id uuid;
  v_version_id uuid;
  session_id uuid;
  visible text;
  other_visible text;
BEGIN
  SELECT user_id INTO student_a FROM int014_actor WHERE key = 'student_a';
  SELECT user_id INTO student_b FROM int014_actor WHERE key = 'student_b';
  IF student_a IS NULL OR student_b IS NULL THEN
    RAISE EXCEPTION 'INT-014 RLS test needs two profiles';
  END IF;

  SELECT id INTO v_template_id
  FROM public.interview_templates
  WHERE status = 'published'
  ORDER BY created_at
  LIMIT 1;
  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'INT-014 RLS test needs a published interview template';
  END IF;

  SELECT interview_template_versions.id INTO v_version_id
  FROM public.interview_template_versions
  WHERE interview_template_versions.template_id = v_template_id
  ORDER BY version DESC
  LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', student_a::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', student_a, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  INSERT INTO public.interview_sessions (
    user_id, template_id, status, prompt_version, template_version_id, resume_text
  ) VALUES (
    student_a, v_template_id, 'in_progress', '1', v_version_id,
    'Projects
- AI-Based Medical Scanner using MobileNetV2.'
  ) RETURNING id INTO session_id;

  SELECT resume_text INTO visible
  FROM public.interview_sessions
  WHERE id = session_id;
  IF visible IS NULL OR position('MobileNetV2' in visible) = 0 THEN
    RAISE EXCEPTION 'owner could not read their resume';
  END IF;

  BEGIN
    UPDATE public.interview_sessions
      SET resume_text = 'changed by owner'
      WHERE id = session_id;
    RAISE EXCEPTION 'owner update of resume_text was allowed';
  EXCEPTION
    WHEN insufficient_privilege OR check_violation THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%resume context%' AND SQLERRM NOT LIKE '%permission denied%' THEN
        RAISE;
      END IF;
  END;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', student_b::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', student_b, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT resume_text INTO other_visible
  FROM public.interview_sessions
  WHERE id = session_id;
  IF other_visible IS NOT NULL THEN
    RAISE EXCEPTION 'another student could read the resume';
  END IF;

  BEGIN
    UPDATE public.interview_sessions
      SET resume_text = 'stolen'
      WHERE id = session_id;
    IF FOUND THEN
      RAISE EXCEPTION 'another student updated the resume';
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    PERFORM 1 FROM public.interview_sessions WHERE id = session_id;
    RAISE EXCEPTION 'anon read was allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  RESET ROLE;
  EXECUTE 'SET LOCAL ROLE postgres';
  DELETE FROM public.interview_sessions WHERE id = session_id;
  IF EXISTS (SELECT 1 FROM public.interview_sessions WHERE id = session_id) THEN
    RAISE EXCEPTION 'deleted session row still exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.interview_sessions WHERE resume_text LIKE '%MobileNetV2%' AND id = session_id
  ) THEN
    RAISE EXCEPTION 'resume text survived session deletion';
  END IF;

  INSERT INTO public.interview_sessions (
    user_id, template_id, status, prompt_version, template_version_id
  ) VALUES (
    student_a, v_template_id, 'in_progress', '1', v_version_id
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.interview_sessions
    WHERE user_id = student_a AND resume_text IS NULL AND resume_question_log = '[]'::jsonb
  ) THEN
    RAISE EXCEPTION 'a session without a resume was not stored';
  END IF;

  RAISE NOTICE 'INT014 resume RLS checks passed';
END $$;

ROLLBACK;
