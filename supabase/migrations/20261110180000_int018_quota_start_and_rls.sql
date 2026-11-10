-- INT-018 follows 20261110143000_int006_start_with_quota.sql.
-- That migration is the catalog quota function from #86, including interview.access.
-- This migration keeps that behavior and adds two checks #86 does not:
-- the published current template snapshot, and a direct-insert denial.
-- Authenticated clients cannot insert interview_sessions, so a Data API insert
-- cannot skip interview.access or the weekly quota. The function is SECURITY
-- DEFINER and bypasses RLS as its owner.
-- Do not apply this file with supabase db push.

DROP FUNCTION IF EXISTS public.start_interview_with_quota(uuid);
DROP FUNCTION IF EXISTS public.start_interview_with_quota(uuid, text, uuid, uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.start_interview_with_quota(
  p_template_id uuid DEFAULT NULL,
  p_prompt_version text DEFAULT NULL,
  p_template_version_id uuid DEFAULT NULL,
  p_resume_session_id uuid DEFAULT NULL,
  p_resume_text text DEFAULT NULL,
  p_redo_of_session_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_week_start timestamptz;
  v_week_end timestamptz;
  v_limit integer;
  v_used integer;
  v_session_id uuid;
  v_session_status text;
  v_parent public.interview_sessions%ROWTYPE;
  v_resume_trimmed text;
  v_version integer;
  v_current integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '28000';
  END IF;

  IF NOT public.has_permission('interview.access') THEN
    RAISE EXCEPTION 'Interview access denied'
      USING ERRCODE = '42501';
  END IF;

  v_week_start :=
    date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  v_week_end := v_week_start + interval '7 days';

  SELECT weekly_limit
    INTO v_limit
    FROM public.interview_quota_config
   WHERE id = 1;

  IF v_limit IS NULL OR v_limit <= 0 THEN
    RAISE EXCEPTION 'Interview quota configuration is missing or invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_resume_session_id IS NOT NULL THEN
    IF p_template_id IS NOT NULL
       OR p_prompt_version IS NOT NULL
       OR p_template_version_id IS NOT NULL
       OR p_resume_text IS NOT NULL
       OR p_redo_of_session_id IS NOT NULL THEN
      RAISE EXCEPTION 'Resume start cannot include new-session fields'
        USING ERRCODE = '22023';
    END IF;

    SELECT s.id, s.status
      INTO v_session_id, v_session_status
      FROM public.interview_sessions s
     WHERE s.id = p_resume_session_id
       AND s.user_id = v_user_id
       AND s.status = 'in_progress'
       AND s.started_at >= v_week_start
       AND s.started_at < v_week_end;

    IF v_session_id IS NULL THEN
      RAISE EXCEPTION 'Interview session not found or not resumable'
        USING ERRCODE = 'P0002';
    END IF;

    SELECT count(*)::integer
      INTO v_used
      FROM public.interview_sessions
     WHERE user_id = v_user_id
       AND started_at >= v_week_start
       AND started_at < v_week_end;

    RETURN jsonb_build_object(
      'session_id', v_session_id,
      'status', v_session_status,
      'resumed', true,
      'weekly_limit', v_limit,
      'limit', v_limit,
      'used', v_used,
      'remaining', greatest(v_limit - v_used, 0),
      'week_starts_at', v_week_start,
      'resets_at', v_week_end
    );
  END IF;

  IF p_template_id IS NULL
     OR p_prompt_version IS NULL
     OR btrim(p_prompt_version) = '' THEN
    RAISE EXCEPTION 'Interview template version information is required'
      USING ERRCODE = '22023';
  END IF;

  v_resume_trimmed := NULLIF(btrim(COALESCE(p_resume_text, '')), '');
  IF v_resume_trimmed IS NOT NULL AND char_length(v_resume_trimmed) > 8000 THEN
    RAISE EXCEPTION 'resume text exceeds maximum length'
      USING ERRCODE = '22023';
  END IF;

  IF p_redo_of_session_id IS NOT NULL THEN
    IF v_resume_trimmed IS NOT NULL THEN
      RAISE EXCEPTION 'resume text cannot be set on a redo session'
        USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_parent
      FROM public.interview_sessions
     WHERE id = p_redo_of_session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'interview redo parent session was not found'
        USING ERRCODE = 'P0002';
    END IF;
    IF v_parent.user_id IS DISTINCT FROM v_user_id THEN
      RAISE EXCEPTION 'interview redo parent must belong to the signed-in user'
        USING ERRCODE = '42501';
    END IF;
    IF v_parent.status IS DISTINCT FROM 'completed' THEN
      RAISE EXCEPTION 'interview redo parent must be completed'
        USING ERRCODE = '22023';
    END IF;
    IF v_parent.template_id IS DISTINCT FROM p_template_id THEN
      RAISE EXCEPTION 'interview redo parent must use the same template'
        USING ERRCODE = '22023';
    END IF;
    IF v_parent.prompt_version IS DISTINCT FROM p_prompt_version THEN
      RAISE EXCEPTION 'interview redo parent must use the same prompt version'
        USING ERRCODE = '22023';
    END IF;
    IF v_parent.template_version_id IS DISTINCT FROM p_template_version_id THEN
      RAISE EXCEPTION 'interview redo parent must use the same template version'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_template_version_id IS NULL THEN
    RAISE EXCEPTION 'Interview template version information is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_template_version_id IS NOT NULL THEN
    SELECT v.version, t.current_version
      INTO v_version, v_current
      FROM public.interview_template_versions AS v
      JOIN public.interview_templates AS t ON t.id = v.template_id
     WHERE v.id = p_template_version_id
       AND v.template_id = p_template_id
       AND v.version::text = btrim(p_prompt_version);

    IF v_version IS NULL THEN
      RAISE EXCEPTION 'Interview template version is not available'
        USING ERRCODE = '42501';
    END IF;

    IF p_redo_of_session_id IS NULL THEN
      IF NOT EXISTS (
        SELECT 1
          FROM public.interview_templates AS t
         WHERE t.id = p_template_id
           AND t.status = 'published'
      ) THEN
        RAISE EXCEPTION 'Interview template is not available'
          USING ERRCODE = '42501';
      END IF;
      IF v_current IS DISTINCT FROM v_version THEN
        RAISE EXCEPTION 'Interview template version is not current'
          USING ERRCODE = '22023';
      END IF;
    END IF;
  ELSIF p_redo_of_session_id IS NULL THEN
    RAISE EXCEPTION 'Interview template version information is required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.interview_quota_user_locks (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM 1
    FROM public.interview_quota_user_locks
   WHERE user_id = v_user_id
   FOR UPDATE;

  SELECT count(*)::integer
    INTO v_used
    FROM public.interview_sessions
   WHERE user_id = v_user_id
     AND started_at >= v_week_start
     AND started_at < v_week_end;

  IF v_used >= v_limit THEN
    RETURN jsonb_build_object(
      'code', 'WEEKLY_QUOTA_EXCEEDED',
      'weekly_limit', v_limit,
      'limit', v_limit,
      'used', v_used,
      'remaining', 0,
      'week_starts_at', v_week_start,
      'resets_at', v_week_end
    );
  END IF;

  INSERT INTO public.interview_sessions (
    user_id,
    template_id,
    status,
    prompt_version,
    template_version_id,
    resume_text,
    redo_of_session_id
  )
  VALUES (
    v_user_id,
    p_template_id,
    'in_progress',
    btrim(p_prompt_version),
    p_template_version_id,
    v_resume_trimmed,
    p_redo_of_session_id
  )
  RETURNING id INTO v_session_id;

  v_used := v_used + 1;

  RETURN jsonb_build_object(
    'session_id', v_session_id,
    'status', 'in_progress',
    'resumed', false,
    'weekly_limit', v_limit,
    'limit', v_limit,
    'used', v_used,
    'remaining', greatest(v_limit - v_used, 0),
    'week_starts_at', v_week_start,
    'resets_at', v_week_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_interview_with_quota(uuid, text, uuid, uuid, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_interview_with_quota(uuid, text, uuid, uuid, text, uuid)
  TO authenticated;

-- Direct Data API inserts cannot satisfy this check. Students start through the function.
DROP POLICY IF EXISTS "Users create own interview sessions" ON public.interview_sessions;
CREATE POLICY "Users create own interview sessions"
ON public.interview_sessions
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND public.has_permission('interview.access')
  AND false
);
