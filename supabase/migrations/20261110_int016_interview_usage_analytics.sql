-- INT-016: Interview usage analytics.
--
-- One row in interview_ai_usage is one accepted provider response.
-- The idempotency key stops a retry of the same turn or evaluation claim
-- from being counted twice. Token columns stay null when the provider
-- response has no usage object. They are never filled with a character-length
-- estimate.
--
-- interview_model_rates starts empty. Estimated cost stays unavailable until
-- an administrator inserts an approved rate. Do not seed guessed prices.
--
-- Cost, when a rate matches the provider, model, and usage date:
--   (input_tokens * input_per_million + output_tokens * output_per_million) / 1000000
-- Rates are currency units per 1,000,000 tokens.
--
-- Duration is elapsed time from started_at to ended_at. Sessions that have
-- not ended are excluded from duration totals. This is not active speaking time.
--
-- Access follows the existing staff permission dashboard.view (Interview Admin).
-- There is no college-scoped staff authorization in this schema, so this
-- migration does not invent one. Students do not have dashboard.view.
-- The report never returns transcripts, resume text, or secrets.
--
-- Keep the aggregate rules aligned with summarizeUsage() in
-- supabase/functions/_shared/interview-usage.ts.

-- The app already stores college on profiles. Some databases created the
-- column outside this migration history, so add it before the report reads it.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS college_name text;

CREATE TABLE IF NOT EXISTS public.interview_ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  call_kind text NOT NULL CHECK (call_kind IN ('turn', 'evaluation')),
  idempotency_key text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  usage_known boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_ai_usage_idempotency UNIQUE (idempotency_key),
  CONSTRAINT interview_ai_usage_tokens_nonnegative CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
  ),
  CONSTRAINT interview_ai_usage_known_shape CHECK (
    (usage_known = true AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL)
    OR usage_known = false
  )
);

CREATE INDEX IF NOT EXISTS idx_interview_ai_usage_session
  ON public.interview_ai_usage (session_id);

CREATE INDEX IF NOT EXISTS idx_interview_sessions_started_at
  ON public.interview_sessions (started_at);

CREATE TABLE IF NOT EXISTS public.interview_model_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  input_per_million numeric NOT NULL CHECK (input_per_million >= 0),
  output_per_million numeric NOT NULL CHECK (output_per_million >= 0),
  effective_from date NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_model_rates_unique UNIQUE (provider, model, currency, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_interview_model_rates_lookup
  ON public.interview_model_rates (provider, model, effective_from DESC);

-- Approved rates are added by a database administrator after review.
-- No rate rows are seeded here. A row needs provider, model, ISO currency,
-- input_per_million, output_per_million, effective_from, and a source note.
-- gpt-6-luna has no approved price in this repository.

CREATE OR REPLACE FUNCTION public.interview_ai_usage_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'interview usage rows are immutable';
  END IF;
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'interview usage is recorded by the server';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS interview_ai_usage_guard ON public.interview_ai_usage;
CREATE TRIGGER interview_ai_usage_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.interview_ai_usage
  FOR EACH ROW
  EXECUTE FUNCTION public.interview_ai_usage_guard();

ALTER TABLE public.interview_ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_model_rates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.interview_ai_usage FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.interview_model_rates FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.interview_ai_usage TO service_role;
GRANT ALL ON TABLE public.interview_model_rates TO service_role;
-- Session owners can cascade-delete usage when they delete their own session.
GRANT DELETE ON TABLE public.interview_ai_usage TO authenticated;

DROP POLICY IF EXISTS "Owners delete usage with their sessions" ON public.interview_ai_usage;
CREATE POLICY "Owners delete usage with their sessions"
ON public.interview_ai_usage
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.interview_sessions AS s
    WHERE s.id = interview_ai_usage.session_id
      AND (s.user_id = auth.uid() OR public.is_admin())
  )
);

