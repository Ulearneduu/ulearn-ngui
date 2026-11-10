# INT-018 — Interview QA checklist and product-owner demo

## A. Purpose

INT-018 checks that a student can use the Interview feature from permission through a finished HR mock, and that a product owner can see the value of that flow. The check covers access, starting an HR mock, the chat, the scorecard and practice tips, and the weekly quota. Mentor score review (INT-015) is included only because that implementation is present in this repository.

On 10 November 2026 the checklist was run in a browser against the isolated local project `ulearn-int018-local`. The shared production project was not used. The product-owner meeting itself was not held.

## B. Prerequisites

Use a disposable project or a local Supabase stack that is not the production project. Do not use a real student account, and do not paste credentials, access tokens, or API keys into notes or screenshots.

| Prerequisite | What to confirm |
| --- | --- |
| Student account | A `USER` profile that can sign in. No personal student data. |
| Allowed Interview | The account's label includes permission `interview.access`. The seeded label slug is `allowed_interview`. The label is shown in admin as **Allowed Interview**. |
| Unauthorized student | A second `USER` profile with no `interview.access` label. |
| HR template | Published template slug `hr-behavioral`, title **HR Behavioral Interview**, kind `hr`, duration 20 minutes. Seeded by the INT-002 core migration. Rubric competencies: Communication, Teamwork, Problem solving, Decision making. |
| Weekly quota | Row `interview_quota_config.id = 1` with a positive `weekly_limit` (seed default 5). The student must have remaining attempts in the current Asia/Kolkata week before the demo. |
| Edge Functions | `interview-start`, `interview-quota-status`, `interview-turn`, and `interview-evaluate` on the local stack. Catalog **Start** calls `interview-start`. |
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

The catalog **Start** button calls `InterviewCatalogService.startSession`, which calls `interview-start` and `start_interview_with_quota`. That function checks `interview.access`, locks the weekly count, and inserts one `in_progress` row with the current published template version. Direct inserts are rejected. See `supabase/migrations/20261110180000_int018_quota_start_and_rls.sql`.

Mark a test **PASS** only when its expected result is observed on an isolated project. On 10 November 2026 these six tests were executed in the browser against `ulearn-int018-local` (`127.0.0.1:54521`). The shared production project was not used. Chat and evaluation used the local Edge runtime's configured model. The product-owner demo was not conducted.

### Test 1: Student access

| | |
| --- | --- |
| Test ID | QA-INT018-T1 |
| Preconditions | Both accounts exist. HR template is published. Student A has `interview.access`. Student B does not. |
| Steps | 1. Sign in as Student A. 2. Open `/interview`. 3. Confirm the HR group lists **HR Behavioral Interview**. 4. Sign out. 5. Sign in as Student B. 6. Open `/interview` directly. |
| Expected result | Student A reaches the catalog and can see the published HR template. Student B is redirected to `/` by `featurePermissionGuard` and does not see the catalog. Missing sessions and another student's session id both resolve as unavailable on the session and result pages. |
| Actual result | Browser, local. `int018.student@example.test` opened `/interview` and saw HR Behavioral Interview. `int018.denied@example.test` was returned to `/`. A direct `interview_sessions` insert with that signed-in session returned HTTP 403, `42501`, row-level security. |
| Status | PASSED |
| Evidence | Browser on `http://127.0.0.1:4200`. Screenshot `int018-t1-catalog.png`. |

### Test 2: Start HR mock

| | |
| --- | --- |
| Test ID | QA-INT018-T2 |
| Preconditions | Student A is signed in, quota remaining is at least 1, and **HR Behavioral Interview** is published. Leave the optional resume empty for this pass. |
| Steps | 1. On `/interview`, record the quota line and the HR card title and duration. 2. Click **Start** once on **HR Behavioral Interview**. 3. Confirm the URL is `/interview/session/{id}` and the title is **HR Behavioral Interview**. 4. Confirm the timer starts at 20:00. 5. Refresh the session page. 6. Open `/interview/history` and confirm that this start added one **In progress** row for **HR Behavioral Interview**. The catalog itself lists templates, not sessions. |
| Expected result | One session row exists for this student and this start. `template_id` is the `hr-behavioral` template, `status` is `in_progress`, `prompt_version` and `template_version_id` are set, and `ended_at` is null. Refresh keeps the same id and the same end time (`started_at` + 20 minutes). The **Start** control sets an in-flight id before the insert, so one click does not insert two rows. A second browser tab can still start another session. |
| Actual result | Browser, local. Quota before start was `0 / 5`. The catalog start called `interview-start` (HTTP 200) and opened one session. Database: one `in_progress` row, `prompt_version` 1, current `hr-behavioral` version, 20-minute timer showing 19:40. |
| Status | PASSED |
| Evidence | Session `a0d7f465-99e4-4ed3-bd49-92194553cfd3` on `127.0.0.1:54522`. |

