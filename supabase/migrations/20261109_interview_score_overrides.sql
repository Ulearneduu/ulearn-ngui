-- INT-015: mentor review queue + append-only score overrides.
-- Apply only this file to a disposable or approved database. Do not run supabase db push.
-- Do not apply this file to production without explicit approval.
--
-- AI evaluation remains immutable:
--   - interview_scores rows are never updated by mentor overrides
--   - interview_sessions.overall_score stays the AI mean
-- Mentor adjustments are stored in interview_score_overrides (append-only).
-- Students see effective scores only when mentor_review_published is true.
-- Staff access is via SECURITY DEFINER RPCs gated by has_permission('interview.reviews').

DO $$
BEGIN
  IF to_regclass('public.interview_sessions') IS NULL
     OR to_regclass('public.interview_scores') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'INT-008 interview tables and profiles are required before INT-015';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Session publish flag (students cannot write this; RPC does).
-- ---------------------------------------------------------------------------

ALTER TABLE public.interview_sessions
  ADD COLUMN IF NOT EXISTS mentor_review_published boolean NOT NULL DEFAULT false;

-- Restore/extend session guard: keep INT-008 evaluator protections (lost when
-- INT-009 rewrote this function) and block client writes to mentor_review_published.
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
    IF NEW.mentor_review_published IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'mentor review publish state is written by reviewers';
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
    IF NEW.mentor_review_published IS DISTINCT FROM OLD.mentor_review_published THEN
      RAISE EXCEPTION 'mentor review publish state is written by reviewers';
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

REVOKE UPDATE (mentor_review_published) ON TABLE public.interview_sessions FROM authenticated;

