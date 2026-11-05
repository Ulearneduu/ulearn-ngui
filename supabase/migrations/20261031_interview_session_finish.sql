-- Finish an interview with the database clock.
-- Apply only this file to yllfccuxohnipleyseup. Do not run supabase db push.
--
-- manual: the owner ends the interview now. ended_at is the database clock.
-- expired: if the allotted time has passed, ended_at is started_at + duration.
-- A session that is already finished is returned unchanged, so a repeat
-- cannot overwrite the original ended_at or reopen it.

create or replace function public.finish_own_interview_session(
  p_session_id uuid,
  p_mode text
)
returns table (
  id uuid,
  status text,
  ended_at timestamptz,
  started_at timestamptz,
  server_now timestamptz,
  ends_at timestamptz,
  time_up boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_session public.interview_sessions%rowtype;
  v_duration integer;
  v_ends timestamptz;
  v_now timestamptz := now();
  v_id uuid;
begin
  if p_mode is distinct from 'manual' and p_mode is distinct from 'expired' then
    raise exception 'This interview could not be ended.' using errcode = '22023';
  end if;

  select * into v_session
  from public.interview_sessions
  where interview_sessions.id = p_session_id
  for update;

  if not found or v_session.user_id is distinct from auth.uid() then
    raise exception 'This interview could not be ended.' using errcode = '42501';
  end if;

  select interview_templates.duration_minutes into v_duration
  from public.interview_templates
  where interview_templates.id = v_session.template_id;

  if v_duration is null or v_duration <= 0 then
    raise exception 'This interview could not be ended.' using errcode = '42501';
  end if;

  v_ends := v_session.started_at + make_interval(mins => v_duration);
  v_id := v_session.id;

  if v_session.status = 'in_progress' and p_mode = 'manual' then
    update public.interview_sessions
      set status = 'completed',
          ended_at = v_now
      where interview_sessions.id = v_id
        and interview_sessions.status = 'in_progress'
      returning * into v_session;
  elsif v_session.status = 'in_progress' and p_mode = 'expired' and v_ends <= v_now then
    update public.interview_sessions
      set status = 'completed',
          ended_at = v_ends
      where interview_sessions.id = v_id
        and interview_sessions.status = 'in_progress'
      returning * into v_session;
  end if;

  if v_session.id is null then
    select * into v_session
    from public.interview_sessions
    where interview_sessions.id = v_id;
  end if;

  return query
  select
    v_session.id,
    v_session.status,
    v_session.ended_at,
    v_session.started_at,
    v_now,
    v_ends,
    v_ends <= v_now;
end;
$$;

revoke all on function public.finish_own_interview_session(uuid, text) from public;
revoke all on function public.finish_own_interview_session(uuid, text) from anon;
grant execute on function public.finish_own_interview_session(uuid, text) to authenticated;
