-- INT-009: Immutable interview template prompt versions (Option 2 snapshots).
-- Apply only after 20261024_interview_core.sql.
-- Do not run supabase db push against the shared project without Madhu approval.

-- ---------------------------------------------------------------------------
-- Shape guard
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.interview_templates') IS NULL
     OR to_regclass('public.interview_sessions') IS NULL THEN
    RAISE EXCEPTION 'INT-002 interview core tables are required before INT-009 versions';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Current version pointer on the live template row
-- ---------------------------------------------------------------------------

ALTER TABLE public.interview_templates
  ADD COLUMN IF NOT EXISTS current_version integer;

UPDATE public.interview_templates
SET current_version = 1
WHERE current_version IS NULL;

ALTER TABLE public.interview_templates
  ALTER COLUMN current_version SET DEFAULT 1,
  ALTER COLUMN current_version SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'interview_templates_current_version_positive'
      AND conrelid = 'public.interview_templates'::regclass
  ) THEN
    ALTER TABLE public.interview_templates
      ADD CONSTRAINT interview_templates_current_version_positive
      CHECK (current_version > 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Snapshot table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.interview_template_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id uuid NOT NULL
        REFERENCES public.interview_templates(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version > 0),
    title text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('hr', 'technical', 'domain')),
    duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
    status text NOT NULL CHECK (status IN ('draft', 'published')),
    system_prompt text NOT NULL,
    rubric_json jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(rubric_json) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT interview_template_versions_template_version_unique
        UNIQUE (template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_interview_template_versions_template
    ON public.interview_template_versions (template_id, version DESC);

-- ---------------------------------------------------------------------------
-- Session reference to the exact snapshot used at start
-- ---------------------------------------------------------------------------

ALTER TABLE public.interview_sessions
  ADD COLUMN IF NOT EXISTS template_version_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'interview_sessions_template_version_id_fkey'
      AND conrelid = 'public.interview_sessions'::regclass
  ) THEN
    ALTER TABLE public.interview_sessions
      ADD CONSTRAINT interview_sessions_template_version_id_fkey
      FOREIGN KEY (template_version_id)
      REFERENCES public.interview_template_versions(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_interview_sessions_template_version
    ON public.interview_sessions (template_version_id)
    WHERE template_version_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill version 1 from existing live template rows
-- ---------------------------------------------------------------------------

INSERT INTO public.interview_template_versions (
    template_id,
    version,
    title,
    kind,
    duration_minutes,
    status,
    system_prompt,
    rubric_json,
    created_at
)
SELECT
    t.id,
    1,
    t.title,
    t.kind,
    t.duration_minutes,
    t.status,
    t.system_prompt,
    t.rubric_json,
    t.created_at
FROM public.interview_templates AS t
ON CONFLICT (template_id, version) DO NOTHING;

UPDATE public.interview_templates
SET current_version = 1
WHERE current_version IS DISTINCT FROM 1
  AND NOT EXISTS (
    SELECT 1
    FROM public.interview_template_versions AS v
    WHERE v.template_id = interview_templates.id
      AND v.version > 1
  );

-- ---------------------------------------------------------------------------
-- Snapshot on template insert/update (admin save bumps version)
-- ---------------------------------------------------------------------------

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
      rubric_json
    )
    VALUES (
      NEW.id,
      v_next,
      NEW.title,
      NEW.kind,
      NEW.duration_minutes,
      NEW.status,
      NEW.system_prompt,
      NEW.rubric_json
    )
    ON CONFLICT (template_id, version) DO UPDATE
      SET title = EXCLUDED.title,
          kind = EXCLUDED.kind,
          duration_minutes = EXCLUDED.duration_minutes,
          status = EXCLUDED.status,
          system_prompt = EXCLUDED.system_prompt,
          rubric_json = EXCLUDED.rubric_json;

    RETURN NEW;
  END IF;

  -- UPDATE: bump only when editable content changes.
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.system_prompt IS DISTINCT FROM OLD.system_prompt
     OR NEW.rubric_json IS DISTINCT FROM OLD.rubric_json THEN
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
      rubric_json
    )
    VALUES (
      NEW.id,
      v_next,
      NEW.title,
      NEW.kind,
      NEW.duration_minutes,
      NEW.status,
      NEW.system_prompt,
      NEW.rubric_json
    );
  ELSE
    NEW.current_version := OLD.current_version;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS interview_templates_capture_version ON public.interview_templates;
CREATE TRIGGER interview_templates_capture_version
  BEFORE INSERT OR UPDATE ON public.interview_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.interview_templates_capture_version();

