import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { formatCompletedAt, formatScore, interviewKindLabel } from '../../../interview/interview-evaluation';
import type { InterviewReviewQueueItem } from '../../../models';
import { AdminInterviewReviewsService } from '../../services/admin-interview-reviews.service';
import { InterviewAdminShell } from '../interview-shell/interview-shell';

@Component({
  selector: 'app-admin-interview-reviews',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, InterviewAdminShell],
  templateUrl: './interview-reviews.html',
  styleUrl: './interview-reviews.scss',
})
export class AdminInterviewReviews implements OnInit {
  private readonly reviews = inject(AdminInterviewReviewsService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly rows = signal<InterviewReviewQueueItem[]>([]);

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.rows.set(await this.reviews.listQueue());
    } catch (err) {
      this.rows.set([]);
      this.error.set(err instanceof Error ? err.message : 'Could not load the review queue.');
    } finally {
      this.loading.set(false);
    }
  }

  kindLabel(kind: string | null): string {
    return kind ? interviewKindLabel(kind) : 'Interview';
  }

  scoreText(score: number | null): string {
    return score === null ? '—' : formatScore(score);
  }

  endedLabel(value: string | null): string {
    return formatCompletedAt(value) ?? '—';
  }

  reviewStatus(row: InterviewReviewQueueItem): string {
    return row.mentorReviewPublished ? 'Published to student' : 'Unpublished';
  }
}
