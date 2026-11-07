# CRT Readiness Score

## Purpose

The readiness score is a 0–100 number shown on each learning-path card on the CRT student home. It summarizes how prepared a student is for that path after practice and mock tests.

The score is calculated when the home page loads. It is not stored in its own table. Practice and mock submission already save `score` and `max_score` on `crt_attempts`. The next visit to CRT home reads those rows and recalculates readiness.

## Formula

Each component is a percentage from 0 to 100.

```text
Readiness Score = (0.40 × Practice Accuracy) + (0.40 × Latest Mock Score) + (0.20 × Topic Coverage)
```

Round the result to the nearest integer and keep it within 0–100.

## Practice accuracy (40%)

Practice accuracy is the average accuracy of the latest five submitted practice attempts for the signed-in student and that learning path.

Use rows in `crt_attempts` where:

- `user_id` is the signed-in student
- `path_id` is the path on the card
- `kind` is `practice`
- `status` is `submitted`

Order those rows by `submitted_at` descending and keep at most five. Ignore in-progress attempts.

For each remaining attempt, accuracy is `score / max_score × 100`. Skip an attempt whose `max_score` is null or 0 so it cannot divide by zero. Average the accuracies of the attempts that remain.

If the student has no submitted practice attempts for the path, practice accuracy is 0.

## Latest mock score (40%)

The latest mock score is the accuracy of the newest submitted mock attempt for that student and path.

Use the `crt_attempts` row where:

- `user_id` is the signed-in student
- `path_id` is the path on the card
- `kind` is `mock`
- `status` is `submitted`

Choose the row with the latest `submitted_at`. Its accuracy is `score / max_score × 100`. If `max_score` is null or 0, treat this component as 0.

If the student has no submitted mock attempt for the path, the mock score is 0.

## Topic coverage (20%)

Topic coverage is the percentage of distinct topics in the path that the student has answered correctly at least once.

Eligible topics are the distinct, non-null `topic` values on questions that belong to modules in the path. The same topic name counts as one topic, even when it appears on more than one question or module. Null topics are ignored.

A topic is covered when the student has at least one graded answer for that path with `is_correct = true` on a question with that topic. Both practice and mock answers count. In-progress attempts do not count, because their answers are not graded yet.

```text
Topic Coverage = (covered eligible topics / eligible topics) × 100
```

If the path has no eligible topics, topic coverage is 0.

## Missing data

| Situation | Component used |
| --- | --- |
| No submitted practice attempts | Practice accuracy = 0 |
| No submitted mock attempt | Latest mock score = 0 |
| No eligible topics on the path | Topic coverage = 0 |
| Attempt still in progress | Ignored |
| Submitted attempt with no usable `max_score` | Ignored for that attempt's accuracy; if none remain, that component is 0 |

An empty component stays in the formula with a value of 0. It is not dropped and the other weights are not rescaled.

## Example

A student has three submitted practice attempts on a path, with accuracies of 80%, 60%, and 100%. The latest five are those three, so practice accuracy is 80.

The latest submitted mock scored 15 out of 25, so the mock score is 60.

The path has four distinct non-null topics. The student has answered at least one question correctly in two of them, so topic coverage is 50.

```text
Readiness = (0.40 × 80) + (0.40 × 60) + (0.20 × 50)
          = 32 + 24 + 10
          = 66
```

## Data sources and updates

Readiness uses the existing CRT tables. It does not add a table or column.

| Data | Source |
| --- | --- |
| Student | Signed-in user, `auth.uid()` |
| Learning path | `crt_paths.id` for each published path on CRT home |
| Practice and mock scores | `crt_attempts.score`, `crt_attempts.max_score`, `crt_attempts.kind`, `crt_attempts.status`, `crt_attempts.submitted_at` |
| Topics | `crt_questions.topic` for questions in the path's modules |
| Correct answers | `crt_attempt_answers.is_correct` joined to the question topic |

`crt_submit_attempt` and `crt_submit_mock_attempt` already write the score when a student submits. CRT home does not write readiness back to the database. Opening `/crt` after a practice or mock result loads the new submitted rows and shows the updated score.
