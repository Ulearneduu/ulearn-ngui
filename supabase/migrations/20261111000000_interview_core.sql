-- INT-002: Core schema for AI mock interviews.
-- Tables, constraints, indexes, published seed templates, and RLS.
--
-- Authorization (templates):
-- There is no staff permission for interview-template management.
-- interview.access is the student feature "Allowed Interview"
-- (labels: allowed_interview, plus main_admin and admin). It must not
-- authorize template administration by itself or together with is_admin(),
-- because a portal label such as mentor can also hold allowed_interview.
-- is_admin() is also broader than company administration: any staff label
-- with portal_access (mentor, campus_admin) satisfies it.
--
-- Template writes therefore use public.can_manage_interview_templates():
--   * profiles.role = 'ADMIN', or
--   * JWT user_metadata.role = 'ADMIN'
--     (the same administrator check as the app and edge functions), or
--   * membership in the system labels main_admin or admin
--     (the labels seeded with management permissions).
-- Mentors, campus admins, and Allowed Interview students are excluded.
-- Score rows are not writable by authenticated students. The evaluator
-- uses the service role, which bypasses RLS. Session overall_score is
-- likewise reserved for service_role / database administrators.

-- ---------------------------------------------------------------------------
-- Shape guard: do not silently skip a table created with an older shape.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'interview_templates'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'interview_templates'
      AND column_name = 'rubric_json'
  ) THEN
    RAISE EXCEPTION
      'public.interview_templates exists without INT-002 columns; refusing to continue';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.interview_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    title text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('hr', 'technical', 'domain')),
    duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'published')),
    system_prompt text NOT NULL,
    rubric_json jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(rubric_json) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.interview_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL
        REFERENCES auth.users(id) ON DELETE CASCADE,
    template_id uuid NOT NULL
        REFERENCES public.interview_templates(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'completed', 'failed')),
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    prompt_version text NOT NULL,
    overall_score numeric,
    CONSTRAINT interview_sessions_end_after_start
        CHECK (ended_at IS NULL OR ended_at >= started_at),
    CONSTRAINT interview_sessions_score_valid
        CHECK (overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100))
);

CREATE INDEX IF NOT EXISTS idx_interview_sessions_user_started
    ON public.interview_sessions (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_interview_sessions_template
    ON public.interview_sessions (template_id);

CREATE TABLE IF NOT EXISTS public.interview_turns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL
        REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('assistant', 'user')),
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    seq integer NOT NULL CHECK (seq > 0),
    CONSTRAINT interview_turns_session_seq_unique
        UNIQUE (session_id, seq)
);

-- Required lookup index. The unique constraint above also indexes this pair.
CREATE INDEX IF NOT EXISTS idx_interview_turns_session_seq
    ON public.interview_turns (session_id, seq);

CREATE TABLE IF NOT EXISTS public.interview_scores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL
        REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
    competency text NOT NULL,
    score numeric NOT NULL,
    rationale text NOT NULL,
    eval_version text NOT NULL,
    CONSTRAINT interview_scores_score_valid
        CHECK (score >= 0 AND score <= 100),
    CONSTRAINT interview_scores_session_competency_version_unique
        UNIQUE (session_id, competency, eval_version)
);

CREATE INDEX IF NOT EXISTS idx_interview_scores_session
    ON public.interview_scores (session_id);

-- ---------------------------------------------------------------------------
-- Published seed templates. Conflict handling updates only these slugs.
-- ---------------------------------------------------------------------------

