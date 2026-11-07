import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CrtHistoryAttempt, CrtAttemptSummary, CrtPracticeService } from '../services/crt-practice.service';

@Component({
  selector: 'app-crt-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './crt-history.html',
  styles: `
    .crt-history {
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
    .page-header p,
    .status,
    .attempt-card p {
      margin: 0;
      color: var(--muted);
    }
    .status,
    .banner {
      margin-top: 32px;
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
    .attempt-list {
      display: grid;
      gap: 16px;
      margin: 32px 0 0;
      padding: 0;
      list-style: none;
    }
    .attempt-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      padding: 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
    }
    .status-line {
      color: var(--navy);
      font-weight: 700;
    }
    .btn-primary {
      margin-top: 8px;
      padding: 10px 18px;
      border-radius: 8px;
      background: var(--purple);
      color: #fff;
      font-weight: 700;
      text-decoration: none;
    }
  `
})
export class CrtHistory implements OnInit {
  private readonly practice = inject(CrtPracticeService);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly attempts = signal<CrtHistoryAttempt[]>([]);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      this.attempts.set(await this.practice.listMyHistoryAttempts());
    } catch (error: unknown) {
      this.attempts.set([]);
      this.loadError.set(error instanceof Error ? error.message : 'Could not load attempt history.');
    } finally {
      this.loading.set(false);
    }
  }

  statusLabel(status: CrtAttemptSummary['status']): string {
    return status === 'submitted' ? 'Submitted' : 'In progress';
  }

  formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  scoreLabel(attempt: CrtAttemptSummary): string {
    if (attempt.status !== 'submitted' || attempt.score === null || attempt.max_score === null) {
      return 'Not submitted';
    }
    return `${attempt.score} of ${attempt.max_score}`;
  }

  durationLabel(attempt: CrtAttemptSummary): string {
    if (attempt.status !== 'submitted') return 'Not submitted';
    return formatElapsed(attempt.duration_seconds);
  }
}

function formatElapsed(totalSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
