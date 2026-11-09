# INT-018 — Interview QA checklist and product-owner demo

## A. Purpose

INT-018 checks that a student can use the Interview feature from permission through a finished HR mock, and that a product owner can see the value of that flow. The check covers access, starting an HR mock, the chat, the scorecard and practice tips, and the weekly quota. Mentor score review (INT-015) is included only because that implementation is present in this repository.

This pass inspected the source on `docs/int-018-interview-qa-demo` at `27913c7f` and ran the automated interview tests that do not write to a database. It did not sign in, did not create a session, and did not call a live model. The shared Supabase project used by the deployed app must not be used for this demo.

## B. Prerequisites

Use a disposable project or a local Supabase stack that is not the production project. Do not use a real student account, and do not paste credentials, access tokens, or API keys into notes or screenshots.

| Prerequisite | What to confirm |
| --- | --- |
| Student account | A `USER` profile that can sign in. No personal student data. |
| Allowed Interview | The account's label includes permission `interview.access`. The seeded label slug is `allowed_interview`. The label is shown in admin as **Allowed Interview**. |
| Unauthorized student | A second `USER` profile with no `interview.access` label. |
| HR template | Published template slug `hr-behavioral`, title **HR Behavioral Interview**, kind `hr`, duration 20 minutes. Seeded by the INT-002 core migration. Rubric competencies: Communication, Teamwork, Problem solving, Decision making. |
| Weekly quota | Row `interview_quota_config.id = 1` with a positive `weekly_limit` (seed default 5). The student must have remaining attempts in the current Asia/Kolkata week before the demo. |
| Edge Functions | `interview-quota-status`, `interview-turn`, and `interview-evaluate`, deployed with JWT verification. `interview-start` exists in the repo but the catalog **Start** button does not call it. |
| Model secret | `OPENAI_API_KEY` set only as an Edge Function secret. Optional `INTERVIEW_AI_PROVIDER=openai` and `INTERVIEW_AI_MODEL`. Do not put the key in Angular environment files. |
| Database RPCs | `get_interview_quota_status`, `finish_own_interview_session`. For mentor review: `list_interview_review_queue`, `get_interview_review_detail`, `apply_interview_score_override`, `set_interview_mentor_review_published`. |