INSERT INTO public.interview_templates (
    slug,
    title,
    kind,
    duration_minutes,
    status,
    system_prompt,
    rubric_json
)
VALUES
(
    'hr-behavioral',
    'HR Behavioral Interview',
    'hr',
    20,
    'published',
    'You are an HR interviewer conducting a behavioral mock interview. Ask one question at a time about teamwork, communication, challenges, and decision-making. Evaluate responses using the configured rubric and provide constructive feedback.',
    '{
        "scale": {"min": 0, "max": 100},
        "competencies": [
            {"key": "communication", "label": "Communication", "min": 0, "max": 100},
            {"key": "teamwork", "label": "Teamwork", "min": 0, "max": 100},
            {"key": "problem_solving", "label": "Problem solving", "min": 0, "max": 100},
            {"key": "decision_making", "label": "Decision making", "min": 0, "max": 100}
        ]
    }'::jsonb
),
(
    'sde-technical',
    'SDE Technical Interview',
    'technical',
    30,
    'published',
    'You are a software development engineer interviewer. Ask one question at a time about programming, data structures, algorithms, and problem-solving. Evaluate technical correctness and reasoning using the configured rubric.',
    '{
        "scale": {"min": 0, "max": 100},
        "competencies": [
            {"key": "programming", "label": "Programming", "min": 0, "max": 100},
            {"key": "data_structures", "label": "Data structures", "min": 0, "max": 100},
            {"key": "algorithms", "label": "Algorithms", "min": 0, "max": 100},
            {"key": "problem_solving", "label": "Problem solving", "min": 0, "max": 100}
        ]
    }'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    title = EXCLUDED.title,
    kind = EXCLUDED.kind,
    duration_minutes = EXCLUDED.duration_minutes,
    status = EXCLUDED.status,
    system_prompt = EXCLUDED.system_prompt,
    rubric_json = EXCLUDED.rubric_json;

-- ---------------------------------------------------------------------------
-- Template administration. See the header for why interview.access is unused.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_manage_interview_templates()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'ADMIN'
  )
  OR COALESCE((auth.jwt() -> 'user_metadata' ->> 'role'), '') = 'ADMIN'
  OR EXISTS (
    SELECT 1
    FROM public.staff_label_members AS m
    JOIN public.staff_labels AS l ON l.id = m.label_id
    WHERE m.user_id = auth.uid()
      AND l.slug IN ('main_admin', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION public.can_manage_interview_templates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_interview_templates() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Session lifecycle. Students may start and finish their own session.
-- They cannot reassign it or write overall_score. Evaluator writes use
-- service_role (or a database administrator role).
-- ---------------------------------------------------------------------------

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

DROP TRIGGER IF EXISTS interview_sessions_guard ON public.interview_sessions;
CREATE TRIGGER interview_sessions_guard
  BEFORE INSERT OR UPDATE ON public.interview_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.interview_sessions_guard();

-- Keep a turn attached to the session it was written for.
CREATE OR REPLACE FUNCTION public.interview_turns_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.session_id IS DISTINCT FROM OLD.session_id THEN
    RAISE EXCEPTION 'interview turn session cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS interview_turns_guard ON public.interview_turns;
CREATE TRIGGER interview_turns_guard
  BEFORE UPDATE ON public.interview_turns
  FOR EACH ROW
  EXECUTE FUNCTION public.interview_turns_guard();

-- Authenticated students read scores but do not write them.
-- INSERT/UPDATE from the authenticated role is rejected even if a policy
-- is added later. DELETE stays allowed so a session owner can cascade-delete
-- a session; direct deletes are still revoked from authenticated below.
-- service_role bypasses this check so the evaluator can write scores.
CREATE OR REPLACE FUNCTION public.interview_scores_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated' AND TG_OP IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION 'interview scores are written by the evaluator';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.session_id IS DISTINCT FROM OLD.session_id THEN
    RAISE EXCEPTION 'interview score session cannot be changed';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS interview_scores_guard ON public.interview_scores;
CREATE TRIGGER interview_scores_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.interview_scores
  FOR EACH ROW
  EXECUTE FUNCTION public.interview_scores_guard();

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.interview_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_scores ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.interview_templates FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.interview_sessions FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.interview_turns FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.interview_scores FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.interview_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.interview_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.interview_turns TO authenticated;
GRANT SELECT ON TABLE public.interview_scores TO authenticated;

GRANT ALL ON TABLE public.interview_templates TO service_role;
GRANT ALL ON TABLE public.interview_sessions TO service_role;
GRANT ALL ON TABLE public.interview_turns TO service_role;
GRANT ALL ON TABLE public.interview_scores TO service_role;

GRANT EXECUTE ON FUNCTION public.interview_sessions_guard() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.interview_turns_guard() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.interview_scores_guard() TO authenticated, service_role;

-- Templates: published rows for every signed-in user. Drafts only for
-- administrators allowed to manage templates.

DROP POLICY IF EXISTS "Students read published interview templates"
    ON public.interview_templates;
DROP POLICY IF EXISTS "Authenticated read published interview templates"
    ON public.interview_templates;
CREATE POLICY "Authenticated read published interview templates"
ON public.interview_templates
FOR SELECT
TO authenticated
USING (status = 'published');

DROP POLICY IF EXISTS "Authorized staff manage interview templates"
    ON public.interview_templates;
DROP POLICY IF EXISTS "Administrators read interview templates"
    ON public.interview_templates;
CREATE POLICY "Administrators read interview templates"
ON public.interview_templates
FOR SELECT
TO authenticated
USING (public.can_manage_interview_templates());

DROP POLICY IF EXISTS "Administrators insert interview templates"
    ON public.interview_templates;
CREATE POLICY "Administrators insert interview templates"
ON public.interview_templates
FOR INSERT
TO authenticated
WITH CHECK (public.can_manage_interview_templates());

DROP POLICY IF EXISTS "Administrators update interview templates"
    ON public.interview_templates;
CREATE POLICY "Administrators update interview templates"
ON public.interview_templates
FOR UPDATE
TO authenticated
USING (public.can_manage_interview_templates())
WITH CHECK (public.can_manage_interview_templates());

DROP POLICY IF EXISTS "Administrators delete interview templates"
    ON public.interview_templates;
CREATE POLICY "Administrators delete interview templates"
ON public.interview_templates
FOR DELETE
TO authenticated
USING (public.can_manage_interview_templates());

-- Sessions: owner only. Inserts must reference a published template.

DROP POLICY IF EXISTS "Users read own interview sessions"
    ON public.interview_sessions;
CREATE POLICY "Users read own interview sessions"
ON public.interview_sessions
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users create own interview sessions"
    ON public.interview_sessions;
CREATE POLICY "Users create own interview sessions"
ON public.interview_sessions
FOR INSERT
TO authenticated
WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
        SELECT 1
        FROM public.interview_templates AS t
        WHERE t.id = interview_sessions.template_id
          AND t.status = 'published'
    )
);