-- ---------------------------------------------------------------------------
-- Override audit table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.interview_score_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
  mentor_id uuid NOT NULL REFERENCES public.profiles(id),
  target_kind text NOT NULL,
  competency text NULL,
  eval_version text NOT NULL,
  old_score numeric(5,2) NOT NULL,
  new_score numeric(5,2) NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_score_overrides_target_kind_check
    CHECK (target_kind IN ('overall', 'competency')),
  CONSTRAINT interview_score_overrides_old_score_valid
    CHECK (old_score >= 0 AND old_score <= 100),
  CONSTRAINT interview_score_overrides_new_score_valid
    CHECK (new_score >= 0 AND new_score <= 100),
  CONSTRAINT interview_score_overrides_reason_min
    CHECK (char_length(btrim(reason)) >= 10),
  CONSTRAINT interview_score_overrides_target_shape
    CHECK (
      (target_kind = 'overall' AND competency IS NULL)
      OR (
        target_kind = 'competency'
        AND competency IS NOT NULL
        AND char_length(btrim(competency)) > 0
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_interview_score_overrides_session_created
  ON public.interview_score_overrides (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_interview_score_overrides_session_target
  ON public.interview_score_overrides (session_id, target_kind, competency, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_interview_sessions_review_queue
  ON public.interview_sessions (ended_at DESC)
  WHERE status = 'completed' AND evaluation_status = 'completed';

-- Append-only while the parent session exists:
--   UPDATE is always rejected.
--   Direct DELETE is rejected when the parent interview_sessions row still exists.
--   ON DELETE CASCADE is allowed: PostgreSQL RI deletes children after the parent
--   row is already gone, so EXISTS(parent) is false during cascade cleanup.
-- Authenticated clients also lack DELETE privilege (SELECT-only grant below).
CREATE OR REPLACE FUNCTION public.interview_score_overrides_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'interview score override history cannot be changed';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM public.interview_sessions AS s
      WHERE s.id = OLD.session_id
    ) THEN
      RAISE EXCEPTION 'interview score override history cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS interview_score_overrides_guard ON public.interview_score_overrides;
CREATE TRIGGER interview_score_overrides_guard
  BEFORE UPDATE OR DELETE ON public.interview_score_overrides
  FOR EACH ROW
  EXECUTE FUNCTION public.interview_score_overrides_guard();

ALTER TABLE public.interview_score_overrides ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.interview_score_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.interview_score_overrides TO authenticated;
GRANT ALL ON TABLE public.interview_score_overrides TO service_role;

-- Students may read override rows only for their own published reviews.
-- Staff never get broad SELECT; they use SECURITY DEFINER RPCs.
DROP POLICY IF EXISTS "Students read published overrides for own sessions"
  ON public.interview_score_overrides;
CREATE POLICY "Students read published overrides for own sessions"
ON public.interview_score_overrides
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.interview_sessions AS s
    WHERE s.id = interview_score_overrides.session_id
      AND s.user_id = auth.uid()
      AND s.mentor_review_published = true
  )
);

GRANT EXECUTE ON FUNCTION public.interview_score_overrides_guard() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Effective score helpers (SQL, used by RPCs)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.interview_effective_competency_score(
  p_session_id uuid,
  p_competency text,
  p_eval_version text
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_override numeric;
  v_ai numeric;
BEGIN
  SELECT o.new_score
    INTO v_override
  FROM public.interview_score_overrides AS o
  WHERE o.session_id = p_session_id
    AND o.target_kind = 'competency'
    AND o.competency = p_competency
    AND o.eval_version = p_eval_version
  ORDER BY o.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN v_override;
  END IF;

  SELECT s.score
    INTO v_ai
  FROM public.interview_scores AS s
  WHERE s.session_id = p_session_id
    AND s.competency = p_competency
    AND s.eval_version = p_eval_version;

  RETURN v_ai;
END;
$$;

CREATE OR REPLACE FUNCTION public.interview_effective_overall_score(
  p_session_id uuid,
  p_eval_version text
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_override numeric;
  v_mean numeric;
BEGIN
  SELECT o.new_score
    INTO v_override
  FROM public.interview_score_overrides AS o
  WHERE o.session_id = p_session_id
    AND o.target_kind = 'overall'
    AND o.competency IS NULL
    AND o.eval_version = p_eval_version
  ORDER BY o.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN v_override;
  END IF;

  SELECT round(avg(public.interview_effective_competency_score(
           p_session_id,
           s.competency,
           p_eval_version
         )), 2)
    INTO v_mean
  FROM public.interview_scores AS s
  WHERE s.session_id = p_session_id
    AND s.eval_version = p_eval_version;

  RETURN v_mean;
END;
$$;

-- Helpers are for SECURITY DEFINER review RPCs only — not for direct client calls.
REVOKE ALL ON FUNCTION public.interview_effective_competency_score(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.interview_effective_overall_score(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.interview_effective_competency_score(uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.interview_effective_overall_score(uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.interview_review_session_eligible(p_session public.interview_sessions)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_session.status = 'completed'
    AND p_session.evaluation_status = 'completed'
    AND p_session.eval_version IS NOT NULL
    AND btrim(p_session.eval_version) <> ''
    AND p_session.overall_score IS NOT NULL;
$$;

-- ---------------------------------------------------------------------------
-- Staff review RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_interview_review_queue()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in again to review interviews.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission('interview.reviews') THEN
    RAISE EXCEPTION 'You do not have permission to review interviews.' USING ERRCODE = '42501';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(row_data ORDER BY ended_at DESC NULLS LAST)
    FROM (
      SELECT
        jsonb_build_object(
          'sessionId', s.id,
          'studentId', s.user_id,
          'studentName', coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''), 'Student'),
          'studentEmail', p.email,
          'templateId', s.template_id,
          'templateTitle', coalesce(t.title, 'Interview'),
          'templateKind', t.kind,
          'status', s.status,
          'evaluationStatus', s.evaluation_status,
          'evalVersion', s.eval_version,
          'aiOverallScore', s.overall_score,
          'effectiveOverallScore', public.interview_effective_overall_score(s.id, s.eval_version),
          'mentorReviewPublished', s.mentor_review_published,
          'startedAt', s.started_at,
          'endedAt', s.ended_at,
          'evaluatedAt', s.evaluated_at
        ) AS row_data,
        s.ended_at
      FROM public.interview_sessions AS s
      LEFT JOIN public.profiles AS p ON p.id = s.user_id
      LEFT JOIN public.interview_templates AS t ON t.id = s.template_id
      WHERE s.status = 'completed'
        AND s.evaluation_status = 'completed'
        AND s.eval_version IS NOT NULL
        AND s.overall_score IS NOT NULL
      ORDER BY s.ended_at DESC NULLS LAST
      LIMIT 200
    ) AS q
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_interview_review_detail(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.interview_sessions%ROWTYPE;
  v_student jsonb;
  v_template jsonb;
  v_turns jsonb;
  v_scores jsonb;
  v_overrides jsonb;
  v_effective_competencies jsonb;
  v_effective_overall numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in again to review interviews.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission('interview.reviews') THEN
    RAISE EXCEPTION 'You do not have permission to review interviews.' USING ERRCODE = '42501';
  END IF;
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'Interview session is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session
  FROM public.interview_sessions
  WHERE id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Interview session not found.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.interview_review_session_eligible(v_session) THEN
    RAISE EXCEPTION 'Only completed and evaluated interviews can be reviewed.'
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
           'id', p.id,
           'name', coalesce(nullif(btrim(p.full_name), ''), 'Student'),
           'email', p.email
         )
    INTO v_student
  FROM public.profiles AS p
  WHERE p.id = v_session.user_id;

  SELECT jsonb_build_object(
           'id', t.id,
           'title', t.title,
           'kind', t.kind,
           'durationMinutes', t.duration_minutes
         )
    INTO v_template
  FROM public.interview_templates AS t
  WHERE t.id = v_session.template_id;

  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'id', tr.id,
             'role', tr.role,
             'content', tr.content,
             'seq', tr.seq,
             'createdAt', tr.created_at
           ) ORDER BY tr.seq
         ), '[]'::jsonb)
    INTO v_turns
  FROM public.interview_turns AS tr
  WHERE tr.session_id = v_session.id;

  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'id', sc.id,
             'competency', sc.competency,
             'score', sc.score,
             'feedback', sc.rationale,
             'evidence', sc.evidence,
             'evalVersion', sc.eval_version
           ) ORDER BY sc.created_at, sc.competency
         ), '[]'::jsonb)
    INTO v_scores
  FROM public.interview_scores AS sc
  WHERE sc.session_id = v_session.id
    AND sc.eval_version = v_session.eval_version;

  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'id', o.id,
             'targetKind', o.target_kind,
             'competency', o.competency,
             'evalVersion', o.eval_version,
             'oldScore', o.old_score,
             'newScore', o.new_score,
             'reason', o.reason,
             'mentorId', o.mentor_id,
             'mentorName', coalesce(nullif(btrim(mp.full_name), ''), nullif(btrim(mp.email), ''), 'Reviewer'),
             'createdAt', o.created_at
           ) ORDER BY o.created_at ASC
         ), '[]'::jsonb)
    INTO v_overrides
  FROM public.interview_score_overrides AS o
  LEFT JOIN public.profiles AS mp ON mp.id = o.mentor_id
  WHERE o.session_id = v_session.id;

  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'competency', sc.competency,
             'aiScore', sc.score,
             'effectiveScore', public.interview_effective_competency_score(
               v_session.id, sc.competency, v_session.eval_version
             ),
             'feedback', sc.rationale,
             'evidence', sc.evidence
           ) ORDER BY sc.created_at, sc.competency
         ), '[]'::jsonb)
    INTO v_effective_competencies
  FROM public.interview_scores AS sc
  WHERE sc.session_id = v_session.id
    AND sc.eval_version = v_session.eval_version;

  v_effective_overall := public.interview_effective_overall_score(
    v_session.id,
    v_session.eval_version
  );

  RETURN jsonb_build_object(
    'sessionId', v_session.id,
    'student', coalesce(v_student, jsonb_build_object('id', v_session.user_id, 'name', 'Student', 'email', null)),
    'template', coalesce(v_template, jsonb_build_object('id', v_session.template_id, 'title', 'Interview', 'kind', null, 'durationMinutes', null)),
    'status', v_session.status,
    'evaluationStatus', v_session.evaluation_status,
    'evalVersion', v_session.eval_version,
    'promptVersion', v_session.prompt_version,
    'startedAt', v_session.started_at,
    'endedAt', v_session.ended_at,
    'evaluatedAt', v_session.evaluated_at,
    'summary', v_session.evaluation_summary,
    'strengths', coalesce(v_session.evaluation_strengths, '[]'::jsonb),
    'improvements', coalesce(v_session.evaluation_improvements, '[]'::jsonb),
    'aiOverallScore', v_session.overall_score,
    'effectiveOverallScore', v_effective_overall,
    'mentorReviewPublished', v_session.mentor_review_published,
    'turns', v_turns,
    'aiCompetencies', v_scores,
    'effectiveCompetencies', v_effective_competencies,
    'overrides', v_overrides
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_interview_score_override(
  p_session_id uuid,
  p_target_kind text,
  p_competency text,
  p_new_score numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.interview_sessions%ROWTYPE;
  v_kind text := lower(btrim(coalesce(p_target_kind, '')));
  v_competency text := nullif(btrim(coalesce(p_competency, '')), '');
  v_reason text := btrim(coalesce(p_reason, ''));
  v_new numeric;
  v_old numeric;
  v_ai_exists boolean;
  v_row public.interview_score_overrides%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in again to review interviews.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission('interview.reviews') THEN
    RAISE EXCEPTION 'You do not have permission to review interviews.' USING ERRCODE = '42501';
  END IF;
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'Interview session is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session
  FROM public.interview_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Interview session not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_session.status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'Only a completed interview can receive a score override.'
      USING ERRCODE = '22023';
  END IF;
  IF NOT public.interview_review_session_eligible(v_session) THEN
    RAISE EXCEPTION 'Only a successfully evaluated interview can receive a score override.'
      USING ERRCODE = '22023';
  END IF;

  IF v_kind IS DISTINCT FROM 'overall' AND v_kind IS DISTINCT FROM 'competency' THEN
    RAISE EXCEPTION 'Override target must be overall or competency.' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_new := round(p_new_score, 2);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Score must be a number between 0 and 100.' USING ERRCODE = '22023';
  END;

  IF v_new IS NULL OR v_new < 0 OR v_new > 100 THEN
    RAISE EXCEPTION 'Score must be between 0 and 100.' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.' USING ERRCODE = '22023';
  END IF;

  IF v_kind = 'overall' THEN
    IF v_competency IS NOT NULL THEN
      RAISE EXCEPTION 'Overall overrides cannot name a competency.' USING ERRCODE = '22023';
    END IF;
    v_old := public.interview_effective_overall_score(v_session.id, v_session.eval_version);
  ELSE
    IF v_competency IS NULL THEN
      RAISE EXCEPTION 'Competency overrides require a competency name.' USING ERRCODE = '22023';
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.interview_scores AS sc
      WHERE sc.session_id = v_session.id
        AND sc.eval_version = v_session.eval_version
        AND sc.competency = v_competency
    ) INTO v_ai_exists;
    IF NOT v_ai_exists THEN
      RAISE EXCEPTION 'That competency is not part of the AI evaluation.'
        USING ERRCODE = '22023';
    END IF;
    v_old := public.interview_effective_competency_score(
      v_session.id,
      v_competency,
      v_session.eval_version
    );
  END IF;

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'The current score could not be determined.' USING ERRCODE = '22023';
  END IF;

  IF v_new = v_old THEN
    RAISE EXCEPTION 'The new score must differ from the current effective score.'
      USING ERRCODE = '22023';
  END IF;

  -- mentor_id is always the authenticated reviewer. Client-supplied ids are ignored.
  INSERT INTO public.interview_score_overrides (
    session_id,
    mentor_id,
    target_kind,
    competency,
    eval_version,
    old_score,
    new_score,
    reason
  )
  VALUES (
    v_session.id,
    v_uid,
    v_kind,
    CASE WHEN v_kind = 'competency' THEN v_competency ELSE NULL END,
    v_session.eval_version,
    v_old,
    v_new,
    v_reason
  )
  RETURNING * INTO v_row;

  -- Prove AI baseline was not mutated by this write path.
  IF (
    SELECT overall_score
    FROM public.interview_sessions
    WHERE id = v_session.id
  ) IS DISTINCT FROM v_session.overall_score THEN
    RAISE EXCEPTION 'AI overall score must remain unchanged' USING ERRCODE = 'XX000';
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'sessionId', v_row.session_id,
    'mentorId', v_row.mentor_id,
    'targetKind', v_row.target_kind,
    'competency', v_row.competency,
    'evalVersion', v_row.eval_version,
    'oldScore', v_row.old_score,
    'newScore', v_row.new_score,
    'reason', v_row.reason,
    'createdAt', v_row.created_at,
    'aiOverallScore', v_session.overall_score,
    'effectiveOverallScore', public.interview_effective_overall_score(
      v_session.id,
      v_session.eval_version
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_interview_mentor_review_published(
  p_session_id uuid,
  p_published boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.interview_sessions%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in again to review interviews.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission('interview.reviews') THEN
    RAISE EXCEPTION 'You do not have permission to review interviews.' USING ERRCODE = '42501';
  END IF;
  IF p_session_id IS NULL OR p_published IS NULL THEN
    RAISE EXCEPTION 'Session and publish state are required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session
  FROM public.interview_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Interview session not found.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.interview_review_session_eligible(v_session) THEN
    RAISE EXCEPTION 'Only completed and evaluated interviews can publish mentor review.'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.interview_sessions
  SET mentor_review_published = p_published
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'sessionId', v_session.id,
    'mentorReviewPublished', v_session.mentor_review_published,
    'aiOverallScore', v_session.overall_score,
    'effectiveOverallScore', public.interview_effective_overall_score(
      v_session.id,
      v_session.eval_version
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.list_interview_review_queue() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_interview_review_detail(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_interview_score_override(uuid, text, text, numeric, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_interview_mentor_review_published(uuid, boolean)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.interview_review_session_eligible(public.interview_sessions)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.list_interview_review_queue() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_interview_review_detail(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_interview_score_override(uuid, text, text, numeric, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_interview_mentor_review_published(uuid, boolean)
  TO authenticated, service_role;