### Test 3: Complete interview chat

| | |
| --- | --- |
| Test ID | QA-INT018-T3 |
| Preconditions | Test 2 session is `in_progress` and inside its 20 minutes. `interview-turn` is deployed and the model secret is set. |
| Steps | 1. Click **Ask the first question** (the draft is "I am ready. Please ask the first question."). 2. Send at least two further answers that respond to the question on screen. 3. Confirm each answer and the following interviewer question appear in order. 4. Click **End Interview** and confirm in the dialog. 5. Try to send another answer. |
| Expected result | Each successful send stores a `user` turn and the following `assistant` turn with increasing `seq`. A retry of the same send reuses `clientTurnId` and does not create a second pair. **End Interview** calls `finish_own_interview_session` with mode `manual`. `interview_sessions.status` becomes `completed` and `ended_at` is set. The app navigates to `/interview/session/{id}/result` and calls `interview-evaluate`. A later answer is rejected. The browser does not call the model directly. |
| Actual result | Provider-backed browser test. Four user turns and four assistant turns. Follow-up questions referred to the prior team, disagreement, and checkout decision. End Interview completed the session and opened the result route. One session row remained. |
| Status | PASSED |
| Evidence | `interview_turns` count 8. Session status `completed`. |

### Test 4: Scorecard and tips

| | |
| --- | --- |
| Test ID | QA-INT018-T4 |
| Preconditions | Test 3 session is `completed` and has at least one question and one answer. `interview-evaluate` is deployed. |
| Steps | 1. Stay on `/interview/session/{id}/result`. 2. Wait for the scorecard. Use **Try again** if evaluation is still processing. 3. Read the overall score, competency rows, strengths, areas for improvement, and **Your Next Steps**. 4. Refresh the result page. 5. In the database, read only this session: `user_id`, `evaluation_status`, `eval_version`, `overall_score`, `evaluation_tips`, and `interview_scores` for that `eval_version`. |
| Expected result | A successful evaluation shows the competency scorecard (HR rubric: Communication, Teamwork, Problem solving, Decision making, unless a competency was marked not applicable), feedback text, and an overall score that is the stored mean. **Your Next Steps** appears when 3–5 tips were saved, with the subtitle "Personalized recommendations based on your interview performance." Refresh shows the same saved snapshot. `user_id` is Student A and `eval_version` is `INT008-v1` for a new evaluation. An evaluation that failed stays on a completed interview and does not show a scorecard. Snapshots saved before tips existed keep **Your Next Steps** hidden. |
| Actual result | Provider-backed browser test. Result page showed overall 75.75/100, competency feedback, strengths, areas for improvement, and three Your Next Steps. Database: `evaluation_status` completed, `eval_version` INT008-v1, `overall_score` 75.75, 3 `evaluation_tips`. |
| Status | PASSED |
| Evidence | Screenshot `int018-t4-result.png`. |

### Test 5: Quota deduction

