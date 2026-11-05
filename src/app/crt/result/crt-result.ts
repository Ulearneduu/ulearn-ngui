import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CrtAttemptSummary, CrtPracticeService } from '../services/crt-practice.service';

@Component({
  selector: 'app-crt-result',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './crt-result.html',
  styles: `
    .crt-result {
      max-width: 720px;
      margin: 0 auto;
      padding: 48px 24px 72px;
    }
    .page-header a {
      color: var(--purple);
      font-weight: 700;
      text-decoration: none;
    }
    .page-links {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
    }
    .page-header h1 {
      margin: 16px 0 8px;
      color: var(--navy);
      font-family: 'Poppins', sans-serif;
    }
    .status,
    .note {
      margin: 0;
      color: var(--muted);
    }
    .summary {
      display: grid;
      gap: 12px;
      margin-top: 32px;
      padding: 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
    }
    .summary dt {
      color: var(--muted);
      font-size: 0.875rem;
    }
    .summary dd {
      margin: 4px 0 0;
      color: var(--navy);
      font-size: 1.25rem;
      font-weight: 700;
    }
    .confirmation {
      margin-top: 24px;
      color: var(--navy);
      font-weight: 700;
    }
    .note,
    .status,
    .banner {
      margin-top: 24px;
    }
    .note {
      max-width: 62ch;
      line-height: 1.5;
    }
    .banner {
      padding: 16px;
      border: 1px solid #f3c2c2;
      border-radius: 12px;
      background: #fdecec;
    }
    .banner p {
      margin: 0 0 12px;
      color: var(--navy);
    }
    .btn-primary {
      padding: 10px 18px;
      border: none;
      border-radius: 8px;
      background: var(--purple);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
  `
})
export class CrtResult implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly practice = inject(CrtPracticeService);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly result = signal<CrtAttemptSummary | null>(null);
  readonly pathId = signal('');
  readonly timeTaken = computed(() => {
    const duration = this.result()?.duration_seconds;
    return duration === undefined ? '' : formatElapsed(duration);
  });

  scoreText(): string {
    const score = this.result()?.score;
    return score === null || score === undefined ? 'Not available' : String(score);
  }

  maxScoreText(): string {
    const maxScore = this.result()?.max_score;
    return maxScore === null || maxScore === undefined ? 'Not available' : String(maxScore);
  }
  private moduleId = '';
  private attemptId = '';

  ngOnInit(): void {
    this.pathId.set(this.route.snapshot.paramMap.get('pathId') ?? '');
    this.moduleId = this.route.snapshot.paramMap.get('moduleId') ?? '';
    this.attemptId = this.route.snapshot.paramMap.get('attemptId') ?? '';
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);

    if (!this.pathId() || !this.moduleId || !this.attemptId) {
      this.result.set(null);
      this.loadError.set('This result could not be found.');
      this.loading.set(false);
      return;
    }

    try {
      const attempt = await this.practice.getMySubmittedAttempt(this.attemptId);
      if (attempt.path_id !== this.pathId() || attempt.module_id !== this.moduleId) {
        this.result.set(null);
        this.loadError.set('This result does not belong to the selected module.');
        return;
      }
      this.result.set(attempt);
    } catch (error: unknown) {
      this.result.set(null);
      this.loadError.set(error instanceof Error ? error.message : 'Could not load this result.');
    } finally {
      this.loading.set(false);
    }
  }
}

function formatElapsed(totalSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
