-- ============================================================
-- CRT-008: Mock Test Implementation
-- ============================================================
-- Purpose:
-- 1. Allow admins to configure mock tests for learning paths.
-- 2. Configure question counts for each module.
-- 3. Configure the total mock-test duration.
-- 4. Save the exact questions selected for each attempt.
-- 5. Support secure mock submission and section-wise scoring.
--
-- Existing CRT practice functionality must remain unchanged.
-- Do not re-run the original CRT core migration.
-- ============================================================

BEGIN;
-- Private authorization for trusted CRT grading operations.
CREATE SCHEMA IF NOT EXISTS crt_private;

REVOKE ALL ON SCHEMA crt_private
  FROM PUBLIC, anon, authenticated;

CREATE TABLE crt_private.grading_authorizations (
  transaction_id bigint NOT NULL,
  backend_pid integer NOT NULL,
  attempt_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (transaction_id, backend_pid, attempt_id)
);

REVOKE ALL ON TABLE crt_private.grading_authorizations
  FROM PUBLIC, anon, authenticated, service_role;

-- CRT-008 database objects will be added below.
-- ============================================================
-- 1. Mock test blueprint configuration
-- ============================================================

-- One blueprint per learning path.
CREATE TABLE public.crt_mock_blueprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path_id uuid NOT NULL UNIQUE
    REFERENCES public.crt_paths(id) ON DELETE CASCADE,
  total_minutes integer NOT NULL
    CHECK (total_minutes BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT crt_mock_blueprints_id_path_unique
    UNIQUE (id, path_id)
);

-- Each section represents one module in the mock test.
-- Required composite key for the mock section module foreign key.
ALTER TABLE public.crt_modules
  ADD CONSTRAINT crt_modules_id_path_unique
  UNIQUE (id, path_id);

CREATE TABLE public.crt_mock_blueprint_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL,
  path_id uuid NOT NULL,
  module_id uuid NOT NULL,
  question_count integer NOT NULL CHECK (question_count > 0),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT crt_mock_sections_blueprint_fk
    FOREIGN KEY (blueprint_id, path_id)
    REFERENCES public.crt_mock_blueprints(id, path_id)
    ON DELETE CASCADE,

  CONSTRAINT crt_mock_sections_module_fk
    FOREIGN KEY (module_id, path_id)
    REFERENCES public.crt_modules(id, path_id)
    ON DELETE RESTRICT,

  CONSTRAINT crt_mock_blueprint_sections_unique
    UNIQUE (blueprint_id, module_id),

  CONSTRAINT crt_mock_sections_sort_order_check
    CHECK (sort_order >= 0)
);

CREATE INDEX crt_mock_blueprint_sections_blueprint_idx
  ON public.crt_mock_blueprint_sections(blueprint_id);
  -- ============================================================
-- 2. Row Level Security
-- ============================================================

ALTER TABLE public.crt_mock_blueprints
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.crt_mock_blueprints
  FORCE ROW LEVEL SECURITY;

ALTER TABLE public.crt_mock_blueprint_sections
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.crt_mock_blueprint_sections
  FORCE ROW LEVEL SECURITY;

-- Admins can manage mock blueprints.
CREATE POLICY "Admins manage CRT mock blueprints"
  ON public.crt_mock_blueprints
  FOR ALL
  TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

-- Students can read blueprints for published paths.
CREATE POLICY "Students read published CRT mock blueprints"
  ON public.crt_mock_blueprints
  FOR SELECT
  TO authenticated
    USING (
    (SELECT public.has_permission('crt.access'))
    AND EXISTS (
      SELECT 1
      FROM public.crt_paths p
      WHERE p.id = crt_mock_blueprints.path_id
        AND p.status = 'published'
    )
  );

-- Admins can manage blueprint sections.
CREATE POLICY "Admins manage CRT mock blueprint sections"
  ON public.crt_mock_blueprint_sections
  FOR ALL
  TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

