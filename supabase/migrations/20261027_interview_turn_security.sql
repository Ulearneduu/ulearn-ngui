-- INT-005. Approved. Apply only this file.
-- Do not use supabase db push: other local migrations are not in the remote history.
-- interview_turns had no client_turn_id column when this file was written.
-- Depends on interview_sessions, interview_templates, and interview_turns.
-- The old insert policy is dropped so it cannot OR with the new one.

ALTER TABLE public.interview_turns
  ADD COLUMN IF NOT EXISTS client_turn_id uuid;

ALTER TABLE public.interview_turns
  DROP CONSTRAINT IF EXISTS interview_turns_client_turn_role;

ALTER TABLE public.interview_turns
  ADD CONSTRAINT interview_turns_client_turn_role
  CHECK (client_turn_id IS NULL OR role = 'user');

CREATE UNIQUE INDEX IF NOT EXISTS interview_turns_session_client_turn
  ON public.interview_turns (session_id, client_turn_id)
  WHERE client_turn_id IS NOT NULL;

-- Reads duration from the template. SECURITY DEFINER is required because a
-- student cannot select an unpublished template, and an invoker query would
-- reject a legitimate in-progress session. The function returns NEW or raises.
-- It does not return session or template contents.
-- current_user inside a definer function is the owner, so the trusted-role
-- check uses auth.role() and session_user. Status and expiry apply to every
-- role. Ownership is skipped only when there is no student JWT.
CREATE OR REPLACE FUNCTION public.interview_turns_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  session_user_id uuid;
  session_status text;
  session_started_at timestamptz;
  template_duration integer;
  trusted boolean;
BEGIN
  SELECT s.user_id, s.status, s.started_at, t.duration_minutes
    INTO session_user_id, session_status, session_started_at, template_duration
  FROM public.interview_sessions AS s
  JOIN public.interview_templates AS t ON t.id = s.template_id
  WHERE s.id = NEW.session_id
  FOR SHARE OF s;

  trusted := coalesce(auth.role(), '') = 'service_role'
    OR session_user IN ('postgres', 'supabase_admin');

  IF NOT FOUND
     OR template_duration IS NULL
     OR template_duration <= 0
     OR session_started_at IS NULL
     OR (NOT trusted AND session_user_id IS DISTINCT FROM auth.uid())
  THEN
    RAISE EXCEPTION 'interview turn is not allowed'
      USING ERRCODE = '42501';
  END IF;

  IF NOT trusted AND NEW.role IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'interview assistant turns are written by the interview service'
      USING ERRCODE = '42501';
  END IF;

  IF session_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'interview turns cannot be added to a finished session'
      USING ERRCODE = '42501';
  END IF;

  IF session_started_at + make_interval(mins => template_duration) <= now() THEN
    RAISE EXCEPTION 'interview turns cannot be added after the session duration'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.interview_turns_insert_guard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.interview_turns_insert_guard() TO authenticated, service_role;

DROP TRIGGER IF EXISTS interview_turns_insert_guard ON public.interview_turns;
CREATE TRIGGER interview_turns_insert_guard
  BEFORE INSERT ON public.interview_turns
  FOR EACH ROW
  EXECUTE FUNCTION public.interview_turns_insert_guard();

-- Keep the existing BEFORE UPDATE trigger and freeze identity columns.
-- Students lose UPDATE and DELETE below. The service role bypasses RLS.
CREATE OR REPLACE FUNCTION public.interview_turns_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.role IS DISTINCT FROM OLD.role
       OR NEW.seq IS DISTINCT FROM OLD.seq
       OR NEW.client_turn_id IS DISTINCT FROM OLD.client_turn_id
     )
  THEN
    RAISE EXCEPTION 'interview turn identity cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

-- One insert policy. Students may add their own user turns only while the
-- session is in_progress. Expiry and assistant-role denial are in the trigger,
-- because duration lives on the template and the service role bypasses RLS.
DROP POLICY IF EXISTS "Users insert turns in own sessions" ON public.interview_turns;
DROP POLICY IF EXISTS "Users insert own user turns in open sessions" ON public.interview_turns;
CREATE POLICY "Users insert own user turns in open sessions"
ON public.interview_turns
FOR INSERT
TO authenticated
WITH CHECK (
  role = 'user'
  AND EXISTS (
    SELECT 1
    FROM public.interview_sessions AS s
    WHERE s.id = interview_turns.session_id
      AND s.user_id = auth.uid()
      AND s.status = 'in_progress'
  )
);

DROP POLICY IF EXISTS "Users update turns in own sessions" ON public.interview_turns;
DROP POLICY IF EXISTS "Users delete turns in own sessions" ON public.interview_turns;

REVOKE UPDATE, DELETE ON TABLE public.interview_turns FROM authenticated;

-- "Users read turns in own sessions" stays. Session ownership policies stay.

-- One row per answer attempt. The primary key is the lock across Edge
-- Function instances. Students cannot read or write claims. The service role
-- bypasses row level security after the function has checked the caller.
CREATE TABLE IF NOT EXISTS public.interview_turn_claims (
  session_id uuid NOT NULL REFERENCES public.interview_sessions (id) ON DELETE CASCADE,
  client_turn_id uuid NOT NULL,
  user_id uuid NOT NULL,
  answer text NOT NULL,
  status text NOT NULL,
  assistant_text text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_turn_claims_pkey PRIMARY KEY (session_id, client_turn_id),
  CONSTRAINT interview_turn_claims_status_check CHECK (status IN ('processing', 'completed', 'failed')),
  CONSTRAINT interview_turn_claims_answer_len CHECK (char_length(answer) BETWEEN 1 AND 8000)
);

ALTER TABLE public.interview_turn_claims ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.interview_turn_claims FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.interview_turn_claims TO service_role;