| | |
| --- | --- |
| Test ID | QA-INT018-T5 |
| Preconditions | Student A can open `/interview`. Record `used`, `weekly_limit`, `remaining`, and `resets_at` from the **This week** card before starting. Those values must match `get_interview_quota_status` for that user. |
| Steps | 1. Record the quota before **Start**. 2. Start one HR session (Test 2). 3. Before answering, open `/interview` again and record the quota. 4. Complete the interview (Test 3). 5. Open `/interview` again and record the quota. 6. On a session that never gets a row (permission denied, or **Start** blocked because remaining is already 0), record the quota again. 7. Send one answer, let that request fail before any turn is saved, and confirm the quota did not change because of the failed turn. |
| Expected result | Creating the session row increases `used` by 1 and decreases `remaining` by 1. Completing the interview does not subtract a second attempt. An in-progress or failed session in the same week still counts. A failed turn, a failed evaluation, and a second read of the same session do not add another session row. The catalog card matches `get_interview_quota_status` after a fresh load. When the loaded `remaining` is 0, the **Start** button is disabled. The database insert used by **Start** does not itself reject an over-quota insert. See QA-INT018-001. |
| Actual result | Browser, local. Before start: `0 / 5`, 5 remaining. After completion: `1 / 5`, 4 remaining. With the local limit temporarily set to 1, the catalog showed `1 / 1` and `startSession` returned "Weekly mock interview limit reached." Session count stayed 1. The limit was restored to 5. |
| Status | PASSED |
| Evidence | Catalog text and the rejected second start on `127.0.0.1:4200`. |

### Test 6: Mentor override (INT-015)

INT-015 **is implemented** in this repository. This test was not run against a database. It is not a quota or session-status override.

| | |
| --- | --- |
| Test ID | QA-INT018-T6 |
| Preconditions | INT-015 migration is applied on the isolated database. Reviewer has `interview.reviews`. A second account does not. Test 4 session is `completed`, `evaluation_status` is `completed`, and `mentor_review_published` is false. |
| Steps | 1. Sign in as the reviewer and open `/admin/interview/reviews`. 2. Open the Test 4 session. 3. Submit a competency or overall score from 0 to 100 that differs from the current effective score, with a reason of at least 10 characters. 4. Confirm an override row exists and that `interview_scores` and `interview_sessions.overall_score` are unchanged. 5. Leave the review unpublished, sign in as Student A, and reload the result page. 6. Publish the review. Reload the student result page. 7. Sign in as an account without `interview.reviews` and call the review screen or RPC. 8. Record quota `used` and session `status` before and after the override. |
| Expected result | The reviewer can append one `interview_score_overrides` row. `mentor_id` is the signed-in reviewer. Update and delete of that history are rejected. The AI score rows stay as stored. While unpublished, the student still sees the AI scores. After publish, the result page shows the effective score and "Mentor-adjusted" where a competency changed. An account without `interview.reviews` is denied. Session `status` stays `completed`. Quota `used` does not change, because no new session row is inserted. |
| Actual result | Browser, local. Reviewer opened the queue, saved overall 88 with a reason, and published. While unpublished the student page showed 75.75/100. After publish it showed 88/100 and kept "AI score 75.75/100". The mentor without `interview.reviews` was sent to `/admin/no-access`, and `list_interview_review_queue` returned 403. Session stayed `completed`. Quota limit stayed 5 and the session count stayed 1. |
| Status | PASSED |
| Evidence | Screenshot `int018-t6-published-score.png`. Override row old 75.75, new 88, reviewer match. |

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

Do not run this script on the shared production Supabase project. The product-owner meeting was not held. Status: **NOT RUN**.

## E. Bug and issue tracker

These items were found by reading the current source. They were not reproduced on a running database. No existing issue was identified in the local history for either item. Automated tests did not cover the catalog insert versus the quota RPC.

| Bug ID | Description | Severity | Reproduction steps | Expected behavior | Actual behavior | Related file/function | Related issue/PR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QA-INT018-001 | Weekly quota was not enforced on catalog Start. | High | Start from the catalog, then call `start_interview_with_quota` again after the weekly limit is lowered to the current count. | The server creates one `in_progress` session and rejects the next start without inserting another row. | Fixed on this branch. Catalog and redo call `interview-start`, which calls the replaced `start_interview_with_quota`. Direct insert is rejected. Local SQL test `supabase/tests/int_018_quota_rls.sql` passed on `ulearn-int018-local` and rolled back. | `20261110180000_int018_quota_start_and_rls.sql`, `InterviewCatalogService.startSession`, `interview-start` | None found | Fixed in this branch; local database test passed |
| QA-INT018-002 | Session insert did not require `interview.access`. | Medium | As a signed-in user without that permission, insert `interview_sessions` and call the start function. | Both are rejected. A user with the permission can start through the function. | Fixed on this branch. The function checks `interview.access`. The insert policy also names that permission and then denies direct inserts (`AND false`), so the Data API cannot skip the quota lock. The same local SQL test passed and rolled back. | `20261110180000_int018_quota_start_and_rls.sql` | None found | Fixed in this branch; local database test passed |