-- Students can read sections for published paths.
CREATE POLICY "Students read published CRT mock blueprint sections"
  ON public.crt_mock_blueprint_sections
  FOR SELECT
  TO authenticated
    USING (
    (SELECT public.has_permission('crt.access'))
    AND EXISTS (
      SELECT 1
      FROM public.crt_mock_blueprints b
      JOIN public.crt_paths p
        ON p.id = b.path_id
      JOIN public.crt_modules m
        ON m.id = crt_mock_blueprint_sections.module_id
       AND m.path_id = b.path_id
      WHERE b.id = crt_mock_blueprint_sections.blueprint_id
        AND p.status = 'published'
    )
  );

REVOKE ALL ON TABLE public.crt_mock_blueprints
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.crt_mock_blueprint_sections
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.crt_mock_blueprints TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.crt_mock_blueprint_sections TO authenticated;
  -- ============================================================
-- 3. Questions assigned to each mock attempt
-- ============================================================
-- ============================================================
-- 3. Secure mock question assignments
-- ============================================================

-- Composite keys used by the mapping table.


ALTER TABLE public.crt_attempts
  ADD CONSTRAINT crt_attempts_id_path_unique
  UNIQUE (id, path_id);

ALTER TABLE public.crt_questions
  ADD CONSTRAINT crt_questions_id_module_unique
  UNIQUE (id, module_id);

-- Store the exact questions selected for each mock attempt.
CREATE TABLE public.crt_mock_attempt_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL,
  path_id uuid NOT NULL,
  question_id uuid NOT NULL,
  module_id uuid NOT NULL,
  section_order integer NOT NULL DEFAULT 0,
  question_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT crt_mock_attempt_questions_attempt_fk
    FOREIGN KEY (attempt_id, path_id)
    REFERENCES public.crt_attempts(id, path_id)
    ON DELETE CASCADE,

  CONSTRAINT crt_mock_attempt_questions_question_fk
    FOREIGN KEY (question_id, module_id)
    REFERENCES public.crt_questions(id, module_id)
    ON DELETE RESTRICT,

  CONSTRAINT crt_mock_attempt_questions_module_fk
    FOREIGN KEY (module_id, path_id)
    REFERENCES public.crt_modules(id, path_id)
    ON DELETE RESTRICT,

  CONSTRAINT crt_mock_attempt_questions_unique
    UNIQUE (attempt_id, question_id),

   CONSTRAINT crt_mock_attempt_questions_order_check
    CHECK (section_order >= 0),

  CONSTRAINT crt_mock_attempt_questions_question_order_check
    CHECK (question_order >= 0)
);

CREATE INDEX crt_mock_attempt_questions_attempt_idx
  ON public.crt_mock_attempt_questions(attempt_id);

CREATE INDEX crt_mock_attempt_questions_module_idx
  ON public.crt_mock_attempt_questions(attempt_id, module_id);
  -- ============================================================
-- 5. Secure mock attempt question mappings
-- ============================================================

ALTER TABLE public.crt_mock_attempt_questions
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.crt_mock_attempt_questions
  FORCE ROW LEVEL SECURITY;

CREATE POLICY "Admins read CRT mock attempt questions"
  ON public.crt_mock_attempt_questions
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

CREATE POLICY "Students read their own CRT mock questions"
  ON public.crt_mock_attempt_questions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.crt_attempts a
      WHERE a.id = attempt_id
        AND a.user_id = (SELECT auth.uid())
        AND a.kind = 'mock'
    )
  );

REVOKE ALL ON TABLE public.crt_mock_attempt_questions
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.crt_mock_attempt_questions
  TO authenticated;
-- ============================================================
-- 6. Store mock attempt duration and deadline
-- ============================================================

CREATE TABLE public.crt_mock_attempt_meta (
  attempt_id uuid PRIMARY KEY
    REFERENCES public.crt_attempts(id) ON DELETE CASCADE,

  total_minutes integer NOT NULL
    CHECK (total_minutes BETWEEN 1 AND 300),

  expires_at timestamptz NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.crt_mock_attempt_meta
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.crt_mock_attempt_meta
  FORCE ROW LEVEL SECURITY;

CREATE POLICY "Admins read CRT mock attempt metadata"
  ON public.crt_mock_attempt_meta
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

CREATE POLICY "Students read their own CRT mock attempt metadata"
  ON public.crt_mock_attempt_meta
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.crt_attempts a
      WHERE a.id = attempt_id
        AND a.user_id = (SELECT auth.uid())
        AND a.kind = 'mock'
    )
  );

