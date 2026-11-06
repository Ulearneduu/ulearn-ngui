
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  signal,
} from '@angular/core';

import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
  import {
    CrtMockResultSection,
    CrtMockService,
  } from '../services/crt-mock.service';

  @Component({
    selector: 'app-crt-mock-result',
    standalone: true,
    imports: [RouterLink, DecimalPipe],
    templateUrl: './crt-mock-result.html',
    styleUrl: './crt-mock-result.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
  })
  export class CrtMockResultComponent implements OnInit {
    readonly sections = signal<CrtMockResultSection[]>([]);
    readonly isLoading = signal(true);
    readonly errorMessage = signal('');

    readonly totalScore = computed(() =>
      this.sections().reduce((total, section) => total + section.section_score, 0)
    );

    readonly totalQuestions = computed(() =>
      this.sections().reduce(
        (total, section) => total + section.section_max_score,
        0
      )
    );

    readonly percentage = computed(() =>
      this.totalQuestions() > 0
        ? Math.round((this.totalScore() / this.totalQuestions()) * 100)
        : 0
    );

    private attemptId = '';

    constructor(
      private readonly route: ActivatedRoute,
      private readonly mockService: CrtMockService
    ) {}

    async ngOnInit(): Promise<void> {
      this.attemptId =
        this.route.snapshot.paramMap.get('attemptId') ?? '';

      if (!this.attemptId) {
        this.errorMessage.set('Mock attempt was not found.');
        this.isLoading.set(false);
        return;
      }

      try {
        const results =
          await this.mockService.getSectionResults(this.attemptId);
        this.sections.set(results);
      } catch (error) {
        this.errorMessage.set(
          error instanceof Error
            ? error.message
            : 'Unable to load your mock test results.'
        );
      } finally {
        this.isLoading.set(false);
      }
    }
  }
