# AI Mock Interview â€” Student Wireframes

**Task ID:** INT-003
**Status:** Draft â€” requires frontend, backend, and product-owner review
**Scope:** Student-facing AI Mock Interview experience
**Purpose:** Define the screens, navigation, required data, and UI states before implementation.

## 1. Goals and Scope

This document defines four screens:

1. Interview Catalog
2. Active Interview / Chat Session
3. Interview Scorecard / Feedback
4. Interview History

These are low-fidelity wireframes, not final visual designs. No UI, API, AI conversation, or scoring implementation is included in INT-003.

**Related docs (not in scope to implement here):**

- Access gate: `interview.access` (see ULearn integration contract / INT-002).
- AI provider, cost, safety, retries: `docs/interview/AI_PROVIDER.md` (INT-001).

## 2. Student Navigation Flow

```text
                  +----------------------+
                  |   Interview Catalog  |
                  +----------------------+
                            |
                   Select interview type
                   Check remaining quota
                            |
                            v
                  +----------------------+
                  |    Start Interview   |
                  +----------------------+
                     |              |
               Quota available   Quota exhausted
                     |              |
                     v              v
              Create session    Show quota message
                     |
                     v
             +----------------------+
             |   Active Interview   |
             |   / Chat Session     |
             +----------------------+
                |              |
         End and confirm    Failure / retry
                |
                v
             +----------------------+
             | Scorecard / Feedback |
             +----------------------+
                     |
                     v
             +----------------------+
             |   Interview History  |
             +----------------------+
                     |
                     v
             View previous scorecard

Catalog ----------------> Interview History
History ----------------> Catalog
```

## 3. Screen 1 â€” Interview Catalog

**Purpose:** Let students discover available mock interview types, see duration and quota, and start a new session.

### Low-fidelity wireframe

```text
+------------------------------------------------------+
| ULearn                         Student Profile       |
+------------------------------------------------------+
| Mock Interviews                                      |
| Practice with AI interviewers for HR and technical   |
+------------------------------------------------------+
| Remaining this period: 2 of 3 mocks                  |
| Resets: -- (date TBD by product)                     |
+------------------------------------------------------+
| [Catalog]                    [History]               |
|                                                      |
| +--------------------------------------------------+ |
| | HR Behavioral Mock                    [Start]     | |
| | ~30 min | Behavioral / STAR-style questions      | |
| | Difficulty: Standard                             | |
| +--------------------------------------------------+ |
| | Technical (DSA) Mock                  [Start]     | |
| | ~45 min | Coding + problem-solving discussion    | |
| | Difficulty: Standard                             | |
| +--------------------------------------------------+ |
| | Domain / Role Mock (optional v1)      [Start]     | |
| | ~30 min | Role-specific scenarios                | |
| | Difficulty: Standard                             | |
| +--------------------------------------------------+ |
|                                                      |
| Quota exhausted banner (when applicable)             |
| Loading / Empty / Error / Access denied message area |
+------------------------------------------------------+
```

### Fields and components

- Page title and short description.
- **Remaining quota** (e.g. mocks left in current week or billing period â€” exact rule TBD).
- Quota reset hint (if product defines one).
- Tab or links: **Catalog** and **History**.
- **Interview type cards:** title, duration, short description, difficulty label (if templates expose it).
- **Start** per type (disabled when quota exhausted or session already in progress â€” rules TBD).
- Banner when quota is exhausted.
- Access denied state when `interview.access` is false (message + link back to home or support).

### Actions

- **Start:** Validate quota â†’ create session row â†’ navigate to Active Interview (see INT-010 / INT-011).
- **History:** Open Interview History list.
- **Retry** (error state only): Reload catalog data.

### States

- **Loading:** Skeleton or spinner while templates and quota load.
- **Empty:** No templates published â€” explain that mocks will appear when assigned.
- **Quota exhausted:** Disable Start; show when quota resets and link to History.
- **Access denied:** User lacks `interview.access`.
- **Error:** Network or server error with retry.
- **Session creation failure:** If creating a session fails after the student clicks **Start**, remain on the Catalog, show a friendly error message, and provide a **Retry** option. On retry, reuse the same client request idempotency key (or server-side deduplication) so a successful retry does not create duplicate sessions.

### Data requirements

Interview templates (id, title, description, duration_minutes, type slug), student quota (limit, used, remaining, period boundaries), whether an **in-progress** session exists (optional block on second Start).

### Open decisions

1. Quota period: calendar week vs rolling 7 days vs custom (INT-012).
2. Allow only one in-progress session at a time?
3. Minimum templates for v1: HR + Technical required; third type optional?

## 4. Screen 2 â€” Active Interview / Chat Session

**Purpose:** Conduct a timed text mock interview: AI messages, student replies, session timer, graceful end and failure handling.

### Low-fidelity wireframe

