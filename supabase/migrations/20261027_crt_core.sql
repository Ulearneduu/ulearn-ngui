-- CRT-002. Applied to the shared Supabase project yllfccuxohnipleyseup.
--
-- Does not recreate public.is_admin(), public.has_permission(text),
-- public.profiles, or public.set_content_updated_at().
--
-- Student reads of published paths, modules, and questions, and access to a
-- user's own attempts and answers, require has_permission('crt.access').
-- Administrative CRUD and reporting reads require public.is_admin().
-- crt.access does not match any content-management policy.
--
-- Question keys:
-- authenticated has no SELECT on crt_questions.correct_index or explanation.
-- crt_questions_student is the security_invoker student view and omits both.
-- crt_questions_staff is the is_admin() read/manage view for those columns.
-- After crt_submit_attempt grades an owned attempt, crt_attempt_review
-- returns keys only for that submitted attempt. Both functions run as the
-- owner with the caller's JWT. The browser does not receive service_role.
--
-- Scoring, decided for CRT-002:
-- One point for each correct answer. Incorrect and unanswered questions score
-- 0. There is no negative marking and no retry limit.
-- Eligible questions are the rows in crt_questions at submission time:
-- a module attempt counts questions in that module; a path attempt
-- (module_id null) counts questions in every module of that path.
-- Questions have no separate publication flag. max_score is that count, not
-- the number of stored answer rows.
-- duration_seconds is the whole seconds from server-set started_at to the
-- server submit time. Clients cannot set either timestamp or the duration.
--
-- Lifecycle: authenticated inserts start in_progress. Only crt_submit_attempt
-- may move an attempt to submitted and write score, max_score, duration, or
-- is_correct. Submitted attempts and answers cannot be changed by
-- authenticated users. user_id, path_id, module_id, and kind cannot change.

-- ─── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crt_paths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crt_paths_title_not_blank CHECK (length(trim(title)) > 0)
);

CREATE TABLE IF NOT EXISTS public.crt_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path_id uuid NOT NULL REFERENCES public.crt_paths(id) ON DELETE RESTRICT,
  title text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crt_modules_title_not_blank CHECK (length(trim(title)) > 0),
  CONSTRAINT crt_modules_sort_order_check CHECK (sort_order >= 0)
);

CREATE TABLE IF NOT EXISTS public.crt_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES public.crt_modules(id) ON DELETE RESTRICT,
  stem text NOT NULL,
  options jsonb NOT NULL,
  correct_index integer NOT NULL,
  explanation text,
  topic text,
  difficulty text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crt_questions_stem_not_blank CHECK (length(trim(stem)) > 0),
  CONSTRAINT crt_questions_correct_index_check CHECK (correct_index BETWEEN 0 AND 3),
  CONSTRAINT crt_questions_difficulty_check CHECK (
    difficulty IS NULL OR difficulty IN ('easy', 'medium', 'hard')
  ),
  CONSTRAINT crt_questions_options_check CHECK (
    jsonb_typeof(options) = 'array'
    AND jsonb_array_length(options) = 4
    AND jsonb_typeof(options -> 0) = 'string' AND length(trim(options ->> 0)) > 0
    AND jsonb_typeof(options -> 1) = 'string' AND length(trim(options ->> 1)) > 0
    AND jsonb_typeof(options -> 2) = 'string' AND length(trim(options ->> 2)) > 0
    AND jsonb_typeof(options -> 3) = 'string' AND length(trim(options ->> 3)) > 0
  )
);