REVOKE ALL ON TABLE public.crt_mock_attempt_meta
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.crt_mock_attempt_meta
  TO authenticated;
 -- ============================================================
-- 7. Validate answers against assigned mock questions
-- ============================================================

CREATE OR REPLACE FUNCTION public.crt_mock_answer_assignment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt public.crt_attempts%ROWTYPE;
  v_expires_at timestamptz;
BEGIN
  SELECT *
    INTO v_attempt
  FROM public.crt_attempts
  WHERE id = NEW.attempt_id;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'Mock attempt does not exist';
  END IF;

  IF v_attempt.kind = 'mock' THEN
    SELECT expires_at
      INTO v_expires_at
    FROM public.crt_mock_attempt_meta
    WHERE attempt_id = NEW.attempt_id;

    IF v_expires_at IS NULL THEN
      RAISE EXCEPTION 'Mock attempt expiry metadata is missing';
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF clock_timestamp() >= v_expires_at THEN
        RAISE EXCEPTION 'Mock test time has expired';
      END IF;
    ELSIF (
      NEW.selected_index IS DISTINCT FROM OLD.selected_index
      OR NEW.answered_at IS DISTINCT FROM OLD.answered_at
    ) THEN
      IF clock_timestamp() >= v_expires_at THEN
        RAISE EXCEPTION 'Mock test time has expired';
      END IF;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.crt_mock_attempt_questions mq
      WHERE mq.attempt_id = NEW.attempt_id
        AND mq.question_id = NEW.question_id
    ) THEN
      RAISE EXCEPTION
        'Question is not assigned to this mock attempt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
  public.crt_mock_answer_assignment_guard()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.crt_mock_answer_assignment_guard()
  TO authenticated, service_role;

CREATE TRIGGER crt_mock_answer_assignment_guard
  BEFORE INSERT OR UPDATE
  ON public.crt_attempt_answers
  FOR EACH ROW
  EXECUTE FUNCTION public.crt_mock_answer_assignment_guard();
  -- ============================================================
-- 8. Students cannot create mock attempts directly
-- ============================================================

DROP POLICY IF EXISTS "Students insert own crt attempts"
  ON public.crt_attempts;

CREATE POLICY "Students insert own crt attempts"
  ON public.crt_attempts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND (SELECT public.has_permission('crt.access'))
    AND kind = 'practice'
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
  -- ============================================================
-- 9. Securely start a mock test
-- ============================================================

CREATE OR REPLACE FUNCTION public.crt_start_mock_attempt(
  target_path uuid
)
RETURNS TABLE (
  mock_attempt_id uuid,
  mock_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_blueprint public.crt_mock_blueprints%ROWTYPE;
  v_section record;
  v_attempt uuid;
  v_started timestamptz;
  v_existing_expiry timestamptz;
BEGIN
  IF v_user IS NULL
     OR NOT public.has_permission('crt.access') THEN
    RAISE EXCEPTION 'CRT access required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.crt_paths p
    WHERE p.id = target_path
      AND p.status = 'published'
  ) THEN
    RAISE EXCEPTION 'Published learning path not found';
  END IF;

    SELECT *
    INTO v_blueprint
  FROM public.crt_mock_blueprints b
  WHERE b.path_id = target_path
  FOR UPDATE;
  IF v_blueprint.id IS NULL THEN
    RAISE EXCEPTION 'Mock test is not configured';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.crt_mock_blueprint_sections s
    WHERE s.blueprint_id = v_blueprint.id
  ) THEN
    RAISE EXCEPTION 'Mock test has no configured sections';
  END IF;

    -- Resume an active mock without resetting its deadline.
  SELECT a.id, m.expires_at
    INTO v_attempt, v_existing_expiry
  FROM public.crt_attempts a
  LEFT JOIN public.crt_mock_attempt_meta m
    ON m.attempt_id = a.id
  WHERE a.user_id = v_user
    AND a.path_id = target_path
    AND a.kind = 'mock'
    AND a.status = 'in_progress'
  ORDER BY a.started_at DESC
  LIMIT 1
  FOR UPDATE OF a;

  IF v_attempt IS NOT NULL THEN
  IF v_existing_expiry IS NULL THEN
    RAISE EXCEPTION 'Mock attempt expiry metadata is missing';
  ELSIF v_existing_expiry > clock_timestamp() THEN
    mock_attempt_id := v_attempt;
    mock_expires_at := v_existing_expiry;
    RETURN NEXT;
    RETURN;
  ELSE
    PERFORM public.crt_submit_mock_attempt(v_attempt);
    v_attempt := NULL;
    v_existing_expiry := NULL;
  END IF;
