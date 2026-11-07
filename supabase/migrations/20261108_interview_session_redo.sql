-- INT-011: Link a redo attempt to its parent interview session.
-- Depends on INT-002 sessions, INT-008 evaluation columns, INT-009 template_version_id.
-- Do not apply to the shared Supabase project without approval.

DO $$
BEGIN
  IF to_regclass('public.interview_sessions') IS NULL THEN
    RAISE EXCEPTION 'interview_sessions is required before INT-011 redo';
  END IF;
END $$;

ALTER TABLE public.interview_sessions
  ADD COLUMN IF NOT EXISTS redo_of_session_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'interview_sessions_redo_of_session_id_fkey'
      AND conrelid = 'public.interview_sessions'::regclass
  ) THEN
    ALTER TABLE public.interview_sessions
      ADD CONSTRAINT interview_sessions_redo_of_session_id_fkey
      FOREIGN KEY (redo_of_session_id)
      REFERENCES public.interview_sessions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'interview_sessions_redo_not_self'
      AND conrelid = 'public.interview_sessions'::regclass
  ) THEN
    ALTER TABLE public.interview_sessions
      ADD CONSTRAINT interview_sessions_redo_not_self
      CHECK (redo_of_session_id IS NULL OR redo_of_session_id IS DISTINCT FROM id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_interview_sessions_redo_of
  ON public.interview_sessions (redo_of_session_id)
  WHERE redo_of_session_id IS NOT NULL;

-- Combined session guard: INT-008 evaluation fields, INT-009 version pin, INT-011 redo link.
CREATE OR REPLACE FUNCTION public.interview_sessions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trusted boolean := current_user IN ('service_role', 'postgres', 'supabase_admin');
  v_parent public.interview_sessions%rowtype;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'interview session ownership cannot be changed';
  END IF;

  IF v_trusted THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'interview session user_id must be the signed-in user';
    END IF;
    IF NEW.status IS DISTINCT FROM 'in_progress' THEN
      RAISE EXCEPTION 'interview sessions must start in progress';
    END IF;
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'interview sessions cannot be ended at creation';
    END IF;
    IF NEW.overall_score IS NOT NULL THEN
      RAISE EXCEPTION 'overall_score is written by the evaluator';
    END IF;
    IF NEW.evaluation_status IS NOT NULL
       OR NEW.eval_version IS NOT NULL
       OR NEW.evaluated_at IS NOT NULL
       OR NEW.evaluation_summary IS NOT NULL
       OR NEW.evaluation_claimed_at IS NOT NULL
       OR NEW.evaluation_strengths IS DISTINCT FROM '[]'::jsonb
       OR NEW.evaluation_improvements IS DISTINCT FROM '[]'::jsonb
    THEN
      RAISE EXCEPTION 'interview evaluation is written by the evaluator';
    END IF;

    IF NEW.redo_of_session_id IS NOT NULL THEN
      IF NEW.redo_of_session_id IS NOT DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'interview session cannot redo itself';
      END IF;

      SELECT * INTO v_parent
      FROM public.interview_sessions AS s
      WHERE s.id = NEW.redo_of_session_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'interview redo parent session was not found';
      END IF;
      IF v_parent.user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'interview redo parent must belong to the signed-in user';
      END IF;
      IF v_parent.template_id IS DISTINCT FROM NEW.template_id THEN
        RAISE EXCEPTION 'interview redo parent must use the same template';
      END IF;
      IF v_parent.status IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'interview redo parent must be completed';
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.template_id IS DISTINCT FROM OLD.template_id THEN
      RAISE EXCEPTION 'interview session template cannot be changed';
    END IF;
    IF NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'interview session start time cannot be changed';
    END IF;
    IF NEW.prompt_version IS DISTINCT FROM OLD.prompt_version THEN
      RAISE EXCEPTION 'interview session prompt version cannot be changed';
    END IF;
    IF NEW.template_version_id IS DISTINCT FROM OLD.template_version_id THEN
      RAISE EXCEPTION 'interview session template version cannot be changed';
    END IF;
    IF NEW.redo_of_session_id IS DISTINCT FROM OLD.redo_of_session_id THEN
      RAISE EXCEPTION 'interview session redo link cannot be changed';
    END IF;
    IF NEW.overall_score IS DISTINCT FROM OLD.overall_score THEN
      RAISE EXCEPTION 'overall_score is written by the evaluator';
    END IF;
    IF NEW.evaluation_status IS DISTINCT FROM OLD.evaluation_status
       OR NEW.eval_version IS DISTINCT FROM OLD.eval_version
       OR NEW.evaluated_at IS DISTINCT FROM OLD.evaluated_at
       OR NEW.evaluation_summary IS DISTINCT FROM OLD.evaluation_summary
       OR NEW.evaluation_strengths IS DISTINCT FROM OLD.evaluation_strengths
       OR NEW.evaluation_improvements IS DISTINCT FROM OLD.evaluation_improvements
       OR NEW.evaluation_claimed_at IS DISTINCT FROM OLD.evaluation_claimed_at
    THEN
      RAISE EXCEPTION 'interview evaluation is written by the evaluator';
    END IF;
    IF OLD.status <> 'in_progress' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'a finished interview session cannot change status';
    END IF;
    IF NEW.status IN ('completed', 'failed') AND NEW.ended_at IS NULL THEN
      RAISE EXCEPTION 'ending an interview session requires ended_at';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION public.interview_sessions_guard() TO authenticated, service_role;