REVOKE ALL ON FUNCTION public.interview_ai_usage_guard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.interview_ai_usage_guard() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.interview_usage_report(
  p_from timestamptz,
  p_to timestamptz,
  p_college text DEFAULT NULL,
  p_batch text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_template_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_college text := NULLIF(btrim(COALESCE(p_college, '')), '');
  v_batch text := NULLIF(btrim(COALESCE(p_batch, '')), '');
  v_status text := NULLIF(btrim(COALESCE(p_status, '')), '');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.has_permission('dashboard.view') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'invalid period' USING ERRCODE = '22023';
  END IF;
  IF p_to - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'period too long' USING ERRCODE = '22023';
  END IF;
  IF v_status IS NOT NULL AND v_status NOT IN ('in_progress', 'completed', 'failed') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023';
  END IF;
  IF v_college IS NOT NULL AND char_length(v_college) > 300 THEN
    RAISE EXCEPTION 'invalid college' USING ERRCODE = '22023';
  END IF;
  IF v_batch IS NOT NULL
     AND v_batch <> '__unassigned__'
     AND v_batch !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid batch' USING ERRCODE = '22023';
  END IF;

  WITH filtered AS (
    SELECT
      s.id,
      s.user_id,
      s.template_id,
      s.status,
      s.started_at,
      s.ended_at,
      s.overall_score,
      t.title AS template_title,
      t.kind AS template_kind,
      NULLIF(btrim(p.college_name), '') AS college_name
    FROM public.interview_sessions AS s
    JOIN public.interview_templates AS t ON t.id = s.template_id
    LEFT JOIN public.profiles AS p ON p.id = s.user_id
    WHERE s.started_at >= p_from
      AND s.started_at < p_to
      AND (v_status IS NULL OR s.status = v_status)
      AND (p_template_id IS NULL OR s.template_id = p_template_id)
      AND (
        v_college IS NULL
        OR (v_college = '__unassigned__' AND NULLIF(btrim(p.college_name), '') IS NULL)
        OR (v_college <> '__unassigned__' AND NULLIF(btrim(p.college_name), '') = v_college)
      )
      AND (
        v_batch IS NULL
        OR (
          v_batch = '__unassigned__'
          AND NOT EXISTS (
            SELECT 1 FROM public.batch_members AS bm WHERE bm.user_id = s.user_id
          )
        )
        OR (
          v_batch <> '__unassigned__'
          AND EXISTS (
            SELECT 1
            FROM public.batch_members AS bm
            WHERE bm.user_id = s.user_id
              AND bm.batch_id = v_batch::uuid
          )
        )
      )
  ),
  priced_calls AS (
    SELECT
      u.session_id,
      u.usage_known,
      u.input_tokens,
      u.output_tokens,
      u.provider,
      u.model,
      u.created_at,
      rate.currency,
      CASE
        WHEN u.usage_known AND rate.id IS NOT NULL THEN
          (u.input_tokens::numeric * rate.input_per_million
            + u.output_tokens::numeric * rate.output_per_million) / 1000000
        ELSE NULL
      END AS amount,
      (u.usage_known AND rate.id IS NULL) AS unpriced
    FROM public.interview_ai_usage AS u
    JOIN filtered AS f ON f.id = u.session_id
    LEFT JOIN LATERAL (
      SELECT r.id, r.currency, r.input_per_million, r.output_per_million
      FROM public.interview_model_rates AS r
      WHERE r.provider = u.provider
        AND r.model = u.model
        AND r.effective_from <= (u.created_at AT TIME ZONE 'UTC')::date
      ORDER BY r.effective_from DESC
      LIMIT 1
    ) AS rate ON true
  ),
  usage_by_session AS (
    SELECT
      session_id,
      COUNT(*)::integer AS calls,
      COUNT(*) FILTER (WHERE usage_known)::integer AS known_calls,
      COUNT(*) FILTER (WHERE NOT usage_known)::integer AS unknown_calls,
      COALESCE(SUM(input_tokens) FILTER (WHERE usage_known), 0)::bigint AS known_input,
      COALESCE(SUM(output_tokens) FILTER (WHERE usage_known), 0)::bigint AS known_output,
      COUNT(*) FILTER (WHERE unpriced)::integer AS unpriced_known,
      COUNT(DISTINCT currency) FILTER (WHERE amount IS NOT NULL)::integer AS currencies,
      MIN(currency) FILTER (WHERE amount IS NOT NULL) AS currency_sample,
      SUM(amount) FILTER (WHERE amount IS NOT NULL) AS priced_amount,
      COUNT(DISTINCT model)::integer AS model_count,
      COUNT(DISTINCT provider)::integer AS provider_count,
      (ARRAY_AGG(model ORDER BY created_at))[1] AS model_sample,
      (ARRAY_AGG(provider ORDER BY created_at))[1] AS provider_sample,
      MAX(created_at) AS last_usage_at
    FROM priced_calls
    GROUP BY session_id
  ),
  joined AS (
    SELECT
      f.*,
      u.calls,
      u.known_calls,
      u.unknown_calls,
      u.known_input,
      u.known_output,
      u.unpriced_known,
      u.currencies,
      u.currency_sample,
      u.priced_amount,
      u.model_count,
      u.provider_count,
      u.model_sample,
      u.provider_sample,
      u.last_usage_at,
      CASE
        WHEN u.session_id IS NULL THEN 'no_usage'
        WHEN COALESCE(u.known_calls, 0) = 0 THEN 'unavailable'
        WHEN COALESCE(u.unpriced_known, 0) > 0 THEN 'unconfigured'
        WHEN COALESCE(u.currencies, 0) > 1 THEN 'mixed'
        ELSE 'estimated'
      END AS cost_status,
      CASE
        WHEN u.session_id IS NOT NULL
          AND COALESCE(u.known_calls, 0) > 0
          AND COALESCE(u.unpriced_known, 0) = 0
          AND COALESCE(u.currencies, 0) = 1
          THEN u.priced_amount
        ELSE NULL
      END AS session_cost
    FROM filtered AS f
    LEFT JOIN usage_by_session AS u ON u.session_id = f.id
  ),
  totals AS (
    SELECT
      COUNT(*)::integer AS started,
      COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed,
      COUNT(DISTINCT user_id)::integer AS students,
      ROUND(AVG(overall_score) FILTER (
        WHERE status = 'completed' AND overall_score IS NOT NULL
      ), 2) AS average_score,
      COUNT(*) FILTER (
        WHERE status = 'completed' AND overall_score IS NOT NULL
      )::integer AS scored,
      COUNT(*) FILTER (WHERE ended_at IS NOT NULL)::integer AS with_end,
      COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at))) FILTER (
        WHERE ended_at IS NOT NULL
      ), 0) AS elapsed_sum,
      COALESCE(SUM(known_calls), 0)::integer AS known_calls,
      COALESCE(SUM(unknown_calls), 0)::integer AS unknown_calls,
      COALESCE(SUM(known_input), 0)::bigint AS known_input,
      COALESCE(SUM(known_output), 0)::bigint AS known_output,
      COALESCE(SUM(unpriced_known), 0)::integer AS unpriced_known,
      COALESCE(SUM(CASE WHEN currencies > 1 THEN 1 ELSE 0 END), 0)::integer AS mixed_sessions,
      COUNT(DISTINCT currency_sample) FILTER (
        WHERE COALESCE(known_calls, 0) > 0
          AND COALESCE(unpriced_known, 0) = 0
          AND COALESCE(currencies, 0) = 1
      )::integer AS priced_currencies,
      MIN(currency_sample) FILTER (
        WHERE COALESCE(known_calls, 0) > 0
          AND COALESCE(unpriced_known, 0) = 0
          AND COALESCE(currencies, 0) = 1
      ) AS priced_currency,
      SUM(session_cost) AS priced_sum,
      COALESCE(SUM(COALESCE(calls, 0)), 0)::integer AS all_calls,
      COUNT(*) FILTER (
        WHERE calls IS NULL OR COALESCE(unknown_calls, 0) > 0
      )::integer AS sessions_missing_usage
    FROM joined
  )
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'sessionsStarted', totals.started,
      'sessionsCompleted', totals.completed,
      'completionRate', CASE
        WHEN totals.started = 0 THEN NULL
        ELSE ROUND(totals.completed::numeric * 100 / totals.started, 1)
      END,
      'averageScore', totals.average_score,
      'scoredSessions', totals.scored,
      'scoreScale', '0-100',
      'uniqueStudents', totals.students,
      'inputTokens', CASE WHEN totals.known_calls > 0 THEN totals.known_input ELSE NULL END,
      'outputTokens', CASE WHEN totals.known_calls > 0 THEN totals.known_output ELSE NULL END,
      'totalTokens', CASE
        WHEN totals.known_calls > 0 AND totals.unknown_calls = 0
          THEN totals.known_input + totals.known_output
        ELSE NULL
      END,
      'knownCalls', totals.known_calls,
      'unknownCalls', totals.unknown_calls,
      'sessionsMissingUsage', totals.sessions_missing_usage,
      'estimatedCost', CASE
        WHEN totals.started = 0 THEN NULL
        WHEN totals.all_calls = 0 THEN NULL
        WHEN totals.known_calls = 0 THEN NULL
        WHEN totals.unpriced_known > 0 THEN NULL
        WHEN totals.mixed_sessions > 0 OR totals.priced_currencies > 1 THEN NULL
        ELSE trim(to_char(ROUND(totals.priced_sum, 6), 'FM999999999990.000000'))
      END,
      'currency', CASE
        WHEN totals.started = 0 THEN NULL
        WHEN totals.all_calls = 0 THEN NULL
        WHEN totals.known_calls = 0 THEN NULL
        WHEN totals.unpriced_known > 0 THEN NULL
        WHEN totals.mixed_sessions > 0 OR totals.priced_currencies > 1 THEN NULL
        ELSE totals.priced_currency
      END,
      'costStatus', CASE
        WHEN totals.started = 0 THEN 'none'
        WHEN totals.all_calls = 0 THEN 'unavailable'
        WHEN totals.known_calls = 0 THEN 'unavailable'
        WHEN totals.unpriced_known > 0 THEN 'unconfigured'
        WHEN totals.mixed_sessions > 0 OR totals.priced_currencies > 1 THEN 'mixed'
        ELSE 'estimated'
      END,
      'usageIncomplete', totals.unknown_calls > 0,
      'durationBasis', 'elapsed_start_to_end',
      'averageElapsedSeconds', CASE
        WHEN totals.with_end = 0 THEN NULL
        ELSE ROUND(totals.elapsed_sum / totals.with_end)::bigint
      END,
      'totalElapsedSeconds', CASE
        WHEN totals.with_end = 0 THEN NULL
        ELSE FLOOR(totals.elapsed_sum)::bigint
      END,
      'sessionsWithEnd', totals.with_end,
      'sessionsWithoutEnd', totals.started - totals.with_end,
      'periodFrom', p_from,
      'periodTo', p_to
    ),
    'page', jsonb_build_object(
      'offset', v_offset,
      'limit', v_limit,
      'total', totals.started
    ),
    'rows', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'sessionId', page.id,
          'studentId', page.user_id,
          'collegeName', page.college_name,
          'batchNames', NULLIF((
            SELECT string_agg(b.name, ', ' ORDER BY b.name)
            FROM public.batch_members AS bm
            JOIN public.batches AS b ON b.id = bm.batch_id
            WHERE bm.user_id = page.user_id
          ), ''),
          'templateTitle', page.template_title,
          'templateKind', page.template_kind,
          'startedAt', page.started_at,
          'endedAt', page.ended_at,
          'status', page.status,
          'elapsedSeconds', CASE
            WHEN page.ended_at IS NULL THEN NULL
            ELSE FLOOR(EXTRACT(EPOCH FROM (page.ended_at - page.started_at)))::bigint
          END,
          'inputTokens', CASE WHEN COALESCE(page.known_calls, 0) > 0 THEN page.known_input ELSE NULL END,
          'outputTokens', CASE WHEN COALESCE(page.known_calls, 0) > 0 THEN page.known_output ELSE NULL END,
          'totalTokens', CASE
            WHEN COALESCE(page.known_calls, 0) > 0 AND COALESCE(page.unknown_calls, 0) = 0
              THEN page.known_input + page.known_output
            ELSE NULL
          END,
          'usageState', CASE
            WHEN page.calls IS NULL THEN 'none'
            WHEN COALESCE(page.unknown_calls, 0) = 0 THEN 'known'
            WHEN COALESCE(page.known_calls, 0) = 0 THEN 'unknown'
            ELSE 'partial'
          END,
          'provider', CASE
            WHEN page.calls IS NULL THEN NULL
            WHEN COALESCE(page.provider_count, 0) > 1 THEN 'multiple'
            ELSE page.provider_sample
          END,
          'model', CASE
            WHEN page.calls IS NULL THEN NULL
            WHEN COALESCE(page.model_count, 0) > 1 THEN 'multiple'
            ELSE page.model_sample
          END,
          'estimatedCost', CASE
            WHEN page.session_cost IS NULL THEN NULL
            ELSE trim(to_char(ROUND(page.session_cost, 6), 'FM999999999990.000000'))
          END,
          'currency', CASE
            WHEN page.session_cost IS NULL THEN NULL
            ELSE page.currency_sample
          END,
          'costStatus', page.cost_status,
          'score', CASE
            WHEN page.status = 'completed' THEN page.overall_score
            ELSE NULL
          END,
          'lastUsageAt', page.last_usage_at
        )
        ORDER BY page.started_at DESC, page.id DESC
      )
      FROM (
        SELECT *
        FROM joined
        ORDER BY started_at DESC, id DESC
        OFFSET v_offset
        LIMIT v_limit
      ) AS page
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM totals;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.interview_usage_filters()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.has_permission('dashboard.view') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'colleges', COALESCE((
      SELECT jsonb_agg(college_name ORDER BY college_name)
      FROM (
        SELECT DISTINCT NULLIF(btrim(p.college_name), '') AS college_name
        FROM public.interview_sessions AS s
        JOIN public.profiles AS p ON p.id = s.user_id
        WHERE NULLIF(btrim(p.college_name), '') IS NOT NULL
      ) AS colleges
    ), '[]'::jsonb),
    'unassignedCollege', EXISTS (
      SELECT 1
      FROM public.interview_sessions AS s
      LEFT JOIN public.profiles AS p ON p.id = s.user_id
      WHERE NULLIF(btrim(p.college_name), '') IS NULL
    ),
    'batches', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name)
      FROM (
        SELECT DISTINCT b.id, b.name
        FROM public.batches AS b
        JOIN public.batch_members AS bm ON bm.batch_id = b.id
        WHERE EXISTS (
          SELECT 1 FROM public.interview_sessions AS s WHERE s.user_id = bm.user_id
        )
      ) AS batches
    ), '[]'::jsonb),
    'unassignedBatch', EXISTS (
      SELECT 1
      FROM public.interview_sessions AS s
      WHERE NOT EXISTS (
        SELECT 1 FROM public.batch_members AS bm WHERE bm.user_id = s.user_id
      )
    ),
    'templates', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('id', id, 'title', title, 'kind', kind)
        ORDER BY title
      )
      FROM (
        SELECT t.id, t.title, t.kind
        FROM public.interview_templates AS t
        WHERE EXISTS (
          SELECT 1 FROM public.interview_sessions AS s WHERE s.template_id = t.id
        )
      ) AS templates
    ), '[]'::jsonb),
    'pricingConfigured', EXISTS (SELECT 1 FROM public.interview_model_rates)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.interview_usage_report(timestamptz, timestamptz, text, text, text, uuid, integer, integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.interview_usage_filters() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.interview_usage_report(timestamptz, timestamptz, text, text, text, uuid, integer, integer)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.interview_usage_filters() TO authenticated, service_role;
