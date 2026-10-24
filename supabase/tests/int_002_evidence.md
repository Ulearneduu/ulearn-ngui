# INT-002 evidence

Date: 2026-10-24
Branch: `feature/int-002-interview-database`
Migration: `supabase/migrations/20261024_interview_core.sql`
Security script: `supabase/tests/int_002_interview_rls.sql`

No secrets, tokens, or payment keys are included.

## Environments

| Environment | Project reference | Result |
|---|---|---|
| Disposable local Postgres-compatible database (PGlite) | none | Migration applied twice. Security script: 0 failed, 0 pending. |
| Connected Supabase project | `yllfccuxohnipleyseup` (`https://yllfccuxohnipleyseup.supabase.co`) | Read-only inspection only. Migration was not applied. |

The connected project is the database named by both `src/environments/environment.ts` (`production: true`) and `src/environments/environment.development.ts`. Supabase MCP `list_branches` returned `{"branches":[]}`. There is no separate development branch on this account. Creating a branch was not attempted: the MCP `create_branch` operation can incur compute charges, and this task does not authorize new infrastructure or applying the schema to the shared project.

## Connected database (read-only)

- `get_project_url`: `https://yllfccuxohnipleyseup.supabase.co`
- `list_branches`: no branches
- Applied migration history includes operational migrations such as `exam_portal` and `stop_all_exams_now`. `20261024_interview_core` is not recorded.
- `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'interview_%'` returned no rows.

Security tests were not run on this database. That is blocked, not a pass.

## Disposable local database

The current migration file was applied, applied again, and then checked. Re-applying it left an unrelated template `custom-keep` as title `Keep me`, status `draft`.

Seed rows after re-apply:

- `hr-behavioral`, `HR Behavioral Interview`, kind `hr`, 20 minutes, `published`
- `sde-technical`, `SDE Technical Interview`, kind `technical`, 30 minutes, `published`

Constraint probes that were expected to fail did fail, and the probe transaction rolled back:

- invalid template `kind`
- `ended_at` before `started_at`
- `overall_score` of 101
- turn `seq` of 0

### Tables and RLS

All four tables existed with row level security enabled:

- `public.interview_templates`
- `public.interview_sessions`
- `public.interview_turns`
- `public.interview_scores`

### Foreign keys defined by the migration

- `interview_sessions.user_id` → `auth.users(id)` ON DELETE CASCADE
- `interview_sessions.template_id` → `interview_templates(id)` ON DELETE RESTRICT
- `interview_turns.session_id` → `interview_sessions(id)` ON DELETE CASCADE
- `interview_scores.session_id` → `interview_sessions(id)` ON DELETE CASCADE

### Indexes confirmed in the local catalog

- `interview_templates_pkey`, `interview_templates_slug_key`
- `idx_interview_sessions_user_started` on `(user_id, started_at DESC)`
- `idx_interview_sessions_template` on `(template_id)`
- `interview_turns_session_seq_unique` and `idx_interview_turns_session_seq` on `(session_id, seq)`
- `interview_scores_session_competency_version_unique` on `(session_id, competency, eval_version)`
- `idx_interview_scores_session` on `(session_id)`

### Policies confirmed in the local catalog

Templates:

- `Authenticated read published interview templates` (SELECT)
- `Administrators read interview templates` (SELECT)
- `Administrators insert interview templates` (INSERT)
- `Administrators update interview templates` (UPDATE)
- `Administrators delete interview templates` (DELETE)

Sessions: owner SELECT, INSERT, UPDATE, DELETE. Inserts also require a published template.

Turns: owner SELECT, INSERT, UPDATE, DELETE through the parent session.

Scores: owner SELECT only. No authenticated insert, update, or delete policy.

Template writes call `public.can_manage_interview_templates()`, which allows `profiles.role = 'ADMIN'`, JWT `user_metadata.role = 'ADMIN'`, or membership in `main_admin` / `admin`. It does not use `interview.access`. `is_admin()` alone is not used, because mentor and campus labels also satisfy `is_admin()`.

### Local security script

`supabase/tests/int_002_interview_rls.sql` against the disposable database: **fail=0, pending=0**.

| Check | Status | Detail |
|---|---|---|
| Published templates readable | pass | both slugs visible |
| Draft templates hidden from student | pass | draft count 0 |
| Student B cannot read Student A's session | pass | |
| Student B cannot update or delete that session | pass | |
| Student B cannot insert a turn | pass | row-level security violation |
| Student B cannot insert a score | pass | permission denied for `interview_scores` |
| Student B cannot read, update, or delete the turn | pass | |
| Ownership change blocked | pass | `interview session ownership cannot be changed` |
| Student cannot write `overall_score` | pass | `overall_score is written by the evaluator` |
| Student cannot insert own score | pass | permission denied |
| Session can be completed and not reopened | pass | |
| Evaluator (`service_role`) can write a score | pass | |
| Student A can read own score | pass | |
| Turn cannot move to another session | pass | `interview turn session cannot be changed` |
| Student B cannot read, update, or delete the score | pass | |
| Owner can delete a session that has scores | pass | |
| Role `ADMIN` can manage templates | pass | |
| `main_admin` label, role `USER`, can manage templates | pass | |
| Student with `interview.access` cannot manage templates | pass | insert denied; `has_permission('interview.access')` true and `can_manage_interview_templates()` false |
| Mentor label plus `interview.access` cannot manage templates | pass | `is_admin()` true, `has_permission('interview.access')` true, management false |

These identities were fixtures inside the disposable database (`int002-student-a@example.test`, `int002-student-b@example.test`, `int002-admin@example.test`, `int002-label-admin@example.test`, `int002-mentor@example.test`). They are not accounts on the connected Supabase project.

## Done When

| Requirement | Status |
|---|---|
| Migration is successfully applied | LOCAL PASS. Not applied to `yllfccuxohnipleyseup`. |
| Four tables, constraints, foreign keys, and indexes exist | LOCAL PASS |
| Both seed templates exist and are published | LOCAL PASS |
| RLS policies enabled and verified | LOCAL PASS |
| Student A cannot read or modify Student B's sessions, turns, or scores | LOCAL PASS |
| Authorized staff can manage templates under the existing model | LOCAL PASS. `interview.access` alone does not grant management. |
| Evidence committed or attached | Recorded in this file. Commit status is reported with the Git result. |

## Remaining blocker

Apply and re-run `supabase/tests/int_002_interview_rls.sql` only after one of these is true:

- explicit approval to change the shared project `yllfccuxohnipleyseup`, or
- a separate development project or Supabase branch is connected, including approval for any branch compute cost.