```text
+------------------------------------------------------+
| [< Back to Catalog]     HR Behavioral Mock             |
| Time remaining: 24:12        Session: In progress    |
+------------------------------------------------------+
| Messages (scroll)                                    |
|                                                      |
|  [AI] Welcome. Let's begin with...                   |
|                                                      |
|            [You] My answer text appears here...       |
|                                                      |
|  [AI] Follow-up question...                          |
|                                                      |
|  [System] Connection issue â€” retrying... (optional)  |
+------------------------------------------------------+
| Type your answer...                    [Send]        |
| Character hint / max length (TBD)                    |
+------------------------------------------------------+
| [End interview]                                      |
+------------------------------------------------------+
```

### Fields and components

- Interview type title and **countdown timer** (from template `duration_minutes` or server clock).
- Session status label (in progress, ending, failed).
- **Message list:** role (AI / student / system), body, timestamp (optional).
- **Composer:** multiline input, Send (disabled while AI request in flight).
- **End interview** (always visible; opens confirmation).
- Back link behavior TBD (warn if leaving mid-session).

### Actions

- **Send:** Persist student turn â†’ call Edge Function for AI reply â†’ append AI message (INT-011).
- **End interview:** Confirm dialog â†’ mark session completed (or awaiting score) â†’ navigate to Scorecard when ready.
- **Back to Catalog:** Confirm abandon if session in progress (PO decision).

### States

- **Loading session:** Fetch existing turns for resume.
- **AI thinking:** Disable Send; show typing indicator.
- **Message submission failure:** If submitting an answer fails, **preserve the student's typed answer** in the composer, show a clear error and **Retry** option, and reuse the same **`client_turn_id`** (per `AI_PROVIDER.md`) so retries do not create duplicate student turns.
- **AI error / timeout:** After a student turn is saved, if the AI reply fails or times out, show a user-friendly message and **Retry** for the AI response using the same **`client_turn_id`** idempotency approach (no duplicate turns).
- **Timer expired:** Auto-end or block new sends â€” PO decision.
- **Session failed:** Explain failure; offer return to Catalog or History with partial transcript saved (INT-060).

### Data requirements

Session id, template id, `started_at`, `ends_at` or duration, turn list (id, role, content, created_at), session status, client turn id for retries.

### Open decisions

1. Auto-submit on timer zero vs soft warning at 5 minutes?
2. Show word count or length limits on answers?
3. Resume in-progress session from Catalog vs always new session?

## 5. Screen 3 â€” Interview Scorecard / Feedback

**Purpose:** Present overall results, competency breakdown, transcript, and actionable tips after a completed mock.

### Low-fidelity wireframe

```text
+------------------------------------------------------+
| [< Back to History]                                  |
+------------------------------------------------------+
| HR Behavioral Mock â€” Completed                       |
| Date: -- | Duration: -- min                          |
+------------------------------------------------------+
| Overall score: 72 / 100   (pending until INT-021)    |
+------------------------------------------------------+
| Competencies                                         |
| Communication    [========----]  --/10               |
| Structure (STAR)   [======------]  --/10             |
| Depth              [====--------]  --/10             |
| ... (rubric-driven, template-specific)               |
+------------------------------------------------------+
| Strengths                                            |
|  â€¢ Bullet one                                        |
|  â€¢ Bullet two                                        |
+------------------------------------------------------+
| Areas to improve                                     |
|  â€¢ Bullet one                                        |
|  â€¢ Bullet two                                        |
+------------------------------------------------------+
| Transcript                          [Expand / Collapse]|
|  AI: ...                                             |
|  You: ...                                            |
+------------------------------------------------------+
| Suggested next steps (optional INT-031)              |
|  â€¢ Drill stub / link TBD                             |
+------------------------------------------------------+
| [Start another mock]    [Download PDF] (later INT-033)|
+------------------------------------------------------+
```

### Fields and components

- Session metadata: type, completed date, duration.
- **Overall score** (placeholder until evaluation job exists).
- **Competency scores** (bars or radar â€” layout TBD; driven by rubric schema INT-021).
- Strengths and improvements lists.
- **Collapsible transcript** (full text).
- Optional drill suggestions section.
- Navigation: History, Catalog (another mock), PDF export (out of v1 if not approved).

### Actions

- **Back to History:** Return to list.
- **Start another mock:** Go to Catalog (quota check again).
- **Expand / Collapse transcript:** Toggle visibility.
- **Download PDF:** Future (INT-033).

### States

