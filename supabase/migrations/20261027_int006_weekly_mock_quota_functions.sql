
-- INT-006: Read weekly interview quota for the authenticated user.

CREATE OR REPLACE FUNCTION public.get_interview_quota_status()
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
    date_trunc(
      'week',
      now() AT TIME ZONE 'Asia/Kolkata'
    ) AT TIME ZONE 'Asia/Kolkata';

  v_week_end := v_week_start + interval '7 days';

  SELECT weekly_limit
    INTO v_limit
    FROM public.interview_quota_config
   WHERE id = 1;

  IF v_limit IS NULL OR v_limit <= 0 THEN
    RAISE EXCEPTION 'Interview quota configuration is missing or invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer
    INTO v_used
    FROM public.interview_sessions
   WHERE user_id = v_user_id
     AND started_at >= v_week_start
     AND started_at < v_week_end;

  RETURN jsonb_build_object(
    'weekly_limit', v_limit,
    'limit', v_limit,
    'used', v_used,
    'remaining', greatest(v_limit - v_used, 0),
    'week_starts_at', v_week_start,
    'resets_at', v_week_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_interview_quota_status()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_interview_quota_status()
  TO authenticated;


-- Enforce interview permission inside the session-start operation.
-- Optional p_resume_session_id reopens an in-progress session without consuming quota.
--
-- Resume policy (INT-006): only sessions with status = 'started' AND started_at in the
-- current IST quota window [week_start, week_end) may be resumed. Older in-progress rows
-- are not resumable; the client must start a new session (which consumes quota if available).
CREATE OR REPLACE FUNCTION public.start_interview_with_quota(
  p_resume_session_id uuid DEFAULT NULL
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
    date_trunc(
      'week',
      now() AT TIME ZONE 'Asia/Kolkata'
    ) AT TIME ZONE 'Asia/Kolkata';

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
    SELECT s.id, s.status
      INTO v_session_id, v_session_status
      FROM public.interview_sessions s
     WHERE s.id = p_resume_session_id
       AND s.user_id = v_user_id
       AND s.status = 'started'
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

  INSERT INTO public.interview_sessions (user_id, status)
  VALUES (v_user_id, 'started')
  RETURNING id INTO v_session_id;

  v_used := v_used + 1;

  RETURN jsonb_build_object(
    'session_id', v_session_id,
    'status', 'started',
    'weekly_limit', v_limit,
    'limit', v_limit,
    'used', v_used,
    'remaining', greatest(v_limit - v_used, 0),
    'week_starts_at', v_week_start,
    'resets_at', v_week_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_interview_with_quota(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_interview_with_quota(uuid)
  TO authenticated;

-- Staff: update the global weekly mock interview limit (positive integer only).
CREATE OR REPLACE FUNCTION public.set_interview_weekly_quota_limit(p_weekly_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '28000';
  END IF;

  IF NOT public.has_permission('interview_quota.manage') THEN
    RAISE EXCEPTION 'Interview quota management denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_weekly_limit IS NULL OR p_weekly_limit <= 0 THEN
    RAISE EXCEPTION 'Weekly limit must be a positive integer'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.interview_quota_config
     SET weekly_limit = p_weekly_limit,
         updated_at = now(),
         updated_by = v_user_id
   WHERE id = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Interview quota configuration is missing or invalid'
      USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'weekly_limit', p_weekly_limit,
    'updated_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_interview_weekly_quota_limit(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_interview_weekly_quota_limit(integer)
  TO authenticated;
