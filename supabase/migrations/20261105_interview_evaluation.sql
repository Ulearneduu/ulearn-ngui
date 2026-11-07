-- INT-008: persist mock-interview evaluation without changing INT-005 turn rules.
-- Apply only this file to a disposable or approved database. Do not run supabase db push.
-- Do not apply this file to production without explicit approval.
--
-- interview_scores already exists from INT-002. Feedback is stored in rationale.
-- evidence and created_at are added. The unique key (session_id, competency, eval_version)
-- keeps a retry from inserting a second row for the same version, and it keeps an
-- older version when a later rubric version is stored for a new evaluation.
-- Score values are immutable after insert, including for service_role.
--
-- Overall score is the unweighted arithmetic mean of the competency scores stored
-- for that session and eval_version, rounded to 2 decimal places. Competencies the
-- evaluator omitted as not applicable are not inserted and are not part of the mean.
-- The AI-supplied overall score is never written.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'interview_sessions'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'interview_scores'
  ) THEN
    RAISE EXCEPTION 'INT-002 interview tables are missing; refusing to continue';
  END IF;
END $$;

ALTER TABLE public.interview_sessions
  ADD COLUMN IF NOT EXISTS evaluation_status text,
  ADD COLUMN IF NOT EXISTS eval_version text,
  ADD COLUMN IF NOT EXISTS evaluated_at timestamptz,
  ADD COLUMN IF NOT EXISTS evaluation_summary text,
  ADD COLUMN IF NOT EXISTS evaluation_strengths jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS evaluation_improvements jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS evaluation_claimed_at timestamptz;

ALTER TABLE public.interview_sessions
  DROP CONSTRAINT IF EXISTS interview_sessions_evaluation_status_check;

ALTER TABLE public.interview_sessions
  ADD CONSTRAINT interview_sessions_evaluation_status_check
  CHECK (
    evaluation_status IS NULL
    OR evaluation_status IN ('pending', 'processing', 'completed', 'failed')
  );

ALTER TABLE public.interview_sessions
  DROP CONSTRAINT IF EXISTS interview_sessions_evaluation_json_check;

ALTER TABLE public.interview_sessions
  ADD CONSTRAINT interview_sessions_evaluation_json_check
  CHECK (
    jsonb_typeof(evaluation_strengths) = 'array'
    AND jsonb_typeof(evaluation_improvements) = 'array'
  );

ALTER TABLE public.interview_sessions
  DROP CONSTRAINT IF EXISTS interview_sessions_evaluation_complete_check;

ALTER TABLE public.interview_sessions
  ADD CONSTRAINT interview_sessions_evaluation_complete_check
  CHECK (
    evaluation_status IS DISTINCT FROM 'completed'
    OR (
      overall_score IS NOT NULL
      AND eval_version IS NOT NULL
      AND evaluated_at IS NOT NULL
      AND evaluation_summary IS NOT NULL
    )
  );

ALTER TABLE public.interview_scores
  ADD COLUMN IF NOT EXISTS evidence text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Students can finish a session, but they cannot write evaluator fields.
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

-- Authenticated students still cannot insert or update scores.
-- No role can change a stored score, competency, rationale, evidence, or version.
CREATE OR REPLACE FUNCTION public.interview_scores_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated' AND TG_OP IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION 'interview scores are written by the evaluator';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.competency IS DISTINCT FROM OLD.competency
    OR NEW.score IS DISTINCT FROM OLD.score
    OR NEW.rationale IS DISTINCT FROM OLD.rationale
    OR NEW.evidence IS DISTINCT FROM OLD.evidence
    OR NEW.eval_version IS DISTINCT FROM OLD.eval_version
  ) THEN
    RAISE EXCEPTION 'interview score history cannot be changed';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.interview_scores FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.interview_scores TO authenticated;
GRANT ALL ON TABLE public.interview_scores TO service_role;

REVOKE UPDATE (
  overall_score,
  evaluation_status,
  eval_version,
  evaluated_at,
  evaluation_summary,
  evaluation_strengths,
  evaluation_improvements,
  evaluation_claimed_at
) ON TABLE public.interview_sessions FROM authenticated;