CREATE TABLE IF NOT EXISTS public.crt_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  path_id uuid NOT NULL REFERENCES public.crt_paths(id) ON DELETE RESTRICT,
  module_id uuid REFERENCES public.crt_modules(id) ON DELETE RESTRICT,
  kind text NOT NULL DEFAULT 'practice' CHECK (kind IN ('practice', 'mock')),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  duration_seconds integer NOT NULL DEFAULT 0,
  score numeric,
  max_score numeric,
  CONSTRAINT crt_attempts_duration_check CHECK (duration_seconds >= 0),
  CONSTRAINT crt_attempts_score_check CHECK (score IS NULL OR score >= 0),
  CONSTRAINT crt_attempts_max_score_check CHECK (max_score IS NULL OR max_score >= 0),
  CONSTRAINT crt_attempts_score_within_max_check CHECK (
    score IS NULL OR max_score IS NULL OR score <= max_score
  ),
  CONSTRAINT crt_attempts_status_time_check CHECK (
    (status = 'in_progress' AND submitted_at IS NULL)
    OR (status = 'submitted' AND submitted_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.crt_attempt_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.crt_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.crt_questions(id) ON DELETE RESTRICT,
  selected_index integer,
  is_correct boolean,
  answered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crt_attempt_answers_attempt_question_unique UNIQUE (attempt_id, question_id),
  CONSTRAINT crt_attempt_answers_selected_index_check CHECK (
    selected_index IS NULL OR selected_index BETWEEN 0 AND 3
  )
);

CREATE INDEX IF NOT EXISTS crt_modules_path_sort_idx
  ON public.crt_modules (path_id, sort_order);
CREATE INDEX IF NOT EXISTS crt_questions_module_id_idx
  ON public.crt_questions (module_id);
CREATE INDEX IF NOT EXISTS crt_paths_status_idx
  ON public.crt_paths (status);
CREATE INDEX IF NOT EXISTS crt_attempts_user_id_idx
  ON public.crt_attempts (user_id);
CREATE INDEX IF NOT EXISTS crt_attempts_path_id_idx
  ON public.crt_attempts (path_id);
CREATE INDEX IF NOT EXISTS crt_attempts_module_id_idx
  ON public.crt_attempts (module_id);
CREATE INDEX IF NOT EXISTS crt_attempt_answers_attempt_id_idx
  ON public.crt_attempt_answers (attempt_id);
CREATE INDEX IF NOT EXISTS crt_attempt_answers_question_id_idx
  ON public.crt_attempt_answers (question_id);

DROP TRIGGER IF EXISTS crt_paths_updated_at ON public.crt_paths;
CREATE TRIGGER crt_paths_updated_at
  BEFORE UPDATE ON public.crt_paths
  FOR EACH ROW
  EXECUTE FUNCTION public.set_content_updated_at();

-- ─── Lifecycle ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crt_attempt_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- auth.role() follows the JWT inside security-definer code. The submit
  -- function sets crt.grading for its own writes so those are not treated
  -- as a direct student update.
  v_student boolean := COALESCE(auth.role(), '') = 'authenticated'
    AND current_setting('crt.grading', true) IS DISTINCT FROM 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'in_progress' OR NEW.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Attempts must start in progress';
    END IF;
    IF v_student THEN
      NEW.started_at := clock_timestamp();
      NEW.duration_seconds := 0;
      IF NEW.score IS NOT NULL OR NEW.max_score IS NOT NULL THEN
        RAISE EXCEPTION 'Students cannot set attempt scores';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_student THEN
      RAISE EXCEPTION 'Students cannot delete attempts';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.path_id IS DISTINCT FROM OLD.path_id
     OR NEW.module_id IS DISTINCT FROM OLD.module_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Attempt ownership and placement cannot change';
  END IF;

  IF v_student THEN
    RAISE EXCEPTION 'Students cannot change attempts directly';
  END IF;

  IF OLD.status = 'submitted'
     AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.score IS DISTINCT FROM OLD.score
       OR NEW.max_score IS DISTINCT FROM OLD.max_score
       OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
     ) THEN
    RAISE EXCEPTION 'Submitted attempts cannot be changed';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.crt_attempt_answer_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student boolean := COALESCE(auth.role(), '') = 'authenticated'
    AND current_setting('crt.grading', true) IS DISTINCT FROM 'on';
  v_attempt public.crt_attempts%ROWTYPE;
  v_question_module uuid;
  v_question_path uuid;
  v_attempt_id uuid;
