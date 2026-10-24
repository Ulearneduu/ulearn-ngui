# INT-002 validation report

Date: 2026-10-24
Branch: `feature/int-002-interview-database`
Migration: `supabase/migrations/20261024_interview_core.sql`
Security script: `supabase/tests/int_002_interview_rls.sql`

No credentials or tokens are included.

## Environments

| Environment | What ran | Result |
|---|---|---|
| Disposable local Postgres-compatible database | Migration applied twice, then `supabase/tests/int_002_interview_rls.sql` | fail=0, pending=0 |
| Supabase project `yllfccuxohnipleyseup` | Read-only inspection only | Migration not applied |

`yllfccuxohnipleyseup` (`https://yllfccuxohnipleyseup.supabase.co`) is the project in both the production and development app configs. MCP `list_branches` returned no branches. This run did not apply the migration there and did not create a branch.

Procedure for the local run: apply `20261024_interview_core.sql`, apply it again, insert an unrelated template `custom-keep`, apply the migration a third time, run the security script inside a transaction that rolls back.

## Local results

Repeat apply left `custom-keep` as title `Keep me`, status `draft`.

Published seeds after re-apply:

- `hr-behavioral`, HR Behavioral Interview, `hr`, 20 minutes, `published`
- `sde-technical`, SDE Technical Interview, `technical`, 30 minutes, `published`

Constraint probes rejected an invalid `kind`, an `ended_at` before `started_at`, an `overall_score` of 101, and a turn `seq` of 0. That probe transaction rolled back.

Tables with row level security enabled: `interview_templates`, `interview_sessions`, `interview_turns`, `interview_scores`.

Foreign keys used by the migration and exercised by the inserts and the owner session delete:

- `interview_sessions.user_id` references `auth.users(id)` on delete cascade
- `interview_sessions.template_id` references `interview_templates(id)` on delete restrict
- `interview_turns.session_id` references `interview_sessions(id)` on delete cascade
- `interview_scores.session_id` references `interview_sessions(id)` on delete cascade

Indexes present included `(user_id, started_at DESC)`, `(template_id)`, `(session_id, seq)`, and `(session_id, competency, eval_version)`.

Template writes use `can_manage_interview_templates()`: profile role `ADMIN`, JWT `user_metadata.role = 'ADMIN'`, or membership in `main_admin` or `admin`. `interview.access` is not a management permission.

### Security cases

| Case | Local result | Evidence |
|---|---|---|
| Students read published templates | pass | both slugs visible |
| Students cannot read drafts | pass | draft count 0 |
| Student B cannot read Student A's session | pass | |
| Student B cannot update or delete that session | pass | |
| Student B cannot insert a turn | pass | row-level security violation |
| Student B cannot insert a score | pass | permission denied on `interview_scores` |
| Student B cannot read, update, or delete the turn | pass | |
| Ownership change blocked | pass | interview session ownership cannot be changed |
| Student cannot write `overall_score` | pass | overall_score is written by the evaluator |
| Student cannot insert own score | pass | permission denied |
| Finished session cannot be reopened | pass | |
| Evaluator role can write a score | pass | |
| Student A can read own score | pass | |
| Turn cannot move to another session | pass | interview turn session cannot be changed |
| Student B cannot read, update, or delete the score | pass | |
| Owner can delete a session that has scores | pass | |
| Role `ADMIN` can manage templates | pass | |
| `main_admin` label can manage templates | pass | |
| Student with `interview.access` cannot manage templates | pass | insert denied |
| Mentor who also has `interview.access` cannot manage templates | pass | `is_admin()` true, management false |

Local fixtures were `int002-student-a@example.test`, `int002-student-b@example.test`, `int002-admin@example.test`, `int002-label-admin@example.test`, and `int002-mentor@example.test`. They exist only in the disposable database.

No security case was skipped in that run. None failed.

## Shared Supabase project

Not updated. Earlier read-only checks found no `interview_%` tables and no `20261024_interview_core` migration record. Those checks were not repeated as writes.

## Done When

1. Migration applied to the approved development database: BLOCKED. Local apply passed.
2. Four tables, constraints, foreign keys, and indexes: local pass. Not present on `yllfccuxohnipleyseup`, so the shared database check is BLOCKED.
3. Both seed templates published: local pass. Shared database BLOCKED.
4. RLS enabled and verified: local pass. Shared database BLOCKED.
5. Cross-student protections: local pass. Shared database BLOCKED.
6. Authorized staff template management: local pass. `interview.access` does not grant it. Shared database BLOCKED.
7. Evidence file: this report. Commit status is recorded with the Git result.

## Blocker

Confirm in writing that `yllfccuxohnipleyseup` is the intended database for this schema change, or connect a separate development project or branch and approve any branch cost. Then apply `supabase/migrations/20261024_interview_core.sql` and run `supabase/tests/int_002_interview_rls.sql` there.