END IF;

  -- Validate configured question counts.
  FOR v_section IN
    SELECT s.*
    FROM public.crt_mock_blueprint_sections s
    WHERE s.blueprint_id = v_blueprint.id
  LOOP
    IF (
      SELECT COUNT(*)
      FROM public.crt_questions q
      WHERE q.module_id = v_section.module_id
    ) < v_section.question_count THEN
      RAISE EXCEPTION
        'Not enough questions in configured module';
    END IF;
  END LOOP;

  -- Create the mock attempt.
  INSERT INTO public.crt_attempts (
    user_id, path_id, module_id, kind, status
  )
  VALUES (
    v_user, target_path, NULL, 'mock', 'in_progress'
  )
  RETURNING id, started_at
    INTO v_attempt, v_started;

  -- Save the duration and fixed deadline.
  INSERT INTO public.crt_mock_attempt_meta (
    attempt_id, total_minutes, expires_at
  )
  VALUES (
    v_attempt,
    v_blueprint.total_minutes,
    v_started + make_interval(
      mins => v_blueprint.total_minutes
    )
  );

  -- Assign a random, fixed set of questions to each section.
  FOR v_section IN
    SELECT s.*
    FROM public.crt_mock_blueprint_sections s
    WHERE s.blueprint_id = v_blueprint.id
    ORDER BY s.sort_order, s.id
  LOOP
    INSERT INTO public.crt_mock_attempt_questions (
      attempt_id,
      path_id,
      question_id,
      module_id,
      section_order,
      question_order
    )
        SELECT
      v_attempt,
      target_path,
      selected.id,
      v_section.module_id,
      v_section.sort_order,
      selected.question_order
    FROM (
      SELECT
        chosen.id,
        (
          ROW_NUMBER() OVER (ORDER BY random()) - 1
        )::integer AS question_order
      FROM (
        SELECT q.id
        FROM public.crt_questions q
        WHERE q.module_id = v_section.module_id
        ORDER BY random()
        LIMIT v_section.question_count
      ) chosen
    ) selected;
  END LOOP;

  mock_attempt_id := v_attempt;

  SELECT m.expires_at
    INTO mock_expires_at
  FROM public.crt_mock_attempt_meta m
  WHERE m.attempt_id = v_attempt;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION
  public.crt_start_mock_attempt(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.crt_start_mock_attempt(uuid)
  TO authenticated;
  -- ============================================================
-- 10. Admin saves mock-test configuration
-- ============================================================

CREATE OR REPLACE FUNCTION public.crt_save_mock_blueprint(
  target_path uuid,
  target_minutes integer,
  target_sections jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blueprint_id uuid;
  v_section record;
  v_count integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF target_minutes IS NULL OR target_minutes NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'Duration must be between 1 and 300 minutes';
  END IF;

    IF target_sections IS NULL
     OR jsonb_typeof(target_sections) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Mock sections must be a JSON array';
  END IF;

  IF jsonb_array_length(target_sections) = 0 THEN
    RAISE EXCEPTION 'At least one mock section is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.crt_paths p
    WHERE p.id = target_path
  ) THEN
    RAISE EXCEPTION 'Learning path not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(target_sections)
      AS s(module_id uuid, question_count integer, sort_order integer)
    WHERE s.module_id IS NULL
       OR s.question_count IS NULL
       OR s.question_count <= 0
       OR COALESCE(s.sort_order, 0) < 0
  ) THEN
    RAISE EXCEPTION 'Invalid mock section configuration';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM jsonb_to_recordset(target_sections)
      AS s(module_id uuid, question_count integer, sort_order integer)
  ) <> (
    SELECT COUNT(DISTINCT s.module_id)
    FROM jsonb_to_recordset(target_sections)
      AS s(module_id uuid, question_count integer, sort_order integer)
  ) THEN
    RAISE EXCEPTION 'Duplicate modules are not allowed';
  END IF;

  FOR v_section IN
    SELECT *
    FROM jsonb_to_recordset(target_sections)
      AS s(module_id uuid, question_count integer, sort_order integer)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.crt_modules m
      WHERE m.id = v_section.module_id
        AND m.path_id = target_path
    ) THEN
      RAISE EXCEPTION 'A configured module does not belong to this path';
    END IF;

    SELECT COUNT(*)
      INTO v_count
    FROM public.crt_questions q
    WHERE q.module_id = v_section.module_id;

    IF v_section.question_count > v_count THEN
      RAISE EXCEPTION 'Configured question count exceeds available questions';
    END IF;
  END LOOP;

  INSERT INTO public.crt_mock_blueprints (
    path_id, total_minutes
  )
  VALUES (
    target_path, target_minutes
  )
  ON CONFLICT (path_id)
  DO UPDATE SET
    total_minutes = EXCLUDED.total_minutes,
    updated_at = now()
  RETURNING id INTO v_blueprint_id;

  DELETE FROM public.crt_mock_blueprint_sections
  WHERE blueprint_id = v_blueprint_id;

  INSERT INTO public.crt_mock_blueprint_sections (
    blueprint_id, path_id, module_id, question_count, sort_order
  )
  SELECT
    v_blueprint_id,
    target_path,
    s.module_id,
    s.question_count,
    COALESCE(s.sort_order, 0)
  FROM jsonb_to_recordset(target_sections)
    AS s(module_id uuid, question_count integer, sort_order integer);

  RETURN v_blueprint_id;