BEGIN
  v_attempt_id := COALESCE(NEW.attempt_id, OLD.attempt_id);

  SELECT * INTO v_attempt
  FROM public.crt_attempts
  WHERE id = v_attempt_id;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'Attempt does not exist';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_student AND v_attempt.status = 'submitted' THEN
      RAISE EXCEPTION 'Answers on a submitted attempt cannot be changed';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
       OR NEW.question_id IS DISTINCT FROM OLD.question_id THEN
      RAISE EXCEPTION 'Answer identity cannot change';
    END IF;
    IF v_student AND (
      NEW.is_correct IS DISTINCT FROM OLD.is_correct
      OR v_attempt.status IS DISTINCT FROM 'in_progress'
    ) THEN
      RAISE EXCEPTION 'Students cannot change this answer';
    END IF;
  ELSIF v_student AND (NEW.is_correct IS NOT NULL OR v_attempt.status IS DISTINCT FROM 'in_progress') THEN
    RAISE EXCEPTION 'Students cannot add this answer';
  END IF;

  SELECT q.module_id, m.path_id
    INTO v_question_module, v_question_path
  FROM public.crt_questions q
  JOIN public.crt_modules m ON m.id = q.module_id
  WHERE q.id = NEW.question_id;

  IF v_question_module IS NULL THEN
    RAISE EXCEPTION 'Question does not exist';
  END IF;

  IF v_question_path IS DISTINCT FROM v_attempt.path_id THEN
    RAISE EXCEPTION 'Question is not on the attempt path';
  END IF;

  IF v_attempt.module_id IS NOT NULL AND v_question_module IS DISTINCT FROM v_attempt.module_id THEN
    RAISE EXCEPTION 'Question is not in the attempt module';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.crt_attempt_lifecycle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crt_attempt_answer_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crt_attempt_lifecycle() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crt_attempt_answer_guard() TO authenticated, service_role;

DROP TRIGGER IF EXISTS crt_attempts_lifecycle ON public.crt_attempts;
CREATE TRIGGER crt_attempts_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON public.crt_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.crt_attempt_lifecycle();

DROP TRIGGER IF EXISTS crt_attempt_answers_guard ON public.crt_attempt_answers;
CREATE TRIGGER crt_attempt_answers_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.crt_attempt_answers
  FOR EACH ROW
  EXECUTE FUNCTION public.crt_attempt_answer_guard();

-- ─── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON TABLE public.crt_paths FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.crt_modules FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.crt_questions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.crt_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.crt_attempt_answers FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crt_paths TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crt_modules TO authenticated;

GRANT SELECT (
  id, module_id, stem, options, topic, difficulty, created_at
) ON TABLE public.crt_questions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.crt_questions TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crt_paths TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crt_modules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crt_questions TO service_role;

GRANT SELECT (
  id, user_id, path_id, module_id, kind, status, started_at, submitted_at,
  duration_seconds, score, max_score
), INSERT (
  id, user_id, path_id, module_id, kind, status
) ON TABLE public.crt_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crt_attempts TO service_role;

GRANT SELECT (
  id, attempt_id, question_id, selected_index, is_correct, answered_at
), INSERT (
  id, attempt_id, question_id, selected_index, answered_at
), UPDATE (
  selected_index, answered_at
), DELETE ON TABLE public.crt_attempt_answers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crt_attempt_answers TO service_role;

CREATE OR REPLACE VIEW public.crt_questions_student
WITH (security_invoker = true) AS
SELECT id, module_id, stem, options, topic, difficulty, created_at
FROM public.crt_questions;

CREATE OR REPLACE VIEW public.crt_questions_staff
WITH (security_barrier = true, security_invoker = false) AS
SELECT
  id,
  module_id,
  stem,
  options,
  correct_index,
  explanation,
  topic,
  difficulty,
  created_at
FROM public.crt_questions
WHERE public.is_admin()
WITH CHECK OPTION;

REVOKE ALL ON TABLE public.crt_questions_student FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.crt_questions_staff FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.crt_questions_student TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crt_questions_staff TO authenticated, service_role;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.crt_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crt_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crt_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crt_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crt_attempt_answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin manage crt paths" ON public.crt_paths;
CREATE POLICY "Admin manage crt paths" ON public.crt_paths
  FOR ALL TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Students read published crt paths" ON public.crt_paths;
CREATE POLICY "Students read published crt paths" ON public.crt_paths
  FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND (SELECT public.has_permission('crt.access'))
  );

DROP POLICY IF EXISTS "Admin manage crt modules" ON public.crt_modules;
CREATE POLICY "Admin manage crt modules" ON public.crt_modules
  FOR ALL TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Students read modules on published paths" ON public.crt_modules;
CREATE POLICY "Students read modules on published paths" ON public.crt_modules
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_permission('crt.access'))
    AND EXISTS (
      SELECT 1
      FROM public.crt_paths p
      WHERE p.id = path_id
        AND p.status = 'published'
    )
  );

DROP POLICY IF EXISTS "Admin manage crt questions" ON public.crt_questions;
CREATE POLICY "Admin manage crt questions" ON public.crt_questions
  FOR ALL TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Students read questions on published paths" ON public.crt_questions;