INT-015 is implemented in this tree (migration `supabase/migrations/20261109_interview_score_overrides.sql`, admin UI, PR [#72](https://github.com/madhukiraneluri/ulearn-ngui/pull/72)). It is a **score** override, not a quota override.

Mentor review additionally needs:

- An admin-portal account. A user with staff-label membership does not receive every permission automatically.
- Permission `interview.reviews` (**Review interview scores** in `STAFF_PERMISSIONS`) assigned on that account's label. The INT-015 migration checks the key and does not grant it to an existing label.
- A completed session whose evaluation succeeded. Overrides are rejected for in-progress, failed, or unevaluated sessions.

## C. End-to-end QA checklist

Routes used below:

- Catalog: `/interview`
- Chat: `/interview/session/:id`
- Scorecard: `/interview/session/:id/result`
- Mentor queue: `/admin/interview/reviews`

Quota numbers come from `interview-quota-status`, which calls `get_interview_quota_status`. That function counts `interview_sessions` rows for the signed-in user whose `started_at` falls in the current Monday-based Asia/Kolkata week. The catalog card shows `{used} / {weekly_limit} attempts used` and `{remaining} remaining`.

The catalog **Start** button calls `InterviewCatalogService.startSession`. That inserts one `in_progress` row for the selected published template and pins `prompt_version` and `template_version_id`. It does not call `start_interview_with_quota`. See bug QA-INT018-001.

Manual tests below were **not executed** in this pass. Status is NOT RUN. Expected results are taken from the current source so the team can run them without guessing.

### Test 1: Student access

| | |
| --- | --- |
| Test ID | QA-INT018-T1 |
| Preconditions | Both accounts exist. HR template is published. Student A has `interview.access`. Student B does not. |
| Steps | 1. Sign in as Student A. 2. Open `/interview`. 3. Confirm the HR group lists **HR Behavioral Interview**. 4. Sign out. 5. Sign in as Student B. 6. Open `/interview` directly. |
| Expected result | Student A reaches the catalog and can see the published HR template. Student B is redirected to `/` by `featurePermissionGuard` and does not see the catalog. Missing sessions and another student's session id both resolve as unavailable on the session and result pages. |
| Actual result | Not executed. Source inspection: the `/interview` route requires `authGuard`, `blockExamOnlyGuard`, and `featurePermissionGuard` with `interview.access`. The session insert policy checks the owner and a published template. It does not check `interview.access`. See QA-INT018-002. |
| Status | NOT RUN |
| Evidence | `src/app/app.routes.ts`, `src/app/core/guards/feature-permission-guard.ts`, `supabase/migrations/20261111000000_interview_core.sql` policy "Users create own interview sessions". |

### Test 2: Start HR mock

| | |
| --- | --- |
| Test ID | QA-INT018-T2 |
| Preconditions | Student A is signed in, quota remaining is at least 1, and **HR Behavioral Interview** is published. Leave the optional resume empty for this pass. |
| Steps | 1. On `/interview`, record the quota line and the HR card title and duration. 2. Click **Start** once on **HR Behavioral Interview**. 3. Confirm the URL is `/interview/session/{id}` and the title is **HR Behavioral Interview**. 4. Confirm the timer starts at 20:00. 5. Refresh the session page. 6. Return to `/interview` and confirm a second in-progress card was not created by that single click. |
| Expected result | One session row exists for this student and this start. `template_id` is the `hr-behavioral` template, `status` is `in_progress`, `prompt_version` and `template_version_id` are set, and `ended_at` is null. Refresh keeps the same id and the same end time (`started_at` + 20 minutes). The **Start** control sets an in-flight id before the insert, so one click does not insert two rows. A second browser tab can still start another session. |
| Actual result | Not executed. |
| Status | NOT RUN |
| Evidence | `Interview.start` and `InterviewCatalogService.startSession` in `src/app/interview/interview.ts` and `interview-catalog.service.ts`. |

### Test 3: Complete interview chat

| | |
| --- | --- |
| Test ID | QA-INT018-T3 |
| Preconditions | Test 2 session is `in_progress` and inside its 20 minutes. `interview-turn` is deployed and the model secret is set. |
| Steps | 1. Click **Ask the first question** (the draft is "I am ready. Please ask the first question."). 2. Send at least two further answers that respond to the question on screen. 3. Confirm each answer and the following interviewer question appear in order. 4. Click **End Interview** and confirm in the dialog. 5. Try to send another answer. |
| Expected result | Each successful send stores a `user` turn and the following `assistant` turn with increasing `seq`. A retry of the same send reuses `clientTurnId` and does not create a second pair. **End Interview** calls `finish_own_interview_session` with mode `manual`. `interview_sessions.status` becomes `completed` and `ended_at` is set. The app navigates to `/interview/session/{id}/result` and calls `interview-evaluate`. A later answer is rejected. The browser does not call the model directly. |
| Actual result | Not executed. No live model call was made. |
| Status | NOT RUN |
| Evidence | `src/app/interview/interview-session.ts`, `docs/interview/INT-005.md`, `supabase/functions/interview-turn`. |

### Test 4: Scorecard and tips

| | |
| --- | --- |
| Test ID | QA-INT018-T4 |
| Preconditions | Test 3 session is `completed` and has at least one question and one answer. `interview-evaluate` is deployed. |
| Steps | 1. Stay on `/interview/session/{id}/result`. 2. Wait for the scorecard. Use **Try again** if evaluation is still processing. 3. Read the overall score, competency rows, strengths, areas for improvement, and **Your Next Steps**. 4. Refresh the result page. 5. In the database, read only this session: `user_id`, `evaluation_status`, `eval_version`, `overall_score`, `evaluation_tips`, and `interview_scores` for that `eval_version`. |
| Expected result | A successful evaluation shows the competency scorecard (HR rubric: Communication, Teamwork, Problem solving, Decision making, unless a competency was marked not applicable), feedback text, and an overall score that is the stored mean. **Your Next Steps** appears when 3–5 tips were saved, with the subtitle "Personalized recommendations based on your interview performance." Refresh shows the same saved snapshot. `user_id` is Student A and `eval_version` is `INT008-v1` for a new evaluation. An evaluation that failed stays on a completed interview and does not show a scorecard. Snapshots saved before tips existed keep **Your Next Steps** hidden. |
| Actual result | Not executed. Parser and tip rules passed in unit tests. The result page was not opened in a browser. |
| Status | NOT RUN |
| Evidence | `src/app/interview/interview-result.ts`, `docs/interview/INT-008.md`, `docs/interview/INT-010.md`. Automated: `interview-evaluation.spec.ts`, `interview-evaluate-policy.test.ts`. |

### Test 5: Quota deduction

| | |
| --- | --- |
| Test ID | QA-INT018-T5 |
| Preconditions | Student A can open `/interview`. Record `used`, `weekly_limit`, `remaining`, and `resets_at` from the **This week** card before starting. Those values must match `get_interview_quota_status` for that user. |
| Steps | 1. Record the quota before **Start**. 2. Start one HR session (Test 2). 3. Before answering, open `/interview` again and record the quota. 4. Complete the interview (Test 3). 5. Open `/interview` again and record the quota. 6. On a session that never gets a row (permission denied, or **Start** blocked because remaining is already 0), record the quota again. 7. Send one answer, let that request fail before any turn is saved, and confirm the quota did not change because of the failed turn. |
| Expected result | Creating the session row increases `used` by 1 and decreases `remaining` by 1. Completing the interview does not subtract a second attempt. An in-progress or failed session in the same week still counts. A failed turn, a failed evaluation, and a second read of the same session do not add another session row. The catalog card matches `get_interview_quota_status` after a fresh load. When the loaded `remaining` is 0, the **Start** button is disabled. The database insert used by **Start** does not itself reject an over-quota insert. See QA-INT018-001. |
| Actual result | Not executed. No quota row was read or changed. |
| Status | NOT RUN |
| Evidence | `get_interview_quota_status` in `supabase/migrations/20261027_int006_weekly_mock_quota_functions.sql`. Catalog load and disable logic in `src/app/interview/interview.ts` and `interview.service.ts`. |

### Test 6: Mentor override (INT-015)

INT-015 **is implemented** in this repository. This test was not run against a database. It is not a quota or session-status override.

| | |
| --- | --- |
| Test ID | QA-INT018-T6 |
| Preconditions | INT-015 migration is applied on the isolated database. Reviewer has `interview.reviews`. A second account does not. Test 4 session is `completed`, `evaluation_status` is `completed`, and `mentor_review_published` is false. |
| Steps | 1. Sign in as the reviewer and open `/admin/interview/reviews`. 2. Open the Test 4 session. 3. Submit a competency or overall score from 0 to 100 that differs from the current effective score, with a reason of at least 10 characters. 4. Confirm an override row exists and that `interview_scores` and `interview_sessions.overall_score` are unchanged. 5. Leave the review unpublished, sign in as Student A, and reload the result page. 6. Publish the review. Reload the student result page. 7. Sign in as an account without `interview.reviews` and call the review screen or RPC. 8. Record quota `used` and session `status` before and after the override. |
| Expected result | The reviewer can append one `interview_score_overrides` row. `mentor_id` is the signed-in reviewer. Update and delete of that history are rejected. The AI score rows stay as stored. While unpublished, the student still sees the AI scores. After publish, the result page shows the effective score and "Mentor-adjusted" where a competency changed. An account without `interview.reviews` is denied. Session `status` stays `completed`. Quota `used` does not change, because no new session row is inserted. |
| Actual result | Not executed. Source and unit checks for the merge rules passed. `supabase/tests/int_015_score_overrides_rls.sql` was not run. |
| Status | NOT RUN |
| Evidence | `supabase/migrations/20261109_interview_score_overrides.sql`, `src/app/admin/interview/reviews/`, `src/app/interview/interview-score-overrides.ts`. Implementation PR [#72](https://github.com/madhukiraneluri/ulearn-ngui/pull/72). |

## D. Demo script for product owner

Plan 5–10 minutes. Use the disposable accounts from section B. Speak from the product, not from the schema.

1. Sign in as the student who has **Allowed Interview**. Open `/interview`. Point out the weekly quota card and the **HR** group.
2. Record the quota aloud (`used`, limit, remaining, reset time). Leave the resume empty so the demo stays on the HR script.
3. Start **HR Behavioral Interview**. Show the 20-minute timer and the session URL.
4. Ask for the first question, answer two or three questions, and end the interview from the confirmation dialog.
5. On the result page, show the overall score, the competency scorecard, strengths, areas for improvement, and **Your Next Steps**.
6. Return to `/interview` and show the quota again. The new session counts as one attempt from the moment it was started. Finishing does not take a second attempt.
7. If the reviewer account and a completed evaluation are ready, sign in as the reviewer, open `/admin/interview/reviews`, adjust one score with a written reason, publish it, and reload the student result to show the mentor-adjusted score. State that the original AI score is still stored and that quota is unchanged. Skip this step if `interview.reviews` is not assigned on the isolated project.

Value to state in the demo: a student with permission can practise an HR conversation, receive a saved scorecard and concrete next steps, and see how many mock attempts remain this week. A reviewer can correct a score without erasing the AI result, and the student sees that correction only after it is published.

Do not run this script on the shared production Supabase project. This document's author did not perform the live demo.

## E. Bug and issue tracker

These items were found by reading the current source. They were not reproduced on a running database. No existing issue was identified in the local history for either item. Automated tests did not cover the catalog insert versus the quota RPC.

| Bug ID | Description | Severity | Reproduction steps | Expected behavior | Actual behavior | Related file/function | Related issue/PR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QA-INT018-001 | Weekly quota is not enforced on the path the student uses to start an interview. | High | 1. Load `/interview` and note `remaining`. 2. Compare `Interview.start` with `InterviewService.startInterview`. 3. Read the insert in `startSession` and the limit check in `start_interview_with_quota`. 4. On an isolated database only, insert or start one more session after `remaining` is 0, using the catalog insert rather than the quota RPC. | A new mock either consumes one weekly attempt inside a locked check, or is rejected when `used >= weekly_limit`. Failed requests that do not create a session do not consume an attempt. | The catalog inserts `interview_sessions` directly and only disables **Start** after the client has loaded `remaining === 0`. `start_interview_with_quota` contains the limit check, but nothing in `src/app` calls `startInterview`. That RPC still inserts `status = 'started'` and does not set `template_id` or `prompt_version`, which the current session table does not accept. Usage counts every session in the IST week at insert time, including incomplete sessions. Completion does not decrement again. | `Interview.start`, `InterviewCatalogService.startSession`, `InterviewService.startInterview`, `start_interview_with_quota`, `get_interview_quota_status` | None found | Open |
| QA-INT018-002 | A signed-in user without Allowed Interview is blocked from the page, but the session insert policy does not require `interview.access`. | Medium | 1. Sign in as Student B on an isolated project. 2. Confirm `/interview` redirects to `/`. 3. Insert an `interview_sessions` row for a published template through the Data API as that user. | Session creation requires the same `interview.access` permission as the route and as `interview-turn` / `interview-evaluate`. | The route guard checks `interview.access`. Policy "Users create own interview sessions" checks `auth.uid() = user_id` and a published template only. | `featurePermissionGuard`, `20261111000000_interview_core.sql` | None found | Open |

No other defects were identified in the automated checks that passed. That is not a claim that the live interview flow is free of defects.

Suggested direction for QA-INT018-001, for the quota owner: make catalog start call one server operation that locks the student, checks `interview.access` and the weekly count, and inserts a single `in_progress` row for the selected published template. Do not change the INT-002, INT-006, or INT-016 migrations as part of INT-018.

Suggested direction for QA-INT018-002: add `has_permission('interview.access')` to the student session insert policy or to a before-insert guard. Leave the change to the schema owner.

## F. Test evidence

| Item | Value |
| --- | --- |
| Date | 9 November 2026 |
| Git revision inspected | `27913c7f` on `docs/int-018-interview-qa-demo` (same commit as `upstream/master` at the start of this task) |
| Environment | Local working tree on Windows. Node.js 24.18.1. Deno 2.9.8. No browser. No Supabase API calls. No session rows created. No quota changes. |
| Account used | None. Automated tests use fixtures in memory or source assertions. |
| Browser / device | Not used. |

Automated commands and results:

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --test` on `src/app/interview/*.spec.ts`, `interview-turn.source.test.ts`, `interview-evaluate.source.test.ts`, and the `_shared` interview `*.test.ts` files except the Deno-only file | 105 passed, 1 failed. The failure is `interview-rpc-errors_test.ts` because that file calls `Deno.test` and was invoked with Node. It is not an application failure. |
| `deno test supabase/functions/_shared/interview-rpc-errors_test.ts` | 5 passed, 0 failed. |
| `node scripts/test-interview-score-overrides.mjs` | Passed (INT-015 source contract). |
| `node scripts/test-interview-coding.mjs` | Passed. |
| `node scripts/test-interview-redo.mjs` | Passed. |
| `node scripts/test-interview-template-versioning.mjs` | Passed. |
| `npx tsc -p tsconfig.app.json --noEmit` | Passed. |

Not run, and why:

- Manual Tests 1–6 and the product-owner demo. The deployed app and the development app have previously shared one Supabase project. Creating a session there would consume a real quota and store interview data.
- `supabase/tests/int_015_score_overrides_rls.sql` and the other `supabase/tests/int_*.sql` scripts. They require a local superuser database. No isolated database was started.
- `ng test` is not configured in `package.json` / `angular.json` as an interview suite. Interview specs are Node tests and were run above.
- `supabase db push` and any remote migration or deploy command.

There are no screenshots or runtime logs from a live interview.

## G. Final QA summary

| | |
| --- | --- |
| Total checklist tests | 6 |
| Passed | 0 |
| Failed | 0 |
| Blocked | 0 |
| Not run | 6 |
| Outstanding bugs | QA-INT018-001, QA-INT018-002. Both open. No issue or PR link. |
| Mentor override | Implemented in source (INT-015, PR #72). Live override was not executed. It changes published display scores and writes an append-only audit row. It does not change quota or session status. |
| Overall demo readiness | **BLOCKED** |

The demo script in section D is specific enough to run on an isolated project. It is blocked until that project has the published HR template, quota configuration, Allowed Interview student, model secret, and the three Edge Functions listed in section B. Do not treat the automated unit tests as a completed product-owner demo.
