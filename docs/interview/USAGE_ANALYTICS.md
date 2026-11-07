# Interview usage analytics (INT-016)

Administrators with the existing `dashboard.view` permission can review mock-interview usage. The page is **Interview Admin → Usage** (`/admin/interview/usage`).

This feature records provider usage. It does not change how interviews are asked, scored, or finished.

## Architecture

Interview sessions, turns, and evaluations stay on the INT-005 / INT-008 tables. INT-016 adds:

- `interview_ai_usage` — one immutable row per accepted AI response.
- `interview_model_rates` — approved prices. The table is created empty.
- `interview_usage_report` and `interview_usage_filters` — security-definer read APIs. The browser never sends token counts.

`interview-turn` records each accepted reply, including a resume steering retry that produced a new model response. `interview-evaluate` records the accepted evaluation response, including a response that is later rejected as invalid JSON, because those tokens were consumed. A provider failure is not recorded.

Each provider HTTP 200 is a usage row. The idempotency key is the provider response id (`provider:{id}` from the JSON `id` field, such as `chatcmpl-...`) when that id is present. Storing the same response again is ignored. A later provider call has a new id and is counted. A 429, 5xx, timeout, or network failure is not stored.

Before each provider request the function creates a server UUID. That id is sent as the `Idempotency-Key` header and is kept for transport retries of the same attempt. It is not read from the browser. When the provider omits a response id, the usage key is `request:{server UUID}`. Re-recording that attempt is ignored. A later request, including a retry after an unusable HTTP 200, gets a new UUID and stays a separate row.

A 200 body that parses but does not contain a usable answer is still stored. If it includes usage metadata, those tokens are kept. If it does not, the row is unknown usage rather than zero. A body that is not JSON has no metadata and is not given invented token counts. A replay that does not call the provider does not insert a row.

Recording is best-effort. A usage insert failure is logged and does not fail the interview.

## What is stored

| Field | Source |
| --- | --- |
| Session, student, start, end, status | Existing `interview_sessions` columns |
| Input and output tokens | OpenAI `usage.prompt_tokens` / `usage.completion_tokens`, or `input_tokens` / `output_tokens` |
| Total tokens | Sum of known input and output, only when every call for that session returned usage |
| Provider and model | The configured interview provider (`openai`) and `INTERVIEW_AI_MODEL` (default `gpt-6-luna`) |
| Last usage update | `created_at` of the latest usage row |
| Elapsed duration | `ended_at - started_at`, in seconds |

Missing usage stays null and `usage_known` is false. The app does not estimate tokens from character length and does not store 0 in place of an absent usage object. A provider that reports zero tokens is stored as zero, because that is actual metadata.

Old sessions have no usage rows. They still appear in session counts, completion, score, and elapsed duration. Their tokens and cost are unavailable.

Deleting a session cascade-deletes its usage rows. There is no separate retention job. The report does not read `interview_turns`, resume text, or resume summaries.

## Duration

The metric is elapsed wall time from `started_at` to `ended_at`. It is not active speaking time, and the dashboard says so. An in-progress session has no elapsed duration and is excluded from the average and the total. A failed session that has `ended_at` is included in elapsed time and in sessions started, and is not counted as completed.

## Cost

When a rate matches the provider, model, and the UTC date of the call:

```text
estimated_cost = (input_tokens × input_per_million + output_tokens × output_per_million) / 1_000_000
```

`input_per_million` and `output_per_million` are currency units per 1,000,000 tokens. The latest rate with `effective_from` on or before the usage date is used. A later rate does not rewrite older calls.

No approved price for `gpt-6-luna` (or any other interview model) is stored in this repository. Until an administrator inserts a row, cost status is `unconfigured` and the amount is null. The UI says pricing is not configured. It does not show ₹0 or $0 for a missing rate.

If some calls have usage and some do not, a cost is shown only for the priced known calls and `usageIncomplete` is true. If any known call has no rate, the aggregate amount is null. If priced calls use more than one currency, the amount is null and the status is `mixed`. Currencies are not added together.

An administrator adds a rate directly in the database after approval, with provider, model, ISO currency, both per-million rates, the effective date, and a source note that names the price list and the approval. Replacing a price means inserting a new row with a later `effective_from`. Existing rows are not edited by the application.

