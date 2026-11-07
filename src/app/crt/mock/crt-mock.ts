
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
  import {
    CrtMockQuestion,
    CrtMockService,
  } from '../services/crt-mock.service';

  @Component({
    selector: 'app-crt-mock',
    standalone: true,
    templateUrl: './crt-mock.html',
    styleUrl: './crt-mock.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
  })
  export class CrtMockComponent implements OnInit, OnDestroy {
    readonly questions = signal<CrtMockQuestion[]>([]);
    readonly selectedAnswers = signal<Record<string, number>>({});
    readonly currentIndex = signal(0);
    readonly remainingSeconds = signal(0);
    readonly isLoading = signal(true);
    readonly isSubmitting = signal(false);
    readonly errorMessage = signal('');
    readonly saveErrorMessage = signal('');

    readonly currentQuestion = computed(
      () => this.questions()[this.currentIndex()] ?? null
    );

    readonly answeredCount = computed(
      () => Object.keys(this.selectedAnswers()).length
    );

    private pathId = '';
    private attemptId = '';

    private pendingAnswerSaves = new Set<Promise<boolean>>();
    private failedAnswerIds = new Set<string>();
    private timerId?: ReturnType<typeof setInterval>;

    constructor(
      private readonly route: ActivatedRoute,
      private readonly router: Router,
      private readonly mockService: CrtMockService
    ) {}

    async ngOnInit(): Promise<void> {
      this.pathId = this.route.snapshot.paramMap.get('pathId') ?? '';

      if (!this.pathId) {
        this.errorMessage.set('Learning path was not found.');
        this.isLoading.set(false);
        return;
      }

      try {
        const attempt = await this.mockService.startMockAttempt(this.pathId);
        this.attemptId = attempt.mock_attempt_id;

        const [questions, answers] = await Promise.all([
          this.mockService.getMockQuestions(this.attemptId),
          this.mockService.listAnswers(this.attemptId),
        ]);

        if (questions.length === 0) {
          throw new Error('No questions are available for this mock test.');
        }

        this.questions.set(questions);

        const savedAnswers: Record<string, number> = {};

        for (const answer of answers) {
          if (answer.selected_index !== null) {
            savedAnswers[answer.question_id] = answer.selected_index;
          }
        }

        this.selectedAnswers.set(savedAnswers);
        this.startTimer(attempt.mock_expires_at);
      } catch (error) {
        this.errorMessage.set(
          error instanceof Error
            ? error.message
            : 'Unable to load the mock test.'
        );
      } finally {
        this.isLoading.set(false);
      }
    }

    ngOnDestroy(): void {
      this.clearTimer();
    }

    selectAnswer(index: number): void {
      const question = this.currentQuestion();

      if (
        !question ||
        this.isSubmitting() ||
        (index !== 0 && index !== 1 && index !== 2 && index !== 3)
      ) {
        return;
      }

      this.selectedAnswers.update((answers) => ({
        ...answers,
        [question.question_id]: index,
      }));

      this.saveErrorMessage.set('');
      void this.saveSelectedAnswer(question.question_id, index);
    }

    private async saveSelectedAnswer(
      questionId: string,
      selectedIndex: 0 | 1 | 2 | 3
    ): Promise<void> {
      if (
        selectedIndex !== 0 &&
        selectedIndex !== 1 &&
        selectedIndex !== 2 &&
        selectedIndex !== 3
      ) {
        return;
      }

      const savePromise = this.mockService
        .saveAnswer(this.attemptId, questionId, selectedIndex)
        .then(() => {
          this.failedAnswerIds.delete(questionId);
          this.saveErrorMessage.set('');
          return true;
        })
        .catch((error) => {
          this.failedAnswerIds.add(questionId);
          this.saveErrorMessage.set(
            error instanceof Error
              ? error.message
              : 'Unable to save your answer.'
          );
          return false;
        });

      this.pendingAnswerSaves.add(savePromise);

      try {
        await savePromise;
      } finally {
        this.pendingAnswerSaves.delete(savePromise);
      }
    }

    previousQuestion(): void {
      this.currentIndex.update((index) => Math.max(0, index - 1));
    }

    nextQuestion(): void {
      this.currentIndex.update((index) =>
        Math.min(this.questions().length - 1, index + 1)
      );
    }

    goToQuestion(index: number): void {
      if (index >= 0 && index < this.questions().length) {
        this.currentIndex.set(index);
      }
    }

    async submitTest(): Promise<void> {
      if (!this.attemptId || this.isSubmitting()) {
        return;
      }

      this.isSubmitting.set(true);
      this.clearTimer();

      try {
        await Promise.all([...this.pendingAnswerSaves]);

        if (this.failedAnswerIds.size > 0) {
          throw new Error(
            'Some answers could not be saved. Please select those answers again before submitting.'
          );
        }

        await this.mockService.submitMockAttempt(this.attemptId);

        await this.router.navigate([
          '/crt/mock',
          this.pathId,
          'attempts',
          this.attemptId,
          'result',
        ]);
      } catch (error) {
        this.errorMessage.set(
          error instanceof Error
            ? error.message
            : 'Unable to submit the mock test.'
        );
        this.isSubmitting.set(false);
      }
    }

    private startTimer(expiresAt: string): void {
      const updateRemainingTime = (): void => {
        const remaining = Math.max(
          0,
          Math.ceil(
            (new Date(expiresAt).getTime() - Date.now()) / 1000
          )
        );

        this.remainingSeconds.set(remaining);

        if (remaining <= 0) {
          this.clearTimer();
          void this.submitTest();
        }
      };

      updateRemainingTime();

      if (this.remainingSeconds() > 0) {
        this.timerId = setInterval(updateRemainingTime, 1000);
      }
    }

    private clearTimer(): void {
      if (this.timerId) {
        clearInterval(this.timerId);
        this.timerId = undefined;
      }
    }

    formatTime(): string {
      const minutes = Math.floor(this.remainingSeconds() / 60);
      const seconds = this.remainingSeconds() % 60;

      return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    isAnswered(questionId: string): boolean {
      return this.selectedAnswers()[questionId] !== undefined;
    }
  }