CREATE POLICY "Students read questions on published paths" ON public.crt_questions
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_permission('crt.access'))
    AND EXISTS (
      SELECT 1
      FROM public.crt_modules m
      JOIN public.crt_paths p ON p.id = m.path_id
      WHERE m.id = module_id
        AND p.status = 'published'
    )
  );

DROP POLICY IF EXISTS "Admins read crt attempts" ON public.crt_attempts;
CREATE POLICY "Admins read crt attempts" ON public.crt_attempts
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Students read own crt attempts" ON public.crt_attempts;
CREATE POLICY "Students read own crt attempts" ON public.crt_attempts
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND (SELECT public.has_permission('crt.access'))
  );

DROP POLICY IF EXISTS "Students insert own crt attempts" ON public.crt_attempts;
CREATE POLICY "Students insert own crt attempts" ON public.crt_attempts
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND (SELECT public.has_permission('crt.access'))
    AND status = 'in_progress'
    AND submitted_at IS NULL
    AND score IS NULL
    AND max_score IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.crt_paths p
      WHERE p.id = crt_attempts.path_id
        AND p.status = 'published'
    )
    AND (
      crt_attempts.module_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.crt_modules m
        JOIN public.crt_paths p ON p.id = m.path_id
        WHERE m.id = crt_attempts.module_id
          AND m.path_id = crt_attempts.path_id
          AND p.status = 'published'
      )
    )
  );

DROP POLICY IF EXISTS "Admins read crt attempt answers" ON public.crt_attempt_answers;
CREATE POLICY "Admins read crt attempt answers" ON public.crt_attempt_answers
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Students read own crt attempt answers" ON public.crt_attempt_answers;
CREATE POLICY "Students read own crt attempt answers" ON public.crt_attempt_answers
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_permission('crt.access'))
    AND EXISTS (
      SELECT 1
      FROM public.crt_attempts a
      WHERE a.id = attempt_id
        AND a.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Students insert own in-progress crt answers" ON public.crt_attempt_answers;
CREATE POLICY "Students insert own in-progress crt answers" ON public.crt_attempt_answers
  FOR INSERT TO authenticated
  WITH CHECK (
    is_correct IS NULL
    AND (SELECT public.has_permission('crt.access'))
    AND EXISTS (
      SELECT 1
      FROM public.crt_attempts a
      JOIN public.crt_questions q ON q.id = question_id
      JOIN public.crt_modules qm ON qm.id = q.module_id
      WHERE a.id = attempt_id
        AND a.user_id = (SELECT auth.uid())
        AND a.status = 'in_progress'
        AND qm.path_id = a.path_id
        AND (a.module_id IS NULL OR q.module_id = a.module_id)
    )
  );

DROP POLICY IF EXISTS "Students update own in-progress crt answers" ON public.crt_attempt_answers;
CREATE POLICY "Students update own in-progress crt answers" ON public.crt_attempt_answers
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.has_permission('crt.access'))
    AND EXISTS (
      SELECT 1
      FROM public.crt_attempts a
      JOIN public.crt_questions q ON q.id = question_id
      JOIN public.crt_modules qm ON qm.id = q.module_id
      WHERE a.id = attempt_id
        AND a.user_id = (SELECT auth.uid())
        AND a.status = 'in_progress'
        AND qm.path_id = a.path_id
        AND (a.module_id IS NULL OR q.module_id = a.module_id)
    )
  )
  WITH CHECK (
    is_correct IS NULL
    AND (SELECT public.has_permission('crt.access'))
    AND EXISTS (
      SELECT 1
      FROM public.crt_attempts a
      JOIN public.crt_questions q ON q.id = question_id
      JOIN public.crt_modules qm ON qm.id = q.module_id
      WHERE a.id = attempt_id
        AND a.user_id = (SELECT auth.uid())
        AND a.status = 'in_progress'
        AND qm.path_id = a.path_id
        AND (a.module_id IS NULL OR q.module_id = a.module_id)
    )
  );

DROP POLICY IF EXISTS "Students delete own in-progress crt answers" ON public.crt_attempt_answers;
CREATE POLICY "Students delete own in-progress crt answers" ON public.crt_attempt_answers
  FOR DELETE TO authenticated
  USING (
    (SELECT public.has_permission('crt.access'))
    AND EXISTS (
      SELECT 1
      FROM public.crt_attempts a
      WHERE a.id = attempt_id
        AND a.user_id = (SELECT auth.uid())
        AND a.status = 'in_progress'
    )
  );