END;
$$;

REVOKE ALL ON FUNCTION
  public.crt_save_mock_blueprint(uuid, integer, jsonb)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.crt_save_mock_blueprint(uuid, integer, jsonb)
  TO authenticated;

  -- ============================================================
-- 11. Retrieve assigned mock questions securely
-- ============================================================

CREATE OR REPLACE FUNCTION public.crt_get_mock_questions(
  target_attempt uuid
)
RETURNS TABLE (
  question_id uuid,
  module_id uuid,
  module_title text,
  stem text,
  options jsonb,
  topic text,
  difficulty text,
  section_order integer,
  question_order integer,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_expiry timestamptz;
BEGIN
  IF v_user IS NULL
     OR NOT public.has_permission('crt.access') THEN
    RAISE EXCEPTION 'CRT access required';
  END IF;

  SELECT meta.expires_at
    INTO v_expiry
  FROM public.crt_attempts a
  JOIN public.crt_mock_attempt_meta meta
    ON meta.attempt_id = a.id
  WHERE a.id = target_attempt
    AND a.user_id = v_user
    AND a.kind = 'mock'
    AND a.status = 'in_progress';

  IF v_expiry IS NULL THEN
    RAISE EXCEPTION 'Active mock attempt not found';
  END IF;

  IF v_expiry <= clock_timestamp() THEN
    RAISE EXCEPTION 'Mock test time has expired';
  END IF;

  RETURN QUERY
  SELECT
    q.id,
    q.module_id,
    m.title,
    q.stem,
    q.options,
    q.topic,
    q.difficulty,
    mq.section_order,
    mq.question_order,
    v_expiry
  FROM public.crt_mock_attempt_questions mq
  JOIN public.crt_questions q
    ON q.id = mq.question_id
  JOIN public.crt_modules m
    ON m.id = mq.module_id
  WHERE mq.attempt_id = target_attempt
  ORDER BY mq.section_order, mq.question_order;
END;
$$;

REVOKE ALL ON FUNCTION
  public.crt_get_mock_questions(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.crt_get_mock_questions(uuid)
  TO authenticated;
  -- ============================================================
-- 12. Submit and grade a mock test
-- ============================================================

CREATE OR REPLACE FUNCTION public.crt_submit_mock_attempt(
  target_attempt uuid
)
RETURNS TABLE (
  attempt_score numeric,
  attempt_max_score numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_attempt public.crt_attempts%ROWTYPE;
  v_expires_at timestamptz;
  v_meta public.crt_mock_attempt_meta%ROWTYPE;
  v_score numeric;
  v_max numeric;
  v_submitted timestamptz;
  v_duration integer;
BEGIN
  IF v_user IS NULL
     OR NOT public.has_permission('crt.access') THEN
    RAISE EXCEPTION 'CRT access required';
  END IF;

  SELECT a.*
    INTO v_attempt
  FROM public.crt_attempts a
  WHERE a.id = target_attempt
    AND a.user_id = v_user
    AND a.kind = 'mock'
    AND a.status = 'in_progress'
  FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'In-progress mock attempt not found';
  END IF;

  SELECT *
    INTO v_meta
  FROM public.crt_mock_attempt_meta m
  WHERE m.attempt_id = target_attempt;

  IF v_meta.attempt_id IS NULL THEN
    RAISE EXCEPTION 'Mock attempt metadata not found';
  END IF;

  SELECT COUNT(*)
    INTO v_max
  FROM public.crt_mock_attempt_questions mq
  WHERE mq.attempt_id = target_attempt;

  IF v_max = 0 THEN
    RAISE EXCEPTION 'Mock attempt has no assigned questions';
  END IF;

  INSERT INTO crt_private.grading_authorizations (
  transaction_id,
  backend_pid,
  attempt_id
)
VALUES (
  txid_current(),
  pg_backend_pid(),
  target_attempt
);

  UPDATE public.crt_attempt_answers ans
  SET is_correct = (
    ans.selected_index IS NOT NULL
    AND ans.selected_index = q.correct_index
  )
  FROM public.crt_mock_attempt_questions mq
  JOIN public.crt_questions q
    ON q.id = mq.question_id
  WHERE ans.attempt_id = target_attempt
    AND mq.attempt_id = target_attempt
    AND mq.question_id = ans.question_id;

  SELECT COUNT(*)
    INTO v_score
  FROM public.crt_attempt_answers ans
  JOIN public.crt_mock_attempt_questions mq
    ON mq.question_id = ans.question_id
   AND mq.attempt_id = ans.attempt_id
  WHERE ans.attempt_id = target_attempt
    AND ans.is_correct IS TRUE;

  v_submitted := LEAST(clock_timestamp(), v_meta.expires_at);

  v_duration := GREATEST(
    0,
    FLOOR(
      EXTRACT(EPOCH FROM (v_submitted - v_attempt.started_at))
    )
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
  DELETE FROM crt_private.grading_authorizations
  WHERE transaction_id = txid_current()
    AND backend_pid = pg_backend_pid()
    AND attempt_id = target_attempt;

  attempt_score := v_score;
  attempt_max_score := v_max;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION
  public.crt_submit_mock_attempt(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.crt_submit_mock_attempt(uuid)
  TO authenticated;
  -- ============================================================
-- 12. Return section-wise mock test results
-- ============================================================

CREATE OR REPLACE FUNCTION public.crt_mock_result_sections(
  target_attempt uuid
)
RETURNS TABLE (
  section_order integer,
  module_id uuid,
  module_title text,
  section_score bigint,
  section_max_score bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL
     OR NOT public.has_permission('crt.access') THEN
    RAISE EXCEPTION 'CRT access required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.crt_attempts a
    WHERE a.id = target_attempt
      AND a.user_id = v_user
      AND a.kind = 'mock'
      AND a.status = 'submitted'
  ) THEN
    RAISE EXCEPTION 'Submitted mock attempt not found';
  END IF;

  RETURN QUERY
  SELECT
    mq.section_order,
    m.id,
    m.title,
    COUNT(*) FILTER (
      WHERE ans.is_correct IS TRUE
    )::bigint,
    COUNT(*)::bigint
  FROM public.crt_mock_attempt_questions mq
  JOIN public.crt_modules m
    ON m.id = mq.module_id
  LEFT JOIN public.crt_attempt_answers ans
    ON ans.attempt_id = mq.attempt_id
   AND ans.question_id = mq.question_id
  WHERE mq.attempt_id = target_attempt
  GROUP BY mq.section_order, m.id, m.title
  ORDER BY mq.section_order;
END;
$$;

REVOKE ALL ON FUNCTION
  public.crt_mock_result_sections(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.crt_mock_result_sections(uuid)
  TO authenticated;
  -- ============================================================
-- Secure grading authorization for existing CRT triggers
-- ============================================================

CREATE OR REPLACE FUNCTION public.crt_attempt_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt_id uuid;
  v_is_grading boolean := false;
  v_student boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_attempt_id := OLD.id;
  ELSE
    v_attempt_id := NEW.id;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM crt_private.grading_authorizations ga
    WHERE ga.transaction_id = txid_current()
      AND ga.backend_pid = pg_backend_pid()
      AND ga.attempt_id = v_attempt_id
  )
  INTO v_is_grading;

  v_student :=
    COALESCE(auth.role(), '') = 'authenticated'
    AND NOT v_is_grading;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'in_progress'
       OR NEW.submitted_at IS NOT NULL THEN
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
  v_student boolean;
  v_is_grading boolean := false;
  v_attempt public.crt_attempts%ROWTYPE;
  v_question_module uuid;
  v_question_path uuid;
  v_attempt_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_attempt_id := OLD.attempt_id;
  ELSE
    v_attempt_id := NEW.attempt_id;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM crt_private.grading_authorizations ga
    WHERE ga.transaction_id = txid_current()
      AND ga.backend_pid = pg_backend_pid()
      AND ga.attempt_id = v_attempt_id
  )
  INTO v_is_grading;

  v_student :=
    COALESCE(auth.role(), '') = 'authenticated'
    AND NOT v_is_grading;

  SELECT *
    INTO v_attempt
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

  ELSIF v_student AND (
    NEW.is_correct IS NOT NULL
    OR v_attempt.status IS DISTINCT FROM 'in_progress'
  ) THEN
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

  IF v_attempt.module_id IS NOT NULL
     AND v_question_module IS DISTINCT FROM v_attempt.module_id THEN
    RAISE EXCEPTION 'Question is not in the attempt module';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.crt_attempt_lifecycle()
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.crt_attempt_answer_guard()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.crt_attempt_lifecycle()
  TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.crt_attempt_answer_guard()
  TO authenticated, service_role;
  -- ============================================================
-- Replace practice submission with private grading authorization
-- ============================================================

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

  SELECT path_id, module_id, started_at
    INTO v_path, v_module, v_started
  FROM public.crt_attempts
  WHERE id = target_attempt
    AND user_id = v_user
    AND status = 'in_progress'
    AND kind = 'practice'
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

  INSERT INTO crt_private.grading_authorizations (
    transaction_id,
    backend_pid,
    attempt_id
  )
  VALUES (
    txid_current(),
    pg_backend_pid(),
    target_attempt
  );

  UPDATE public.crt_attempt_answers AS ans
  SET is_correct = (
    ans.selected_index IS NOT NULL
    AND ans.selected_index = q.correct_index
  )
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

  DELETE FROM crt_private.grading_authorizations
  WHERE transaction_id = txid_current()
    AND backend_pid = pg_backend_pid()
    AND attempt_id = target_attempt;

  attempt_score := v_score;
  attempt_max_score := v_max;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.crt_submit_attempt(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.crt_submit_attempt(uuid)
  TO authenticated;
COMMIT;
