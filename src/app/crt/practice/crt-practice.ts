import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  CrtAttemptScore,
  CrtPracticeAttempt,
  CrtPracticeQuestion,
  CrtPracticeService
} from '../services/crt-practice.service';

type OptionIndex = 0 | 1 | 2 | 3;

/**
 * The countdown is not server-enforced. crt_attempts.duration_seconds is 0
 * while an attempt is in progress and is written by crt_submit_attempt as
 * elapsed seconds. No allotted duration exists, so this screen shows elapsed
 * time from started_at on the client clock and does not auto-submit.
 */
@Component({
  selector: 'app-crt-practice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './crt-practice.html',
  styles: `
    .crt-practice {
      max-width: 720px;
      margin: 0 auto;
      padding: 48px 24px 72px;
    }
    .page-header a {
      color: var(--purple);
      font-weight: 700;
      text-decoration: none;
    }
    .page-header h1 {
      margin: 16px 0 8px;
      color: var(--navy);
      font-family: 'Poppins', sans-serif;
    }
    .status,
    .meta p,
    .timer span,
    .confirm p {
      margin: 0;
      color: var(--muted);
    }
    .meta {
      display: grid;
      gap: 8px;
      margin-top: 24px;
    }
    .timer {
      color: var(--navy);
      font-weight: 700;
    }
    .timer span {
      display: block;
      max-width: 62ch;
      margin-top: 8px;
      font-weight: 400;
      font-size: 0.875rem;
      line-height: 1.5;
    }
    .question {
      margin-top: 24px;
      padding: 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
    }
    .question h2 {
      margin: 0 0 16px;
      color: var(--navy);
      font-size: 1.15rem;
    }
    .options {
      display: grid;
      gap: 10px;
    }
    .options label {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      cursor: pointer;
    }
    .options label.selected {
      border-color: var(--purple);
    }
    .status,
    .banner,
    .result,
    .confirm,
    .actions {
      margin-top: 20px;
    }
    .banner,
    .confirm {
      padding: 16px;
      border-radius: 12px;
    }
    .banner {
      border: 1px solid #f3c2c2;
      background: #fdecec;
    }
    .banner p {
      margin: 0;
      color: var(--navy);
    }
    .confirm {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      border: 1px solid var(--border);
      background: var(--card);
    }
    .result {
      color: var(--navy);
      font-weight: 700;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .btn-primary,
    .btn-secondary {
      padding: 10px 18px;
      border: none;
      border-radius: 8px;
      font-weight: 700;
      cursor: pointer;
    }
    .btn-primary {
      background: var(--purple);
      color: #fff;
    }
    .btn-secondary {
      background: var(--border);
      color: var(--navy);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
  `
})
export class CrtPractice implements OnInit {
  private readonly practice = inject(CrtPracticeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly submitting = signal(false);
  readonly submitted = signal(false);
  readonly confirming = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly submitError = signal<string | null>(null);
  readonly questions = signal<CrtPracticeQuestion[]>([]);
  readonly questionIndex = signal(0);
  readonly officialScore = signal<CrtAttemptScore | null>(null);
  readonly elapsedLabel = computed(() => this.formatElapsed(this.elapsedSeconds()));

  readonly currentQuestion = computed(() => this.questions()[this.questionIndex()] ?? null);
  readonly questionNumber = computed(() => this.questionIndex() + 1);
  readonly answeredCount = computed(() => {
    const selected = this.selections();
    return this.questions().filter((question) => selected[question.id] !== undefined).length;
  });
  readonly answersLocked = computed(() => this.saving() || this.submitting() || this.submitted());

  pathId = '';
  private moduleId = '';
  private attemptId = '';
  private readonly startedAt = signal<string | null>(null);
  private readonly now = signal(Date.now());
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly selections = signal<Partial<Record<string, OptionIndex>>>({});
  private readonly elapsedSeconds = computed(() => {
    const startedAt = this.startedAt();
    if (!startedAt) return 0;
    const started = Date.parse(startedAt);
    if (!Number.isFinite(started)) return 0;
    return Math.max(0, Math.floor((this.now() - started) / 1000));
  });

  ngOnInit(): void {
    this.pathId = this.route.snapshot.paramMap.get('pathId') ?? '';
    this.moduleId = this.route.snapshot.paramMap.get('moduleId') ?? '';
    this.timer = setInterval(() => {
      if (!this.submitted()) this.now.set(Date.now());
    }, 1000);
    this.destroyRef.onDestroy(() => this.stopTimer());
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    this.saveError.set(null);
    this.submitError.set(null);

    if (!this.pathId || !this.moduleId) {
      this.questions.set([]);
      this.loadError.set('This practice session could not be found.');
      this.loading.set(false);
      return;
    }

    try {
      const attempt = await this.practice.findOrCreateAttempt(this.pathId, this.moduleId);
      const questions = await this.practice.listQuestions(this.moduleId);
      const saved = await this.practice.listSelectedAnswers(attempt.id);
      this.applyAttempt(attempt, questions, saved);
    } catch (error: unknown) {
      this.questions.set([]);
      this.loadError.set(this.message(error, 'Could not load practice.'));
    } finally {
      this.loading.set(false);
    }
  }

  isSelected(index: number): boolean {
    const question = this.currentQuestion();
    if (!question) return false;
    return this.selections()[question.id] === index;
  }

  optionIndex(index: number): OptionIndex {
    if (index === 0 || index === 1 || index === 2 || index === 3) return index;
    return 0;
  }

  optionLabel(index: number): string {
    return ['A', 'B', 'C', 'D'][index] ?? '';
  }

  previous(): void {
    this.questionIndex.update((index) => Math.max(0, index - 1));
  }

  next(): void {
    this.questionIndex.update((index) => Math.min(this.questions().length - 1, index + 1));
  }

  async selectOption(selectedIndex: OptionIndex): Promise<void> {
    const question = this.currentQuestion();
    if (!question || this.answersLocked() || !this.attemptId) return;

    const previous = this.selections()[question.id];
    if (previous === selectedIndex) return;

    this.selections.update((current) => ({ ...current, [question.id]: selectedIndex }));
    this.saving.set(true);
    this.saveError.set(null);

    try {
      const saved = await this.practice.saveAnswer(this.attemptId, question.id, selectedIndex);
      if (saved.selected_index === null) return;
      this.selections.update((current) => ({ ...current, [question.id]: saved.selected_index as OptionIndex }));
    } catch (error: unknown) {
      this.selections.update((current) => {
        const next = { ...current };
        if (previous === undefined) delete next[question.id];
        else next[question.id] = previous;
        return next;
      });
      this.saveError.set(this.message(error, 'Could not save this answer.'));
    } finally {
      this.saving.set(false);
    }
  }

  requestSubmit(): void {
    if (this.answersLocked() || this.submitted()) return;
    this.confirming.set(true);
  }

  cancelSubmit(): void {
    if (this.submitting()) return;
    this.confirming.set(false);
  }

  async confirmSubmit(): Promise<void> {
    if (!this.attemptId || this.submitting() || this.submitted() || this.saving()) return;

    this.submitting.set(true);
    this.submitError.set(null);

    try {
      const score = await this.practice.submitAttempt(this.attemptId);
      this.now.set(Date.now());
      this.stopTimer();
      this.officialScore.set(score);
      this.submitted.set(true);
      this.confirming.set(false);
      await this.router.navigate([
        '/crt/paths',
        this.pathId,
        'modules',
        this.moduleId,
        'attempts',
        this.attemptId,
        'result',
      ]);
    } catch (error: unknown) {
      this.submitError.set(this.message(error, 'Could not submit this practice.'));
    } finally {
      this.submitting.set(false);
    }
  }

  private applyAttempt(
    attempt: CrtPracticeAttempt,
    questions: CrtPracticeQuestion[],
    saved: { question_id: string; selected_index: OptionIndex | null }[],
  ): void {
    const restored: Partial<Record<string, OptionIndex>> = {};
    for (const answer of saved) {
      if (answer.selected_index !== null) restored[answer.question_id] = answer.selected_index;
    }

    this.attemptId = attempt.id;
    this.startedAt.set(attempt.started_at);
    this.selections.set(restored);
    this.questions.set(questions);
    this.questionIndex.set(0);
    this.submitted.set(false);
    this.officialScore.set(null);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private formatElapsed(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  private message(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }
}