-- Existing owner read policy stays the student boundary. Recreate it only if missing
-- so this migration does not leave a session without its INT-002 read rule.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'interview_scores'
      AND policyname = 'Users read scores in own sessions'
  ) THEN
    CREATE POLICY "Users read scores in own sessions"
    ON public.interview_scores
    FOR SELECT
    TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.interview_sessions AS s
        WHERE s.id = interview_scores.session_id
          AND s.user_id = auth.uid()
      )
    );
  END IF;
END $$;

DROP POLICY IF EXISTS "Users insert scores in own sessions" ON public.interview_scores;
DROP POLICY IF EXISTS "Users update scores in own sessions" ON public.interview_scores;
DROP POLICY IF EXISTS "Users delete scores in own sessions" ON public.interview_scores;

CREATE OR REPLACE FUNCTION public.interview_evaluation_is_trusted()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(auth.role(), '') = 'service_role'
    OR session_user IN ('postgres', 'supabase_admin');
$$;

REVOKE ALL ON FUNCTION public.interview_evaluation_is_trusted() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.interview_evaluation_is_trusted() TO service_role;

CREATE OR REPLACE FUNCTION public.claim_interview_evaluation(
  p_session_id uuid,
  p_eval_version text
)
RETURNS TABLE (
  outcome text,
  evaluation_status text,
  eval_version text,
  overall_score numeric,
  claimed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.interview_sessions%rowtype;
BEGIN
  IF NOT public.interview_evaluation_is_trusted() THEN
    RAISE EXCEPTION 'interview evaluation is written by the evaluator' USING ERRCODE = '42501';
  END IF;

  IF p_eval_version IS NULL OR char_length(p_eval_version) < 1 OR char_length(p_eval_version) > 40 THEN
    RAISE EXCEPTION 'invalid evaluation version' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v
  FROM public.interview_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing', NULL::text, NULL::text, NULL::numeric, NULL::timestamptz;
    RETURN;
  END IF;

  IF v.status IS DISTINCT FROM 'completed' THEN
    RETURN QUERY SELECT 'not_completed', v.evaluation_status, v.eval_version, v.overall_score, v.evaluation_claimed_at;
    RETURN;
  END IF;

  IF v.evaluation_status = 'completed' AND v.eval_version = p_eval_version THEN
    RETURN QUERY SELECT 'already_completed', v.evaluation_status, v.eval_version, v.overall_score, v.evaluation_claimed_at;
    RETURN;
  END IF;

  IF v.evaluation_status = 'completed'
     AND v.eval_version IS NOT NULL
     AND v.eval_version IS DISTINCT FROM p_eval_version THEN
    RETURN QUERY SELECT 'version_preserved', v.evaluation_status, v.eval_version, v.overall_score, v.evaluation_claimed_at;
    RETURN;
  END IF;

  IF v.evaluation_status = 'processing'
     AND v.evaluation_claimed_at IS NOT NULL
     AND v.evaluation_claimed_at > now() - interval '3 minutes' THEN
    RETURN QUERY SELECT 'in_progress', v.evaluation_status, v.eval_version, v.overall_score, v.evaluation_claimed_at;
    RETURN;
  END IF;

  UPDATE public.interview_sessions
    SET evaluation_status = 'processing',
        evaluation_claimed_at = now()
    WHERE id = p_session_id
    RETURNING * INTO v;

  RETURN QUERY SELECT 'claimed', v.evaluation_status, v.eval_version, v.overall_score, v.evaluation_claimed_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_interview_evaluation(
  p_session_id uuid,
  p_eval_version text,
  p_claimed_at timestamptz
)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.interview_evaluation_is_trusted() THEN
    RAISE EXCEPTION 'interview evaluation is written by the evaluator' USING ERRCODE = '42501';
  END IF;

  UPDATE public.interview_sessions AS s
    SET evaluation_status = 'failed'
    WHERE s.id = p_session_id
      AND s.status = 'completed'
      AND s.evaluation_status = 'processing'
      AND s.evaluation_claimed_at = p_claimed_at
      AND (s.eval_version IS NULL OR s.eval_version = p_eval_version)
    RETURNING s.id INTO v_id;

  RETURN QUERY SELECT CASE WHEN v_id IS NULL THEN 'not_updated' ELSE 'failed' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_interview_evaluation(
  p_session_id uuid,
  p_eval_version text,
  p_summary text,
  p_strengths jsonb,
  p_improvements jsonb,
  p_scores jsonb,
  p_claimed_at timestamptz
)
RETURNS TABLE (
  outcome text,
  overall_score numeric,
  eval_version text,
  evaluation_status text,
  evaluation_summary text,
  evaluation_strengths jsonb,
  evaluation_improvements jsonb,
  evaluated_at timestamptz,
  scores jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.interview_sessions%rowtype;
  v_item record;
  v_competency text;
  v_score numeric;
  v_rationale text;
  v_evidence text;
  v_existing numeric;
  v_overall numeric;
  v_scores jsonb;
  v_count integer;
BEGIN
  IF NOT public.interview_evaluation_is_trusted() THEN
    RAISE EXCEPTION 'interview evaluation is written by the evaluator' USING ERRCODE = '42501';
  END IF;

  IF p_eval_version IS NULL OR char_length(btrim(p_eval_version)) < 1 OR char_length(p_eval_version) > 40 THEN
    RAISE EXCEPTION 'invalid evaluation version' USING ERRCODE = '22023';
  END IF;
  IF p_summary IS NULL OR char_length(btrim(p_summary)) < 1 OR char_length(p_summary) > 1000 THEN
    RAISE EXCEPTION 'invalid evaluation summary' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_strengths) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_improvements) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_scores) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_strengths) < 1
     OR jsonb_array_length(p_strengths) > 6
     OR jsonb_array_length(p_improvements) < 1
     OR jsonb_array_length(p_improvements) > 6
     OR jsonb_array_length(p_scores) < 1
     OR jsonb_array_length(p_scores) > 9
  THEN
    RAISE EXCEPTION 'invalid evaluation payload' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_strengths) AS item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
       OR char_length(btrim(item #>> '{}')) < 1
       OR char_length(item #>> '{}') > 400
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_improvements) AS item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
       OR char_length(btrim(item #>> '{}')) < 1
       OR char_length(item #>> '{}') > 400
  ) THEN
    RAISE EXCEPTION 'invalid evaluation notes' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v
  FROM public.interview_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT 'missing', NULL::numeric, NULL::text, NULL::text, NULL::text,
             NULL::jsonb, NULL::jsonb, NULL::timestamptz, NULL::jsonb;
    RETURN;
  END IF;

  IF v.status IS DISTINCT FROM 'completed' THEN
    RETURN QUERY
      SELECT 'not_completed', v.overall_score, v.eval_version, v.evaluation_status, v.evaluation_summary,
             v.evaluation_strengths, v.evaluation_improvements, v.evaluated_at, NULL::jsonb;
    RETURN;
  END IF;

  IF v.evaluation_status = 'completed' AND v.eval_version = p_eval_version THEN
    SELECT coalesce(jsonb_agg(
      jsonb_build_object(
        'competency', competency,
        'score', score,
        'feedback', rationale,
        'evidence', evidence
      ) ORDER BY created_at, competency
    ), '[]'::jsonb)
      INTO v_scores
    FROM public.interview_scores
    WHERE session_id = p_session_id
      AND interview_scores.eval_version = p_eval_version;

    RETURN QUERY
      SELECT 'already_completed', v.overall_score, v.eval_version, v.evaluation_status, v.evaluation_summary,
             v.evaluation_strengths, v.evaluation_improvements, v.evaluated_at, v_scores;
    RETURN;
  END IF;

  IF v.evaluation_status = 'completed'
     AND v.eval_version IS NOT NULL
     AND v.eval_version IS DISTINCT FROM p_eval_version THEN
    SELECT coalesce(jsonb_agg(
      jsonb_build_object(
        'competency', competency,
        'score', score,
        'feedback', rationale,
        'evidence', evidence
      ) ORDER BY created_at, competency
    ), '[]'::jsonb)
      INTO v_scores
    FROM public.interview_scores
    WHERE session_id = p_session_id
      AND interview_scores.eval_version = v.eval_version;

    RETURN QUERY
      SELECT 'version_preserved', v.overall_score, v.eval_version, v.evaluation_status, v.evaluation_summary,
             v.evaluation_strengths, v.evaluation_improvements, v.evaluated_at, v_scores;
    RETURN;
  END IF;

  IF v.evaluation_status IS DISTINCT FROM 'processing'
     OR v.evaluation_claimed_at IS DISTINCT FROM p_claimed_at THEN
    RETURN QUERY
      SELECT 'stale_claim', v.overall_score, v.eval_version, v.evaluation_status, v.evaluation_summary,
             v.evaluation_strengths, v.evaluation_improvements, v.evaluated_at, NULL::jsonb;
    RETURN;
  END IF;

  FOR v_item IN
    SELECT elem FROM jsonb_array_elements(p_scores) AS elem
  LOOP
    v_competency := btrim(v_item.elem->>'competency');
    v_rationale := btrim(v_item.elem->>'rationale');
    v_evidence := btrim(coalesce(v_item.elem->>'evidence', ''));
    BEGIN
      v_score := round((v_item.elem->>'score')::numeric, 2);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid score' USING ERRCODE = '22023';
    END;

    IF v_competency IS NULL OR char_length(v_competency) < 1 OR char_length(v_competency) > 80
       OR v_score IS NULL OR v_score < 0 OR v_score > 100
       OR v_rationale IS NULL OR char_length(v_rationale) < 1 OR char_length(v_rationale) > 800
       OR char_length(v_evidence) > 800
    THEN
      RAISE EXCEPTION 'invalid competency score' USING ERRCODE = '22023';
    END IF;

    SELECT interview_scores.score
      INTO v_existing
    FROM public.interview_scores
    WHERE session_id = p_session_id
      AND competency = v_competency
      AND interview_scores.eval_version = p_eval_version;

    IF FOUND AND v_existing IS DISTINCT FROM v_score THEN
      RAISE EXCEPTION 'interview score history cannot be changed' USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.interview_scores (session_id, competency, score, rationale, evidence, eval_version)
    VALUES (p_session_id, v_competency, v_score, v_rationale, v_evidence, p_eval_version)
    ON CONFLICT ON CONSTRAINT interview_scores_session_competency_version_unique DO NOTHING;
  END LOOP;

  SELECT count(*), round(avg(score), 2)
    INTO v_count, v_overall
  FROM public.interview_scores
  WHERE session_id = p_session_id
    AND interview_scores.eval_version = p_eval_version;

  IF v_count IS NULL OR v_count < 1 OR v_count <> jsonb_array_length(p_scores) OR v_overall IS NULL THEN
    RAISE EXCEPTION 'evaluation scores were not saved' USING ERRCODE = '23505';
  END IF;

  UPDATE public.interview_sessions AS s
    SET overall_score = v_overall,
        eval_version = p_eval_version,
        evaluation_status = 'completed',
        evaluated_at = now(),
        evaluation_summary = btrim(p_summary),
        evaluation_strengths = p_strengths,
        evaluation_improvements = p_improvements
    WHERE s.id = p_session_id
      AND s.status = 'completed'
      AND s.evaluation_status = 'processing'
      AND s.evaluation_claimed_at = p_claimed_at
    RETURNING * INTO v;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'evaluation was not completed' USING ERRCODE = '40001';
  END IF;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'competency', competency,
      'score', score,
      'feedback', rationale,
      'evidence', evidence
    ) ORDER BY created_at, competency
  ), '[]'::jsonb)
    INTO v_scores
  FROM public.interview_scores
  WHERE session_id = p_session_id
    AND interview_scores.eval_version = p_eval_version;

  RETURN QUERY
    SELECT 'completed', v.overall_score, v.eval_version, v.evaluation_status, v.evaluation_summary,
           v.evaluation_strengths, v.evaluation_improvements, v.evaluated_at, v_scores;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_interview_evaluation(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_interview_evaluation(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_interview_evaluation(uuid, text, text, jsonb, jsonb, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_interview_evaluation(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_interview_evaluation(uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_interview_evaluation(uuid, text, text, jsonb, jsonb, jsonb, timestamptz) TO service_role;