- **Feedback pending** (evaluation / scoring in progress): Evaluation is still running. Show a loading indicator and a message such as â€œGenerating your feedbackâ€¦â€ Hide or placeholder competency blocks until results arrive.
- **Feedback unavailable** (evaluation / scoring failed): Evaluation failed or feedback **cannot be retrieved**. Explain that the **score is currently unavailable**, keep the **transcript visible when available**, and offer **Retry** (reload evaluation) and/or **contact support** where appropriate. Do not imply a score exists when it does not.
- **Partial data:** Some competency or summary fields are missing while evaluation otherwise succeeded â€” show available fields only. Keep this state **separate** from **Feedback pending** (still running) and **Feedback unavailable** (failed or not retrievable).

### Data requirements

Session id, evaluation status, overall score, per-competency scores and labels, rationale snippets (if API provides), strengths/improvements arrays, ordered transcript turns, evaluation version id.

## 6. Screen 4 â€” Interview History

**Purpose:** List past and in-progress mocks; open scorecard or resume where allowed.

### Low-fidelity wireframe

```text
+------------------------------------------------------+
| Mock Interviews                                      |
+------------------------------------------------------+
| [Catalog]                    [History]               |
|                                                      |
| Filter: [All] [Completed] [In progress] [Failed]     |
+------------------------------------------------------+
| +--------------------------------------------------+ |
| | HR Behavioral Mock              Completed         | |
| | Oct 24, 2026 | Score: 72        [View feedback]   | |
| +--------------------------------------------------+ |
| | Technical (DSA) Mock            In progress       | |
| | Oct 23, 2026 | --               [Resume]          | |
| +--------------------------------------------------+ |
| | HR Behavioral Mock              Failed            | |
| | Oct 20, 2026 | --               [View details]    | |
| +--------------------------------------------------+ |
|                                                      |
| Loading / Empty / Error message area                 |
+------------------------------------------------------+
```

### Fields and components

- Tabs: Catalog / History (same as Screen 1).
- Optional status filter.
- **Row per session:** type title, date, status badge, score when completed.
- Primary action per row: **View feedback**, **Resume**, or **View details** (failed).

### Actions

- **View feedback:** Navigate to Scorecard for completed sessions.
- **Resume:** Open Active Interview for in-progress sessions (if product allows).
- **View details:** Failed session â€” show error summary + partial transcript if any.
- **Catalog:** Switch to Screen 1.

### States

- **Loading:** Fetch session list.
- **Empty:** â€œNo mock interviews yetâ€ + CTA to Catalog.
- **Error:** Retry.

### Data requirements

Paginated or capped list of sessions: id, template title, status (`in_progress` | `completed` | `failed`), started_at, completed_at, overall_score when present.

## 7. Shared UI and Interaction Requirements

- Reuse ULearn header, auth shell, typography, and spacing from existing student pages.
- Respect **`interview.access`** â€” hide or gate `/interview` routes per INT-002.
- Show loading, empty, success, and error states on every screen.
- Confirm **End interview** and destructive navigation away from an active session.
- Prevent duplicate **Send** while a turn is in flight; align with idempotency rules in `AI_PROVIDER.md`.
- Do not display API keys, system prompts, or raw provider errors to students.
- Responsive layout: usable on laptop first; mobile-friendly composer and message list.
- Accessibility: focus management on Send, timer announcements (level TBD).

## 8. Student Route and Navigation Considerations

Proposed destinations (not implemented in INT-003):

| Route (proposed) | Screen |
|------------------|--------|
| `/interview` | Interview Catalog |
| `/interview/history` | Interview History |
| `/interview/session/:sessionId` | Active Interview / Chat Session |
| `/interview/session/:sessionId/feedback` | Scorecard / Feedback |

Confirm path names and guards with existing Angular routing and `interview.access` before implementation.

## 9. Open Decisions for Product-Owner Approval

1. Quota definition and reset messaging on Catalog.
2. Single vs multiple in-progress sessions.
3. Timer behavior at zero; auto-end vs grace period.
4. Whether students may abandon/back out without ending session.
5. When scorecard is available (immediate vs async job).
6. Which competencies appear per template type.
7. Resume vs discard for in-progress rows in History.
8. Failed session: what the student sees in â€œView detailsâ€.
9. Redo / compare same template (INT-032) â€” out of v1 wireframe scope but affects History actions later.
10. PDF export in v1 or deferred.

## 10. Backend and Frontend Dependencies

**Frontend**

- Route module under `/interview` with auth + permission guard.
- Shared message list and composer components for Screen 2.
- Align with INT-010 (catalog), INT-011 (session loop), INT-013 (history), INT-030 (scorecard).

**Backend**

- Templates, sessions, turns, quotas, evaluations (INT-004+).
- Edge Function for AI turns; no provider secrets in the client.

**Product owner**

- Approve navigation flow, four screens, and open decisions in Â§9.
- Sign-off comment on this doc or linked Figma before implementation.

## 11. Approval Status

**Current status: Draft â€” pending product-owner approval.**

This document does not implement Angular screens, Supabase tables, Edge Functions, or AI scoring. Implementation follows INT-010+ after PO approval of these wireframes.