-- ─── Submit and review ───────────────────────────────────────────────────────
-- Called with the signed-in user's JWT. The function body reads question keys
-- as the owner; the caller is not granted those columns.

CREATE OR REPLACE FUNCTION public.crt_submit_attempt(target_attempt uuid)
RETURNS TABLE (attempt_score numeric, attempt_max_score numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_path uuid;
  v_module uuid;
  v_started timestamptz;
  v_submitted timestamptz;
  v_score numeric;
  v_max numeric;
  v_duration integer;
BEGIN
  IF v_user IS NULL OR NOT public.has_permission('crt.access') THEN
    RAISE EXCEPTION 'CRT access required';
  END IF;

  PERFORM set_config('crt.grading', 'on', true);

  SELECT path_id, module_id, started_at
    INTO v_path, v_module, v_started
  FROM public.crt_attempts
  WHERE id = target_attempt
    AND user_id = v_user
    AND status = 'in_progress'
  FOR UPDATE;

  IF v_path IS NULL THEN
    RAISE EXCEPTION 'In-progress attempt not found';
  END IF;

  PERFORM 1
  FROM public.crt_attempt_answers
  WHERE attempt_id = target_attempt
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.crt_attempt_answers AS ans
    JOIN public.crt_questions AS q ON q.id = ans.question_id
    JOIN public.crt_modules AS qm ON qm.id = q.module_id
    WHERE ans.attempt_id = target_attempt
      AND (
        qm.path_id IS DISTINCT FROM v_path
        OR (v_module IS NOT NULL AND q.module_id IS DISTINCT FROM v_module)
      )
  ) THEN
    RAISE EXCEPTION 'Attempt contains a question outside its scope';
  END IF;

  UPDATE public.crt_attempt_answers AS ans
  SET is_correct = (ans.selected_index IS NOT NULL AND ans.selected_index = q.correct_index)
  FROM public.crt_questions AS q
  JOIN public.crt_modules AS qm ON qm.id = q.module_id
  WHERE ans.attempt_id = target_attempt
    AND q.id = ans.question_id
    AND qm.path_id = v_path
    AND (v_module IS NULL OR q.module_id = v_module);

  SELECT COUNT(*)
    INTO v_max
  FROM public.crt_questions AS q
  JOIN public.crt_modules AS qm ON qm.id = q.module_id
  WHERE qm.path_id = v_path
    AND (v_module IS NULL OR q.module_id = v_module);

  SELECT COUNT(*)
    INTO v_score
  FROM public.crt_attempt_answers AS ans
  JOIN public.crt_questions AS q ON q.id = ans.question_id
  JOIN public.crt_modules AS qm ON qm.id = q.module_id
  WHERE ans.attempt_id = target_attempt
    AND ans.is_correct IS TRUE
    AND qm.path_id = v_path
    AND (v_module IS NULL OR q.module_id = v_module);

  v_submitted := clock_timestamp();
  v_duration := GREATEST(
    0,
    FLOOR(EXTRACT(EPOCH FROM (v_submitted - v_started)))
  )::integer;

  UPDATE public.crt_attempts
  SET status = 'submitted',
      submitted_at = v_submitted,
      score = v_score,
      max_score = v_max,
      duration_seconds = v_duration
  WHERE id = target_attempt
    AND user_id = v_user
    AND status = 'in_progress';

  attempt_score := v_score;
  attempt_max_score := v_max;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.crt_attempt_review(target_attempt uuid)
