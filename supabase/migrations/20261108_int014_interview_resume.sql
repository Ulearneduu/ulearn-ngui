-- INT-014: optional resume context on the student's own interview session.
-- Apply only this file to a disposable or approved database. Do not run supabase db push.
-- Do not apply this file to production project yllfccuxohnipleyseup.
--
-- Resume text is a column on interview_sessions so it follows the existing owner
-- RLS policies and is deleted with the session (including ON DELETE CASCADE from auth.users).
-- Students may set resume_text only when they create the session.
-- resume_summary and resume_question_log are written by the interview service role.

ALTER TABLE public.interview_sessions
  ADD COLUMN IF NOT EXISTS resume_text text,
  ADD COLUMN IF NOT EXISTS resume_summary text,
  ADD COLUMN IF NOT EXISTS resume_question_log jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.interview_sessions
  DROP CONSTRAINT IF EXISTS interview_sessions_resume_text_len;

ALTER TABLE public.interview_sessions
  ADD CONSTRAINT interview_sessions_resume_text_len
  CHECK (resume_text IS NULL OR char_length(btrim(resume_text)) BETWEEN 1 AND 8000);

ALTER TABLE public.interview_sessions
  DROP CONSTRAINT IF EXISTS interview_sessions_resume_summary_len;

ALTER TABLE public.interview_sessions
  ADD CONSTRAINT interview_sessions_resume_summary_len
  CHECK (resume_summary IS NULL OR char_length(btrim(resume_summary)) BETWEEN 1 AND 4000);

ALTER TABLE public.interview_sessions
  DROP CONSTRAINT IF EXISTS interview_sessions_resume_question_log_array;

ALTER TABLE public.interview_sessions
  ADD CONSTRAINT interview_sessions_resume_question_log_array
  CHECK (
    jsonb_typeof(resume_question_log) = 'array'
    AND jsonb_array_length(resume_question_log) <= 40
  );

COMMENT ON COLUMN public.interview_sessions.resume_text IS
  'INT-014 optional resume text supplied by the session owner at start. Not a URL.';
COMMENT ON COLUMN public.interview_sessions.resume_summary IS
  'INT-014 server-prepared resume summary reused for later interview turns.';
COMMENT ON COLUMN public.interview_sessions.resume_question_log IS
  'INT-014 server record of resume-grounded questions already asked.';

-- Preserve INT-008 evaluator locks and INT-009 template snapshot locks, and
-- freeze resume fields after insert for any role that is not the service role.
CREATE OR REPLACE FUNCTION public.interview_sessions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trusted boolean := current_user IN ('service_role', 'postgres', 'supabase_admin');
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
    IF NEW.resume_summary IS NOT NULL
       OR NEW.resume_question_log IS DISTINCT FROM '[]'::jsonb
    THEN
      RAISE EXCEPTION 'resume summary and question tracking are written by the interview service';
    END IF;
    IF NEW.resume_text IS NOT NULL AND char_length(btrim(NEW.resume_text)) = 0 THEN
      RAISE EXCEPTION 'resume text cannot be blank';
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
    IF NEW.resume_text IS DISTINCT FROM OLD.resume_text
       OR NEW.resume_summary IS DISTINCT FROM OLD.resume_summary
       OR NEW.resume_question_log IS DISTINCT FROM OLD.resume_question_log
    THEN
      RAISE EXCEPTION 'resume context is written by the interview service';
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

REVOKE UPDATE (
  resume_text,
  resume_summary,
  resume_question_log
) ON TABLE public.interview_sessions FROM authenticated;

REVOKE INSERT (
  resume_summary,
  resume_question_log
) ON TABLE public.interview_sessions FROM authenticated;