-- Sessions cannot re-point to a different snapshot after insert.
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

-- Finish uses the session snapshot duration when present; otherwise live template.
CREATE OR REPLACE FUNCTION public.finish_own_interview_session(
  p_session_id uuid,
  p_mode text
)
RETURNS TABLE (
  id uuid,
  status text,
  ended_at timestamptz,
  started_at timestamptz,
  server_now timestamptz,
  ends_at timestamptz,
  time_up boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_session public.interview_sessions%ROWTYPE;
  v_duration integer;
  v_ends timestamptz;
  v_now timestamptz := now();
  v_id uuid;
BEGIN
  IF p_mode IS DISTINCT FROM 'manual' AND p_mode IS DISTINCT FROM 'expired' THEN
    RAISE EXCEPTION 'This interview could not be ended.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session
  FROM public.interview_sessions
  WHERE interview_sessions.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'This interview could not be ended.' USING ERRCODE = '42501';
  END IF;

  IF v_session.template_version_id IS NOT NULL THEN
    SELECT interview_template_versions.duration_minutes INTO v_duration
    FROM public.interview_template_versions
    WHERE interview_template_versions.id = v_session.template_version_id;
  END IF;

  IF v_duration IS NULL AND v_session.prompt_version ~ '^[1-9][0-9]*$' THEN
    SELECT interview_template_versions.duration_minutes INTO v_duration
    FROM public.interview_template_versions
    WHERE interview_template_versions.template_id = v_session.template_id
      AND interview_template_versions.version = v_session.prompt_version::integer;
  END IF;

  IF v_duration IS NULL THEN
    SELECT interview_templates.duration_minutes INTO v_duration
    FROM public.interview_templates
    WHERE interview_templates.id = v_session.template_id;
  END IF;

  IF v_duration IS NULL OR v_duration <= 0 THEN
    RAISE EXCEPTION 'This interview could not be ended.' USING ERRCODE = '42501';
  END IF;

  v_ends := v_session.started_at + make_interval(mins => v_duration);
  v_id := v_session.id;

  IF v_session.status = 'in_progress' AND p_mode = 'manual' THEN
    UPDATE public.interview_sessions
      SET status = 'completed',
          ended_at = v_now
      WHERE interview_sessions.id = v_id
        AND interview_sessions.status = 'in_progress'
      RETURNING * INTO v_session;
  ELSIF v_session.status = 'in_progress' AND p_mode = 'expired' AND v_ends <= v_now THEN
    UPDATE public.interview_sessions
      SET status = 'completed',
          ended_at = v_ends
      WHERE interview_sessions.id = v_id
        AND interview_sessions.status = 'in_progress'
      RETURNING * INTO v_session;
  END IF;

  IF v_session.id IS NULL THEN
    SELECT * INTO v_session
    FROM public.interview_sessions
    WHERE interview_sessions.id = v_id;
  END IF;

  RETURN QUERY
    SELECT
      v_session.id,
      v_session.status,
      v_session.ended_at,
      v_session.started_at,
      v_now,
      v_ends,
      v_ends <= v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_own_interview_session(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_own_interview_session(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.finish_own_interview_session(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Privileges and RLS for versions
-- ---------------------------------------------------------------------------

ALTER TABLE public.interview_template_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.interview_template_versions FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.interview_template_versions TO authenticated;
GRANT ALL ON TABLE public.interview_template_versions TO service_role;

GRANT EXECUTE ON FUNCTION public.interview_templates_capture_version() TO authenticated, service_role;

DROP POLICY IF EXISTS "Authenticated read published interview template versions"
    ON public.interview_template_versions;
CREATE POLICY "Authenticated read published interview template versions"
ON public.interview_template_versions
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.interview_templates AS t
    WHERE t.id = interview_template_versions.template_id
      AND t.status = 'published'
  )
);

DROP POLICY IF EXISTS "Administrators read interview template versions"
    ON public.interview_template_versions;
CREATE POLICY "Administrators read interview template versions"
ON public.interview_template_versions
FOR SELECT
TO authenticated
USING (public.can_manage_interview_templates());

-- Version rows are written by the SECURITY DEFINER trigger / service role only.
DROP POLICY IF EXISTS "Administrators insert interview template versions"
    ON public.interview_template_versions;
DROP POLICY IF EXISTS "Administrators update interview template versions"
    ON public.interview_template_versions;
DROP POLICY IF EXISTS "Administrators delete interview template versions"
    ON public.interview_template_versions;
