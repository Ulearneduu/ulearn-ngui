-- INT-013: Optional coding step for technical interview templates.
-- Depends on INT-009 (20261106_interview_template_versions.sql).
-- Do not apply to the shared Supabase project without approval.

DO $$
BEGIN
  IF to_regclass('public.interview_templates') IS NULL
     OR to_regclass('public.interview_template_versions') IS NULL
     OR to_regclass('public.interview_sessions') IS NULL THEN
    RAISE EXCEPTION 'INT-009 interview template versions are required before INT-013 coding';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- coding_json on live templates + version snapshots (versioned with INT-009)
-- Shape: null | {
--   "enabled": boolean,
--   "title": string,
--   "prompt": string,
--   "starter_code": string,
--   "language": string,
--   "public_test_cases": [{"input": string, "expectedOutput": string}, ...]
-- }
-- ---------------------------------------------------------------------------

ALTER TABLE public.interview_templates
  ADD COLUMN IF NOT EXISTS coding_json jsonb;

ALTER TABLE public.interview_template_versions
  ADD COLUMN IF NOT EXISTS coding_json jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'interview_templates_coding_json_object'
      AND conrelid = 'public.interview_templates'::regclass
  ) THEN
    ALTER TABLE public.interview_templates
      ADD CONSTRAINT interview_templates_coding_json_object
      CHECK (coding_json IS NULL OR jsonb_typeof(coding_json) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'interview_template_versions_coding_json_object'
      AND conrelid = 'public.interview_template_versions'::regclass
  ) THEN
    ALTER TABLE public.interview_template_versions
      ADD CONSTRAINT interview_template_versions_coding_json_object
      CHECK (coding_json IS NULL OR jsonb_typeof(coding_json) = 'object');
  END IF;
END $$;

-- Snapshot capture includes coding_json (INT-013 extension of INT-009).
CREATE OR REPLACE FUNCTION public.interview_templates_capture_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_next := COALESCE(NEW.current_version, 1);
    IF v_next < 1 THEN
      v_next := 1;
    END IF;
    NEW.current_version := v_next;

    INSERT INTO public.interview_template_versions (
      template_id,
      version,
      title,
      kind,
      duration_minutes,
      status,
      system_prompt,
      rubric_json,
      coding_json
    )
    VALUES (
      NEW.id,
      v_next,
      NEW.title,
      NEW.kind,
      NEW.duration_minutes,
      NEW.status,
      NEW.system_prompt,
      NEW.rubric_json,
      NEW.coding_json
    )
    ON CONFLICT (template_id, version) DO UPDATE
      SET title = EXCLUDED.title,
          kind = EXCLUDED.kind,
          duration_minutes = EXCLUDED.duration_minutes,
          status = EXCLUDED.status,
          system_prompt = EXCLUDED.system_prompt,
          rubric_json = EXCLUDED.rubric_json,
          coding_json = EXCLUDED.coding_json;

    RETURN NEW;
  END IF;

  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.system_prompt IS DISTINCT FROM OLD.system_prompt
     OR NEW.rubric_json IS DISTINCT FROM OLD.rubric_json
     OR NEW.coding_json IS DISTINCT FROM OLD.coding_json THEN
    v_next := COALESCE(OLD.current_version, 1) + 1;
    NEW.current_version := v_next;

    INSERT INTO public.interview_template_versions (
      template_id,
      version,
      title,
      kind,
      duration_minutes,
      status,
      system_prompt,
      rubric_json,
      coding_json
    )
    VALUES (
      NEW.id,
      v_next,
      NEW.title,
      NEW.kind,
      NEW.duration_minutes,
      NEW.status,
      NEW.system_prompt,
      NEW.rubric_json,
      NEW.coding_json
    );
  ELSE
    NEW.current_version := OLD.current_version;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Per-session coding submission (INT-008 can read later for scorecard)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.interview_session_coding (
    session_id uuid PRIMARY KEY
        REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
    language text NOT NULL,
    code text NOT NULL DEFAULT '',
    passed_count integer
        CHECK (passed_count IS NULL OR passed_count >= 0),
    total_count integer
        CHECK (total_count IS NULL OR total_count >= 0),
    all_passed boolean,
    results_json jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(results_json) = 'array'),
    problem_snapshot jsonb NOT NULL
        CHECK (jsonb_typeof(problem_snapshot) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    submitted_at timestamptz
);

ALTER TABLE public.interview_session_coding ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.interview_session_coding FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.interview_session_coding TO authenticated;
GRANT ALL ON TABLE public.interview_session_coding TO service_role;

CREATE OR REPLACE FUNCTION public.interview_session_coding_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trusted boolean := current_user IN ('service_role', 'postgres', 'supabase_admin');
  v_owner uuid;
  v_status text;
BEGIN
  IF v_trusted THEN
    RETURN NEW;
  END IF;

  SELECT s.user_id, s.status
    INTO v_owner, v_status
  FROM public.interview_sessions AS s
  WHERE s.id = NEW.session_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'interview session not found for coding row';
  END IF;
  IF v_owner IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'interview coding row must belong to the signed-in user';
  END IF;
  IF v_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'coding can only be saved on an in-progress interview';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.session_id IS DISTINCT FROM OLD.session_id THEN
      RAISE EXCEPTION 'interview coding session_id cannot be changed';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS interview_session_coding_guard ON public.interview_session_coding;
CREATE TRIGGER interview_session_coding_guard
  BEFORE INSERT OR UPDATE ON public.interview_session_coding
  FOR EACH ROW
  EXECUTE FUNCTION public.interview_session_coding_guard();

DROP POLICY IF EXISTS "Users read own interview session coding"
    ON public.interview_session_coding;
CREATE POLICY "Users read own interview session coding"
ON public.interview_session_coding
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.interview_sessions AS s
    WHERE s.id = interview_session_coding.session_id
      AND s.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "Users upsert own interview session coding"
    ON public.interview_session_coding;
CREATE POLICY "Users upsert own interview session coding"
ON public.interview_session_coding
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.interview_sessions AS s
    WHERE s.id = interview_session_coding.session_id
      AND s.user_id = auth.uid()
      AND s.status = 'in_progress'
  )
);

DROP POLICY IF EXISTS "Users update own interview session coding"
    ON public.interview_session_coding;
CREATE POLICY "Users update own interview session coding"
ON public.interview_session_coding
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.interview_sessions AS s
    WHERE s.id = interview_session_coding.session_id
      AND s.user_id = auth.uid()
      AND s.status = 'in_progress'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.interview_sessions AS s
    WHERE s.id = interview_session_coding.session_id
      AND s.user_id = auth.uid()
      AND s.status = 'in_progress'
  )
);

GRANT EXECUTE ON FUNCTION public.interview_session_coding_guard() TO authenticated, service_role;