No other defects were identified in the automated checks that passed. That is not a claim that the live interview flow is free of defects.

Suggested direction for QA-INT018-001, for the quota owner: make catalog start call one server operation that locks the student, checks `interview.access` and the weekly count, and inserts a single `in_progress` row for the selected published template. Do not change the INT-002, INT-006, or INT-016 migrations as part of INT-018.

Suggested direction for QA-INT018-002: add `has_permission('interview.access')` to the student session insert policy or to a before-insert guard. Leave the change to the schema owner.

## F. Test evidence

| Item | Value |
| --- | --- |
| Date | 10 November 2026 |
| Git revision inspected | Documentation commit `6a33c27` on `docs/int-018-interview-qa-demo`, plus uncommitted INT-018 changes. |
| Environment | `ulearn-int018-local`. API `127.0.0.1:54521`. Database `127.0.0.1:54522`. App `http://127.0.0.1:4200` with a gitignored development environment. Not production. |
| Accounts | `int018.student@example.test` (`interview.access`), `int018.denied@example.test` (no interview access), `int018.mentor@example.test` (`interview.reviews`), `int018.mentor-denied@example.test` (no review permission). Local Auth login returned a session for each. Passwords are not recorded here. |
| Browser | Local app in the Cursor browser. Screenshots: `int018-t1-catalog.png`, `int018-t4-result.png`, `int018-t6-published-score.png`. |

Automated commands and results:

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --test` on the interview specs and Node-compatible function tests, 10 November 2026. `interview-rpc-errors_test.ts` was not included because it uses `Deno.test`. | 105 passed, 0 failed. |
| `deno test supabase/functions/_shared/interview-rpc-errors_test.ts`, 10 November 2026 | 5 passed, 0 failed. |
| `node scripts/test-interview-score-overrides.mjs` | Passed (INT-015 source contract). |
| `node scripts/test-interview-coding.mjs` | Passed. |
| `node scripts/test-interview-redo.mjs` | Passed. |
| `node scripts/test-interview-template-versioning.mjs` | Passed. |
| `npx tsc -p tsconfig.app.json --noEmit` | Passed after the start-path change. |
| `node scripts/test-interview-int018.mjs` | Passed. |
| `psql -f supabase/tests/int_018_quota_rls.sql` on local database `ulearn-int018-local` (`127.0.0.1:54522`) | Passed, then `ROLLBACK`. Covers T1, T2, and the quota half of T5. |
| `psql -f supabase/tests/int_018_finish_and_review.sql` on the same local database | Passed, then `ROLLBACK`. Finish does not add a session. Override, denial, and publish succeed. |

Not run:

- The product-owner demo meeting. Status: **NOT RUN**.
- `ng test` is not the interview suite. Interview specs are the Node tests above.
- `supabase db push` was not used. Nothing was deployed to production.

Browser evidence is the local session `a0d7f465-99e4-4ed3-bd49-92194553cfd3`. Chat and scoring were provider-backed through the local Edge runtime. They were not mocked.

## G. Final QA summary

| | |
| --- | --- |
| Total checklist tests | 6 |
| Passed in the browser | T1, T2, T3, T4, T5, T6 |
| Failed | 0 |
| Blocked | 0 |
| Not run | Product-owner demo |
| Outstanding bugs | QA-INT018-001 and QA-INT018-002 are fixed on this branch. |
| Mentor override | Published browser review. AI overall stayed 75.75. Student saw 88 only after publish. |
| Overall demo readiness | Checklist passed locally. The product-owner meeting is **NOT RUN**. |
| Local database | `ulearn-int018-local` at `127.0.0.1:54522`. API `127.0.0.1:54521`. |
| AI provider | **PASSED** as a real local Edge call for T3 and T4. Not mocked. |
| Product-owner demo | **NOT RUN**. |