RETURNS TABLE (
  question_id uuid,
  stem text,
  options jsonb,
  selected_index integer,
  correct_index integer,
  explanation text,
  is_correct boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    q.id,
    q.stem,
    q.options,
    ans.selected_index,
    q.correct_index,
    q.explanation,
    ans.is_correct
  FROM public.crt_attempts AS a
  JOIN public.crt_attempt_answers AS ans ON ans.attempt_id = a.id
  JOIN public.crt_questions AS q ON q.id = ans.question_id
  WHERE a.id = target_attempt
    AND a.user_id = auth.uid()
    AND a.status = 'submitted'
    AND public.has_permission('crt.access');
$$;

REVOKE ALL ON FUNCTION public.crt_submit_attempt(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crt_attempt_review(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crt_submit_attempt(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crt_attempt_review(uuid) TO authenticated;

-- ─── Sample seed ─────────────────────────────────────────────────────────────

INSERT INTO public.crt_paths (id, title, description, status, created_by)
VALUES (
  'a0c70002-0000-4000-8000-000000000001',
  'Campus Service Track',
  'Practice aptitude, reasoning, and verbal questions for campus service-company preparation.',
  'published',
  NULL
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crt_modules (id, path_id, title, sort_order)
VALUES
  ('a0c70002-0000-4000-8000-000000000011', 'a0c70002-0000-4000-8000-000000000001', 'Aptitude', 0),
  ('a0c70002-0000-4000-8000-000000000012', 'a0c70002-0000-4000-8000-000000000001', 'Reasoning', 1),
  ('a0c70002-0000-4000-8000-000000000013', 'a0c70002-0000-4000-8000-000000000001', 'Verbal', 2)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crt_questions (
  id, module_id, stem, options, correct_index, explanation, topic, difficulty
)
VALUES
  (
    'a0c70002-0000-4000-8000-000000000101',
    'a0c70002-0000-4000-8000-000000000011',
    'What is 15% of 200?',
    '["20","30","35","45"]'::jsonb,
    1,
    '15% of 200 is 0.15 x 200 = 30.',
    'Percentages',
    'easy'
  ),
  (
    'a0c70002-0000-4000-8000-000000000102',
    'a0c70002-0000-4000-8000-000000000011',
    'A class has 18 girls and 12 boys. What is the ratio of girls to boys?',
    '["2:3","3:2","3:5","5:3"]'::jsonb,
    1,
    '18:12 simplifies by 6 to 3:2.',
    'Ratios',
    'easy'
  ),
  (
    'a0c70002-0000-4000-8000-000000000103',
    'a0c70002-0000-4000-8000-000000000011',
    'A person walks 3 km in 30 minutes at a steady pace. How many kilometres does the person walk in 2 hours?',
    '["6","9","12","15"]'::jsonb,
    2,
    'Thirty minutes covers 3 km, so two hours cover 12 km.',
    'Time and distance',
    'easy'
  ),
  (
    'a0c70002-0000-4000-8000-000000000104',
    'a0c70002-0000-4000-8000-000000000012',
    'What is the next number in the series 2, 6, 12, 20?',
    '["24","28","30","32"]'::jsonb,
    2,
    'The gaps are 4, 6, and 8, so the next gap is 10 and 20 + 10 = 30.',
    'Number series',
    'medium'
  ),
  (
    'a0c70002-0000-4000-8000-000000000105',
    'a0c70002-0000-4000-8000-000000000012',
    'Which word does not belong with the others?',
    '["Triangle","Square","Circle","Cube"]'::jsonb,
    3,
    'Triangle, square, and circle are plane figures. A cube is a solid.',
    'Classification',
    'easy'
  ),
  (
    'a0c70002-0000-4000-8000-000000000106',
    'a0c70002-0000-4000-8000-000000000012',
    'If CAT is coded as DBU, how is DOG coded using the same one-letter shift?',
    '["EPH","CPF","ENF","EPI"]'::jsonb,
    0,
    'Each letter moves forward by one: D to E, O to P, and G to H.',
    'Coding',
    'medium'
  ),
  (
    'a0c70002-0000-4000-8000-000000000107',
    'a0c70002-0000-4000-8000-000000000013',
    'Choose the closest synonym of "brief".',
    '["Long","Short","Late","Loud"]'::jsonb,
    1,
    'Brief means short in length or duration.',
    'Synonyms',
    'easy'
  ),
  (
    'a0c70002-0000-4000-8000-000000000108',
    'a0c70002-0000-4000-8000-000000000013',
    'Choose the closest antonym of "ancient".',
    '["Old","Historic","Modern","Rare"]'::jsonb,
    2,
    'Ancient means very old. Modern is the opposite.',
    'Antonyms',
    'easy'
  ),
  (
    'a0c70002-0000-4000-8000-000000000109',
    'a0c70002-0000-4000-8000-000000000013',
    'Choose the word that best completes the sentence: Please ____ your answer before submitting.',
    '["review","reviews","reviewing","reviewed"]'::jsonb,
    0,
    'After "please", the request uses the base verb form "review".',
    'Sentence completion',
    'easy'
  )
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.crt_paths FORCE ROW LEVEL SECURITY;
ALTER TABLE public.crt_modules FORCE ROW LEVEL SECURITY;
ALTER TABLE public.crt_questions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.crt_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.crt_attempt_answers FORCE ROW LEVEL SECURITY;
