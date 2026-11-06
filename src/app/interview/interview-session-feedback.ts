import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

/**
 * Placeholder for the scorecard / feedback page (INT-030 / evaluation).
 * INT-007 navigates here; full feedback UI is implemented separately.
 */
@Component({
  selector: 'app-interview-session-feedback',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="feedback-page">
      <p class="kind">Feedback</p>
      <h1>Your interview feedback</h1>
      <p class="status" role="status">
        Detailed scores and transcript will appear here once the scorecard is available.
      </p>
      <p class="meta">Session {{ sessionId() }}</p>
      <div class="actions">
        <a class="btn-outline" routerLink="/interview/history">Back to history</a>
        <a class="btn-outline" routerLink="/interview">Catalog</a>
      </div>
    </div>
  `,
  styles: `
    .feedback-page {
      max-width: 720px;
      margin: 0 auto;
      padding: 48px 24px 72px;
    }
    .kind {
      margin: 0 0 8px;
      color: var(--purple);
      font-size: 0.75rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0 0 12px;
      color: var(--navy);
      font-family: 'Poppins', sans-serif;
    }
    .status,
    .meta {
      margin: 0 0 12px;
      color: var(--muted);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 24px;
    }
    a.btn-outline {
      text-decoration: none;
      border-radius: 8px;
      padding: 10px 18px;
      font-size: 0.9375rem;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--navy);
    }
  `,
})
export class InterviewSessionFeedback {
  private readonly route = inject(ActivatedRoute);

  readonly sessionId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' }
  );
}