DROP POLICY IF EXISTS "Users update own interview sessions"
    ON public.interview_sessions;
CREATE POLICY "Users update own interview sessions"
ON public.interview_sessions
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users delete own interview sessions"
    ON public.interview_sessions;
CREATE POLICY "Users delete own interview sessions"
ON public.interview_sessions
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- Turns: every operation is limited to a session the caller owns.
-- The update trigger rejects pointing the turn at a different session.

DROP POLICY IF EXISTS "Users read turns in own sessions"
    ON public.interview_turns;
CREATE POLICY "Users read turns in own sessions"
ON public.interview_turns
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.interview_sessions AS s
        WHERE s.id = interview_turns.session_id
          AND s.user_id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Users insert turns in own sessions"
    ON public.interview_turns;
CREATE POLICY "Users insert turns in own sessions"
ON public.interview_turns
FOR INSERT
TO authenticated
WITH CHECK (
    EXISTS (
        SELECT 1
        FROM public.interview_sessions AS s
        WHERE s.id = interview_turns.session_id
          AND s.user_id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Users update turns in own sessions"
    ON public.interview_turns;
CREATE POLICY "Users update turns in own sessions"
ON public.interview_turns
FOR UPDATE
TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.interview_sessions AS s
        WHERE s.id = interview_turns.session_id
          AND s.user_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1
        FROM public.interview_sessions AS s
        WHERE s.id = interview_turns.session_id
          AND s.user_id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Users delete turns in own sessions"
    ON public.interview_turns;
CREATE POLICY "Users delete turns in own sessions"
ON public.interview_turns
FOR DELETE
TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.interview_sessions AS s
        WHERE s.id = interview_turns.session_id
          AND s.user_id = auth.uid()
    )
);

-- Scores: students read rows for their own sessions. No write policies.

DROP POLICY IF EXISTS "Users read scores in own sessions"
    ON public.interview_scores;
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

DROP POLICY IF EXISTS "Users insert scores in own sessions"
    ON public.interview_scores;
DROP POLICY IF EXISTS "Users update scores in own sessions"
    ON public.interview_scores;
DROP POLICY IF EXISTS "Users delete scores in own sessions"
    ON public.interview_scores;
