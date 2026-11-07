-- INT-010: store personalized practice tips on the INT-008 evaluation snapshot.
-- Apply only this file to a disposable or approved database. Do not run supabase db push.
-- Do not apply this file to production without explicit approval.
--
-- evaluation_tips stays null on evaluations saved before this column existed.
-- A non-null value must be 3 to 5 distinct, non-empty tips.
-- The INT-008 7-argument apply_interview_evaluation is left in place.
-- New evaluations call the 8-argument function, which also writes evaluation_tips.

DO $$
BEGIN
  IF to_regclass('public.interview_sessions') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'interview_sessions'
         AND column_name = 'evaluation_strengths'
     ) THEN
    RAISE EXCEPTION 'INT-008 interview evaluation columns are missing; refusing to continue';
  END IF;
END $$;

ALTER TABLE public.interview_sessions
  ADD COLUMN IF NOT EXISTS evaluation_tips text[];

CREATE OR REPLACE FUNCTION public.interview_tips_valid(p_tips text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_tips IS NULL
    OR (
      cardinality(p_tips) BETWEEN 3 AND 5
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(p_tips) AS tip
        WHERE tip IS NULL
           OR char_length(btrim(tip)) < 1
           OR char_length(btrim(tip)) > 400
           OR tip IS DISTINCT FROM btrim(tip)
      )
      AND (
        SELECT count(DISTINCT lower(tip))
        FROM unnest(p_tips) AS tip
      ) = cardinality(p_tips)
    );
$$;

ALTER TABLE public.interview_sessions
  DROP CONSTRAINT IF EXISTS interview_sessions_evaluation_tips_check;

ALTER TABLE public.interview_sessions
  ADD CONSTRAINT interview_sessions_evaluation_tips_check
  CHECK (public.interview_tips_valid(evaluation_tips));

-- Students can finish a session. They cannot write evaluator fields or tips.
-- Template version locking from INT template versioning stays in this guard.
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
       OR NEW.evaluation_tips IS NOT NULL
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
    -- INT template versioning adds this column. Older local databases do not have it yet.
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'interview_sessions'
        AND column_name = 'template_version_id'
    ) AND (to_jsonb(NEW)->>'template_version_id') IS DISTINCT FROM (to_jsonb(OLD)->>'template_version_id') THEN
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
       OR NEW.evaluation_tips IS DISTINCT FROM OLD.evaluation_tips
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

REVOKE UPDATE (evaluation_tips) ON TABLE public.interview_sessions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_interview_evaluation(
  p_session_id uuid,
  p_eval_version text,
  p_summary text,
  p_strengths jsonb,
  p_improvements jsonb,
  p_scores jsonb,
  p_claimed_at timestamptz,
  p_tips text[]
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
  scores jsonb,
  evaluation_tips text[]
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
  v_tips text[];
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
  IF NOT public.interview_tips_valid(p_tips) OR p_tips IS NULL THEN
    RAISE EXCEPTION 'invalid evaluation tips' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(array_agg(btrim(tip) ORDER BY ord), '{}'::text[])
    INTO v_tips
  FROM unnest(p_tips) WITH ORDINALITY AS item(tip, ord);

  SELECT * INTO v
  FROM public.interview_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT 'missing', NULL::numeric, NULL::text, NULL::text, NULL::text,
             NULL::jsonb, NULL::jsonb, NULL::timestamptz, NULL::jsonb, NULL::text[];
    RETURN;
  END IF;

  IF v.status IS DISTINCT FROM 'completed' THEN
    RETURN QUERY
      SELECT 'not_completed', v.overall_score, v.eval_version, v.evaluation_status, v.evaluation_summary,
             v.evaluation_strengths, v.evaluation_improvements, v.evaluated_at, NULL::jsonb, v.evaluation_tips;
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
             v.evaluation_strengths, v.evaluation_improvements, v.evaluated_at, v_scores, v.evaluation_tips;
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
             v.evaluation_strengths, v.evaluation_improvements, v.evaluated_at, v_scores, v.evaluation_tips;
    RETURN;
  END IF;

  IF v.evaluation_status IS DISTINCT FROM 'processing'
     OR v.evaluation_claimed_at IS DISTINCT FROM p_claimed_at THEN
    RETURN QUERY
      SELECT 'stale_claim', v.overall_score, v.eval_version, v.evaluation_status, v.evaluation_summary,
             v.evaluation_strengths, v.evaluation_improvements, v.evaluated_at, NULL::jsonb, v.evaluation_tips;
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
        evaluation_improvements = p_improvements,
        evaluation_tips = v_tips
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
           v.evaluation_strengths, v.evaluation_improvements, v.evaluated_at, v_scores, v.evaluation_tips;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_interview_evaluation(uuid, text, text, jsonb, jsonb, jsonb, timestamptz, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_interview_evaluation(uuid, text, text, jsonb, jsonb, jsonb, timestamptz, text[]) TO service_role;

REVOKE ALL ON FUNCTION public.interview_tips_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.interview_tips_valid(text[]) TO anon, authenticated, service_role;