## Dashboard

Definitions use the sessions that match every selected filter, including status. Filtering to Completed therefore makes the completion rate 100% because the started set is already limited to completed sessions.

| Metric | Definition |
| --- | --- |
| Sessions started | Sessions whose `started_at` is inside the period |
| Sessions completed | Those sessions with `status = completed` |
| Completion rate | Completed ÷ started × 100. Blank when started is 0 |
| Average AI score | Mean of `overall_score` on completed sessions that have a score. Scale 0–100. Sessions without a score are excluded. Mentor score overrides are not included |
| Tokens | Sum of known provider input and output. Total is blank when any call is missing usage |
| Estimated AI cost | Sum described above, labeled as an estimate |
| Duration | Average and total elapsed seconds for sessions that have `ended_at` |
| Students | Distinct `user_id` values in the filtered sessions |

The session table is paged (25 rows). Filters are applied in the database query.

Date inputs are local calendar dates. The report receives the local midnight of the start date and the next local midnight after the end date, as UTC timestamps. The end date is inclusive.

College options come from distinct non-blank `profiles.college_name` values on students who have an interview session. Batch options come from `batches` linked through `batch_members` to those students. Unassigned is offered when a session student has no college or no batch membership. Values are not hardcoded. A student in several batches is counted once in an unfiltered report and is included when any selected batch matches.

## Access

`interview_usage_report` and `interview_usage_filters` require a signed-in user with `has_permission('dashboard.view')`. That is the same permission as the rest of Interview Admin.

- An unlabeled `ADMIN` profile has every permission, including this one.
- `campus_admin` and `mentor` labels are seeded with `dashboard.view`, so those staff can open the report.
- Students, including students with `interview.access`, do not have `dashboard.view`. The route guard and the database function both refuse them.
- The functions do not accept a role name from the client. A forged request body cannot grant access.
- `anon` cannot execute the functions. Authenticated users cannot select usage or rate rows. Usage inserts from the browser are rejected. The service role records usage inside the edge functions.

Campus staff are not limited to one college. The current staff model has no college-scoped authorization: `campus_admin` can already read students across colleges through `is_admin()`. INT-016 does not invent a college boundary. Restricting a campus to one college needs an approved scope (which profile or label owns which college) before it can be enforced in these queries.

## CSV

Export uses the same report function and the same filters, paging 200 rows at a time, and stops above 20,000 rows instead of loading an unbounded result into the browser. The file is UTF-8 with a BOM. Nulls are empty fields. Commas, quotes, and newlines are escaped. A text value that starts with `=`, `+`, `-`, `@`, or a tab is prefixed with a single quote.

Columns are session id, student id, college, batch, template, interview type, start, completion, status, elapsed seconds, input tokens, output tokens, total tokens, provider, model, estimated cost, currency, and AI score. The export does not include names, email, resume text, transcripts, passwords, or secrets. Student id is the profile UUID already used in administration.

## Local validation

The committed migrations start after an older baseline that is not in this repository, so `supabase start` in a brand-new database fails on the first course migration. An isolated stack for INT-016 was started with a separate project id and ports `54421` (API) and `54422` (database), leaving the INT-012 stack on `54321`/`54322` untouched. The INT-016 migration was applied there after the tables it reads (`profiles`, `batches`, `interview_sessions`, and staff permissions) existed. `profiles.college_name` is added by this migration when it is missing.

Do not point this feature at production project `yllfccuxohnipleyseup`.

## Limitations

- Pricing is not configured. Cost stays unavailable until approved rates are inserted.
- Campus analytics are not college-scoped, because that authorization does not exist yet.
- Elapsed duration is not active interview time.
- Average score is the AI `overall_score`, not a published mentor override.
- A provider body that is not JSON has no usage metadata, so no token counts are stored for it. A parsed 200 that cannot be used as an answer is stored, with unknown usage when the body has no usage object.
- Opening a session does not call the model. The first usage row appears on the first accepted turn or evaluation.
- The voice interview uses the same `interview-turn` function, so its accepted replies are included. No separate voice meter is stored.
