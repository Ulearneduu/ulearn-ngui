-- INT-016 usage ledger checks.
-- Run inside a transaction on a database where the INT-016 migration is applied.
-- The block removes its probe session before it returns. Callers that need a
-- guaranteed dry run should ROLLBACK the surrounding transaction.
-- It does not change quota, template-version, or resume objects.

DO $$
DECLARE
  v_user uuid;
  v_template uuid;
  v_prompt text;
  v_admin uuid;
  v_student uuid;
  v_session uuid;
  v_usage uuid;
  v_count integer;
  v_deleted integer;
  v_report jsonb;
  v_filters jsonb;
  v_college text;
  v_batch text;
  v_end timestamptz;
  v_end_again timestamptz;
  v_from timestamptz := '2026-11-09T00:00:00Z';
  v_to timestamptz := '2026-11-10T00:00:00Z';
BEGIN
  IF to_regclass('public.interview_ai_usage') IS NULL
     OR to_regprocedure('public.interview_usage_report(timestamptz,timestamptz,text,text,text,uuid,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'INT-016 migration is not applied';
  END IF;

  IF has_table_privilege('authenticated', 'public.interview_ai_usage', 'INSERT')
     OR has_table_privilege('authenticated', 'public.interview_ai_usage', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.interview_ai_usage', 'SELECT')
     OR has_table_privilege('anon', 'public.interview_ai_usage', 'INSERT')
     OR has_table_privilege('anon', 'public.interview_ai_usage', 'DELETE')
     OR has_table_privilege('anon', 'public.interview_ai_usage', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated or anon has a direct usage privilege';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.interview_ai_usage', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated is missing the cascade delete privilege';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.interview_ai_usage', 'INSERT') THEN
    RAISE EXCEPTION 'service_role cannot insert usage';
  END IF;

  SELECT s.user_id, s.template_id, s.prompt_version
    INTO v_user, v_template, v_prompt
  FROM public.interview_sessions AS s
  ORDER BY s.started_at
  LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'no interview session is available for a rolled-back probe';
  END IF;

  SELECT p.id INTO v_admin
  FROM public.profiles AS p
  WHERE EXISTS (
    SELECT 1
    FROM public.staff_label_members AS m
    JOIN public.staff_label_permissions AS lp ON lp.label_id = m.label_id
    WHERE m.user_id = p.id
      AND lp.permission_key = 'dashboard.view'
  )
  OR (
    p.role = 'ADMIN'
    AND NOT EXISTS (
      SELECT 1 FROM public.staff_label_members AS m WHERE m.user_id = p.id
    )
  )
  LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'no dashboard.view staff member is available for the report check';
  END IF;

  SELECT p.id INTO v_student
  FROM public.profiles AS p
  WHERE COALESCE(p.role, '') <> 'ADMIN'
    AND NOT EXISTS (
      SELECT 1
      FROM public.staff_label_members AS m
      JOIN public.staff_label_permissions AS lp ON lp.label_id = m.label_id
      WHERE m.user_id = p.id
        AND lp.permission_key = 'dashboard.view'
    )
  LIMIT 1;
  IF v_student IS NULL THEN
    RAISE EXCEPTION 'no student without dashboard.view is available';
  END IF;

  SELECT NULLIF(btrim(p.college_name), '') INTO v_college
  FROM public.profiles AS p
  WHERE p.id = v_user;
  v_college := COALESCE(v_college, '__unassigned__');
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.batch_members AS bm WHERE bm.user_id = v_user) THEN NULL
    ELSE '__unassigned__'
  END INTO v_batch;

  INSERT INTO public.interview_sessions (user_id, template_id, prompt_version, status, started_at)
  VALUES (v_user, v_template, v_prompt, 'in_progress', now())
  RETURNING id INTO v_session;

  PERFORM set_config('role', 'service_role', true);
  INSERT INTO public.interview_ai_usage (
    session_id, user_id, call_kind, idempotency_key, provider, model,
    input_tokens, output_tokens, usage_known
  ) VALUES (
    v_session, v_user, 'evaluation', 'int016-probe-key', 'openai', 'gpt-6-luna',
    10, 4, true
  )
  RETURNING id INTO v_usage;

  BEGIN
    INSERT INTO public.interview_ai_usage (
      session_id, user_id, call_kind, idempotency_key, provider, model,
      input_tokens, output_tokens, usage_known
    ) VALUES (
      v_session, v_user, 'evaluation', 'int016-probe-key', 'openai', 'gpt-6-luna',
      10, 4, true
    );
    RAISE EXCEPTION 'duplicate provider key was inserted';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  INSERT INTO public.interview_ai_usage (
    session_id, user_id, call_kind, idempotency_key, provider, model,
    input_tokens, output_tokens, usage_known
  ) VALUES (
    v_session, v_user, 'evaluation', 'int016-probe-key', 'openai', 'gpt-6-luna',
    99, 99, true
  )
  ON CONFLICT ON CONSTRAINT interview_ai_usage_idempotency DO NOTHING;

  SELECT count(*) INTO v_count
  FROM public.interview_ai_usage
  WHERE idempotency_key = 'int016-probe-key';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'idempotent replay changed the ledger count';
  END IF;

  BEGIN
    UPDATE public.interview_ai_usage
      SET input_tokens = 1
    WHERE id = v_usage;
    RAISE EXCEPTION 'usage update was allowed';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE '%immutable%' THEN
        RAISE;
      END IF;
  END;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text,
    true
  );

  BEGIN
    INSERT INTO public.interview_ai_usage (
      session_id, user_id, call_kind, idempotency_key, provider, model,
      input_tokens, output_tokens, usage_known
    ) VALUES (
      v_session, v_user, 'turn', 'int016-probe-auth', 'openai', 'gpt-6-luna',
      1, 1, true
    );
    RAISE EXCEPTION 'authenticated insert was allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  BEGIN
    UPDATE public.interview_ai_usage
      SET model = 'changed'
    WHERE id = v_usage;
    RAISE EXCEPTION 'authenticated update was allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  BEGIN
    DELETE FROM public.interview_ai_usage WHERE id = v_usage;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted <> 0 THEN
      RAISE EXCEPTION 'authenticated direct delete removed usage';
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  PERFORM set_config('role', 'anon', true);
  BEGIN
    PERFORM public.interview_usage_report(v_from, v_to, NULL, NULL, NULL, NULL, 25, 0);
    RAISE EXCEPTION 'anon report was allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  PERFORM set_config('role', 'postgres', true);
  IF NOT EXISTS (SELECT 1 FROM public.interview_ai_usage WHERE id = v_usage) THEN
    RAISE EXCEPTION 'usage row did not survive a direct delete';
  END IF;
  IF (
    SELECT input_tokens
    FROM public.interview_ai_usage
    WHERE id = v_usage
  ) <> 10 THEN
    RAISE EXCEPTION 'idempotent replay overwrote token counts';
  END IF;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  v_report := public.interview_usage_report(v_from, v_to, NULL, NULL, 'in_progress', NULL, 25, 0);
  IF (v_report #>> '{summary,sessionsStarted}') <> '1'
     OR (v_report #>> '{summary,sessionsCompleted}') <> '0'
     OR (v_report #>> '{summary,sessionsWithEnd}') <> '0'
     OR (v_report #>> '{summary,averageElapsedSeconds}') IS NOT NULL
     OR (v_report #>> '{summary,estimatedCost}') IS NOT NULL
     OR (v_report #>> '{summary,costStatus}') <> 'unconfigured'
     OR (v_report #>> '{summary,inputTokens}') <> '10'
     OR (v_report #>> '{summary,outputTokens}') <> '4'
     OR (v_report #>> '{summary,totalTokens}') <> '14' THEN
    RAISE EXCEPTION 'unpriced probe report was %', v_report -> 'summary';
  END IF;
  IF jsonb_array_length(v_report -> 'rows') <> 1 THEN
    RAISE EXCEPTION 'probe report row count does not match the filter';
  END IF;

  v_report := public.interview_usage_report(v_from, v_to, NULL, NULL, 'completed', NULL, 25, 0);
  IF (v_report #>> '{summary,sessionsStarted}') <> '0'
     OR jsonb_array_length(v_report -> 'rows') <> 0 THEN
    RAISE EXCEPTION 'completed filter did not exclude the open probe';
  END IF;

  v_report := public.interview_usage_report(v_from, v_to, v_college, v_batch, NULL, v_template, 25, 0);
  IF (v_report #>> '{summary,sessionsStarted}') <> '1' THEN
    RAISE EXCEPTION 'college, batch, or template filter missed the probe';
  END IF;

  PERFORM set_config('role', 'postgres', true);
  INSERT INTO public.interview_model_rates (
    provider, model, currency, input_per_million, output_per_million, effective_from, source
  ) VALUES (
    'openai', 'gpt-6-luna', 'USD', 3, 15, '2020-01-01', 'INT-016 probe'
  );

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_report := public.interview_usage_report(v_from, v_to, NULL, NULL, NULL, NULL, 25, 0);
  IF (v_report #>> '{summary,estimatedCost}') <> '0.000090'
     OR (v_report #>> '{summary,currency}') <> 'USD'
     OR (v_report #>> '{summary,costStatus}') <> 'estimated' THEN
    RAISE EXCEPTION 'separate input and output rates were not applied: %', v_report -> 'summary';
  END IF;
  v_filters := public.interview_usage_filters();
  IF (v_filters ->> 'pricingConfigured') <> 'true' THEN
    RAISE EXCEPTION 'filters did not notice the probe rate';
  END IF;

  PERFORM set_config('role', 'postgres', true);
  DELETE FROM public.interview_model_rates WHERE source = 'INT-016 probe';

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_report := public.interview_usage_report(v_from, v_to, NULL, NULL, NULL, NULL, 25, 0);
  IF (v_report #>> '{summary,estimatedCost}') IS NOT NULL
     OR (v_report #>> '{summary,costStatus}') <> 'unconfigured' THEN
    RAISE EXCEPTION 'missing price was reported as a cost: %', v_report -> 'summary';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text,
    true
  );
  SELECT f.ended_at INTO v_end
  FROM public.finish_own_interview_session(v_session, 'manual') AS f;
  SELECT f.ended_at INTO v_end_again
  FROM public.finish_own_interview_session(v_session, 'manual') AS f;
  IF v_end IS NULL OR v_end IS DISTINCT FROM v_end_again THEN
    RAISE EXCEPTION 'repeated finish changed the completion timestamp';
  END IF;

  v_report := public.interview_usage_report(v_from, v_to, NULL, NULL, 'completed', NULL, 25, 0);
  IF (v_report #>> '{summary,sessionsStarted}') <> '1'
     OR (v_report #>> '{summary,sessionsCompleted}') <> '1'
     OR (v_report #>> '{summary,sessionsWithEnd}') <> '1'
     OR (v_report #>> '{summary,totalElapsedSeconds}') IS NULL
     OR (v_report #>> '{rows,0,elapsedSeconds}') IS NULL THEN
    RAISE EXCEPTION 'elapsed duration was not reported for the finished probe: %', v_report -> 'summary';
  END IF;

  v_report := public.interview_usage_report(v_from, v_to, NULL, NULL, 'in_progress', NULL, 25, 0);
  IF (v_report #>> '{summary,sessionsStarted}') <> '0' THEN
    RAISE EXCEPTION 'finished probe was still in progress';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_student::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_student, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.interview_usage_report(v_from, v_to, NULL, NULL, NULL, NULL, 25, 0);
    RAISE EXCEPTION 'student report was allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM NOT ILIKE '%forbidden%' THEN
        RAISE;
      END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text,
    true
  );
  DELETE FROM public.interview_sessions WHERE id = v_session;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN
    RAISE EXCEPTION 'session owner could not delete the probe session';
  END IF;

  PERFORM set_config('role', 'postgres', true);
  IF EXISTS (SELECT 1 FROM public.interview_ai_usage WHERE session_id = v_session)
     OR EXISTS (SELECT 1 FROM public.interview_sessions WHERE id = v_session)
     OR EXISTS (SELECT 1 FROM public.interview_model_rates WHERE source = 'INT-016 probe') THEN
    RAISE EXCEPTION 'probe usage, session, or rate was not removed';
  END IF;
END;
$$;
