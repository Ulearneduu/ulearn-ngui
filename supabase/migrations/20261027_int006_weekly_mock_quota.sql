-- INT-006: Weekly AI mock interview quota.
-- Default: 5 sessions per student per IST week.
-- Local migration draft: do not deploy until tested.

CREATE TABLE IF NOT EXISTS public.interview_quota_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  weekly_limit integer NOT NULL DEFAULT 5
    CHECK (weekly_limit > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

INSERT INTO public.interview_quota_config (id, weekly_limit)
VALUES (1, 5)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.interview_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'abandoned', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS interview_sessions_user_started_idx
  ON public.interview_sessions (user_id, started_at);

CREATE TABLE IF NOT EXISTS public.interview_quota_user_locks (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Dedicated permission for managing the quota.
INSERT INTO public.staff_permissions (key, group_name, label, sort_order)
VALUES (
  'interview_quota.manage',
  'Student features',
  'Manage Interview Quota',
  220
)
ON CONFLICT (key) DO UPDATE
SET group_name = EXCLUDED.group_name,
    label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order;

-- Only the existing main_admin and admin labels receive this permission.
INSERT INTO public.staff_label_permissions (label_id, permission_key)
SELECT l.id, 'interview_quota.manage'
FROM public.staff_labels l
WHERE l.slug IN ('main_admin', 'admin')
ON CONFLICT DO NOTHING;

ALTER TABLE public.interview_quota_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_quota_user_locks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.interview_quota_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.interview_quota_config TO service_role;

REVOKE ALL ON public.interview_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.interview_sessions TO authenticated;
GRANT ALL ON public.interview_sessions TO service_role;

REVOKE ALL ON public.interview_quota_user_locks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.interview_quota_user_locks TO service_role;

DROP POLICY IF EXISTS "Students read own interview sessions"
  ON public.interview_sessions;

CREATE POLICY "Students read own interview sessions"
  ON public.interview_sessions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());