-- CRT-002 follow-up. Replaces the deployed student attempt-insert check.
-- Unqualified path_id inside the module subquery bound to crt_modules.path_id,
-- so the comparison did not require the module to belong to the attempt path.
-- Applied to the shared Supabase project yllfccuxohnipleyseup. Do not re-run 20261027_crt_core.sql.

ALTER POLICY "Students insert own crt attempts"
  ON public.crt_attempts
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
