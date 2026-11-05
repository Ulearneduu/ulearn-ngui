import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CrtAttemptReview, CrtPracticeService } from '../services/crt-practice.service';

@Component({
  selector: 'app-crt-review',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './crt-review.html',
  styles: `
    .crt-review {
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
    .note,
    .review-card p {
      margin: 0;
      color: var(--muted);
    }
    .status,
    .banner,
    .note {
      margin-top: 32px;
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
    .review-list {
      display: grid;
      gap: 16px;
      margin: 16px 0 0;
      padding: 0;
      list-style: none;
    }
    .review-card {
      display: grid;
      gap: 8px;
      padding: 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
    }
    .review-card h2,
    .stem {
      margin: 0;
      color: var(--navy);
    }
    .review-card h2 {
      font-size: 1rem;
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
export class CrtReview implements OnInit {
  private readonly practice = inject(CrtPracticeService);
  private readonly route = inject(ActivatedRoute);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly reviews = signal<CrtAttemptReview[]>([]);
  private attemptId = '';

  ngOnInit(): void {
    this.attemptId = this.route.snapshot.paramMap.get('attemptId') ?? '';
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    this.reviews.set([]);

    if (!this.attemptId) {
      this.loadError.set('This review could not be found.');
      this.loading.set(false);
      return;
    }

    try {
      await this.practice.getMySubmittedAttempt(this.attemptId);
      this.reviews.set(await this.practice.reviewAttempt(this.attemptId));
    } catch (error: unknown) {
      this.reviews.set([]);
      this.loadError.set(error instanceof Error ? error.message : 'Could not load this review.');
    } finally {
      this.loading.set(false);
    }
  }

  selectedAnswer(review: CrtAttemptReview): string {
    return this.optionText(review.options, review.selected_index, 'No answer selected');
  }

  correctAnswer(review: CrtAttemptReview): string {
    return this.optionText(review.options, review.correct_index, 'Correct answer unavailable');
  }

  correctness(review: CrtAttemptReview): string {
    if (review.is_correct === true) return 'Correct';
    if (review.is_correct === false) return 'Incorrect';
    return 'Not scored';
  }

  private optionText(
    options: [string, string, string, string],
    index: 0 | 1 | 2 | 3 | null,
    fallback: string,
  ): string {
    if (index === null) return fallback;
    const labels = ['A', 'B', 'C', 'D'];
    return `${labels[index]}. ${options[index]}`;
  }
}
