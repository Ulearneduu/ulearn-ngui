# Interview resume privacy (INT-014)

This note describes the resume data the mock interview actually stores. It is the retention policy the start screen refers to. It is not a substitute for the public website privacy policy.

## 1. Purpose

A student can optionally provide resume text so the existing AI interviewer can ask about that student's projects, technologies, responsibilities, and achievements. The interview still starts when no resume is provided.

## 2. Information collected

The browser accepts pasted text or a PDF, DOCX, or TXT file. The file is read locally in the browser. Only the extracted text is sent to Supabase, and only as a column on the interview session the student is creating.

The application does not store the original file, the file name, or a storage-object path. It does not put resume text in a URL.

Students are asked not to include unnecessary sensitive personal information. The product cannot detect every sensitive detail a student pastes.

## 3. Storage and data flow

1. The signed-in student inserts `resume_text` on their new `interview_sessions` row. Empty input omits the column.
2. `interview-turn` reads that row for the session owner.
3. The function stores a shortened `resume_summary` on the same row and reuses it on later turns, including after a page refresh.
4. When a question is grounded in a resume project fact, the function appends that question and the matched fact to `resume_question_log` on the same row.
5. The summary and the untrusted-data instructions are added to the existing OpenAI chat request inside `interview-turn`. The browser never receives the OpenAI key.

`interview-evaluate` does not receive `resume_text` or `resume_summary`. It still sees the saved transcript, so a question that mentions a project remains in the transcript.

## 4. Who can access it

Row Level Security on `interview_sessions` is unchanged: a student can read and delete only their own sessions. Another student receives no row. Anonymous requests have no table privilege.

`resume_summary` and `resume_question_log` cannot be inserted or updated by the `authenticated` role. The session guard rejects those writes unless the database role is `service_role`, `postgres`, or `supabase_admin`. Students also cannot change `resume_text` after the session is created.

The service role is used only inside the Edge Function after the caller is authenticated, has `interview.access`, and owns the session. The service-role key is not in the Angular app.

## 5. How the interviewer uses it

The model is instructed to treat the resume as untrusted reference data, to ignore instructions embedded in it, and not to invent projects or skills. The server records a question as resume-grounded only when the question text contains a project fact extracted from the resume. Generic skill names such as Python or SQL are not enough. The server keeps asking until two distinct grounded questions have been recorded when the resume contains at least two project facts. That count is the database log, not a value sent by the browser.

## 6. Third-party AI provider

Yes. When a resume summary exists, `interview-turn` sends that summary to OpenAI at `https://api.openai.com/v1/chat/completions` using the configured model (`gpt-6-luna` unless `INTERVIEW_AI_MODEL` overrides it). OpenAI's own retention of API inputs is governed by the OpenAI account settings and OpenAI's terms. This repository does not add a separate zero-retention control.

## 7. Retention period

No approved time-based retention period exists for interview resumes.

Proposed approach, **requiring administrator or team approval** before it is treated as policy or implemented as a job:

- Keep `resume_text`, `resume_summary`, and `resume_question_log` for the life of the interview session.
- Do not add a scheduled purge until an administrator approves a specific period.

There is no automated age-based deletion in this change.

## 8. Deletion

Deleting the interview session deletes the resume columns because they are on that row. Deleting the auth user deletes the student's sessions through the existing `interview_sessions.user_id` foreign key `ON DELETE CASCADE`, which removes the resume columns with those rows.

Turns, scores, and coding rows already cascade from the session. This change does not add a separate resume table, so there is no leftover resume row after session deletion.

The student can delete only a session they own. The existing delete policy is `auth.uid() = user_id`. A student cannot delete another student's session or resume.

## 9. Session deletion outcome

After a successful delete, `resume_text`, `resume_summary`, and `resume_question_log` for that session are gone with the row. The application does not copy them into logs, analytics, or the evaluation request body.

## 10. MVP limitations

- PDF and DOCX text are extracted in the browser. Scanned image-only PDFs and resumes whose text lives only in images return an extraction error. The interview does not continue with an empty extraction.
- DOCX text comes from `word/document.xml`. Text stored only in headers, footers, or embedded objects can be missed.
- The original file is not kept, so the student cannot re-download it from ULearn.
- The model can still mention a project name in a question. That question is then part of the transcript.
- Resume text is not redacted automatically.
- The two-question rule depends on project facts the extractor can find. A resume that lists only generic skills does not force project questions.
- If the model will not ask a grounded question, the server asks one fallback question that names a fact copied from the resume. That fallback is used only after the model replies without a new grounded question.

## 11. Decisions that need administrator approval

- Whether a time-based retention period should replace "kept until the session or account is deleted".
- Whether OpenAI data-retention settings for the interview API key should be changed.
- Whether resume text should be removed from stored sessions on a schedule even when the transcript is kept.
- Whether the public website privacy policy should be updated to mention mock-interview resumes. This document does not change that policy.
