import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { InterviewHistoryItem, InterviewSessionStatus } from '../models';
import { InterviewCatalogService, interviewErrorMessage } from './interview-catalog.service';

@Component({
  selector: 'app-interview-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <div class="interview-page">
      <header class="page-header">
        <h1>Interview History</h1>
        <p>Past mock interviews and your progress.</p>
      </header>

      <nav class="interview-tabs" aria-label="Interview sections">
        <a routerLink="/interview" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">
          Catalog
        </a>
        <a routerLink="/interview/history" routerLinkActive="active">History</a>
      </nav>

      @if (loading()) {
        <p class="status" role="status">Loading your interview history…</p>
      } @else if (loadError()) {
        <div class="banner error" role="alert">
          <p>{{ loadError() }}</p>
          <button type="button" class="btn-outline" (click)="load()">Try again</button>
        </div>
      } @else if (sessions().length === 0) {
        <p class="status">No mock interviews yet.</p>
        <a class="btn-primary" routerLink="/interview">Browse interviews</a>
      } @else {
        <ul class="history-list">
          @for (session of sessions(); track session.id) {
            <li class="history-card">
              <div class="history-main">
                <h2>{{ session.templateTitle }}</h2>
                <p class="meta">{{ formatDate(session) }}</p>
                <p class="meta">
                  <span class="badge" [attr.data-status]="session.status">{{ statusLabel(session.status) }}</span>
                  @if (session.redoOfSessionId) {
                    <span class="badge redo">Redo</span>
                  }
                  @if (session.status === 'completed') {
                    <span class="score">Score: {{ scoreLabel(session) }}</span>
                    @if (session.mentorAdjusted) {
                      <span class="mentor-adjusted">Mentor-adjusted</span>
                    }
                  }
                </p>
              </div>
              <div class="history-actions">
                @if (session.status === 'completed') {
                  <button type="button" class="btn-primary" (click)="openFeedback(session.id)">
                    View Feedback
                  </button>
                } @else if (session.status === 'in_progress') {
                  <button type="button" class="btn-outline" (click)="resume(session.id)">Resume</button>
                } @else {
                  <button type="button" class="btn-outline" (click)="viewDetails(session.id)">
                    View details
                  </button>
                }
              </div>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    .interview-page {
      max-width: 960px;
      margin: 0 auto;
      padding: 48px 24px 72px;
    }
    .page-header h1 {
      margin: 0 0 8px;
      color: var(--navy);
      font-family: 'Poppins', sans-serif;
    }
    .page-header p,
    .status,
    .meta {
      margin: 0;
      color: var(--muted);
    }
    .interview-tabs {
      display: flex;
      gap: 8px;
      margin: 24px 0 28px;
      padding: 4px;
      border-radius: 10px;
      background: var(--card);
      border: 1px solid var(--border);
      width: fit-content;
    }
    .interview-tabs a {
      padding: 8px 16px;
      border-radius: 8px;
      text-decoration: none;
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--muted);
    }
    .interview-tabs a.active {
      background: var(--navy);
      color: #fff;
    }
    .history-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .history-card {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
    }
    @media (min-width: 640px) {
      .history-card {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
      }
    }
    .history-main h2 {
      margin: 0 0 8px;
      font-size: 1.15rem;
      color: var(--navy);
    }
    .badge {
      display: inline-block;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 4px 8px;
      border-radius: 6px;
      background: #eef2ff;
      color: var(--navy);
    }
    .badge[data-status='completed'] {
      background: #e8f5ee;
      color: #166534;
    }
    .badge[data-status='failed'] {
      background: #fdecec;
      color: #991b1b;
    }
    .badge.redo {
      margin-left: 8px;
      background: #f3eff9;
      color: var(--purple);
    }
    .score {
      margin-left: 12px;
      font-size: 0.875rem;
      color: var(--navy);
    }
    .mentor-adjusted {
      margin-left: 10px;
      font-size: 0.75rem;
      font-weight: 800;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: #65469b;
    }
    .history-actions {
      flex-shrink: 0;
    }
    .banner {
      margin-top: 20px;
      padding: 14px 16px;
      border-radius: 12px;
    }
    .banner p {
      margin: 0 0 12px;
    }
    .banner.error {
      background: #fdecec;
      color: var(--navy);
      border: 1px solid #f3c2c2;
    }
    a.btn-primary,
    button.btn-primary,
    button.btn-outline {
      cursor: pointer;
      border-radius: 8px;
      padding: 10px 18px;
      font-size: 0.9375rem;
      text-decoration: none;
      display: inline-block;
    }
    a.btn-primary,
    button.btn-primary {
      border: none;
      background: var(--purple);
      color: #fff;
    }
    button.btn-outline {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--navy);
    }
  `,
})
export class InterviewHistory implements OnInit {
  private readonly catalog = inject(InterviewCatalogService);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly sessions = signal<InterviewHistoryItem[]>([]);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      this.sessions.set(await this.catalog.listOwnSessions());
    } catch (error: unknown) {
      this.sessions.set([]);
      this.loadError.set(interviewErrorMessage(error, 'Could not load interview history.'));
    } finally {
      this.loading.set(false);
    }
  }

  formatDate(session: InterviewHistoryItem): string {
    const iso = session.status === 'completed' && session.endedAt ? session.endedAt : session.startedAt;
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(iso)
      );
    } catch {
      return iso;
    }
  }

  statusLabel(status: InterviewSessionStatus): string {
    if (status === 'in_progress') return 'In progress';
    if (status === 'completed') return 'Completed';
    return 'Failed';
  }

  scoreLabel(session: InterviewHistoryItem): string {
    if (session.overallScore === null) return 'Pending';
    return String(Math.round(session.overallScore));
  }

  openFeedback(sessionId: string): void {
    void this.router.navigate(['/interview/session', sessionId, 'result']);
  }

  resume(sessionId: string): void {
    void this.router.navigate(['/interview/session', sessionId]);
  }

  viewDetails(sessionId: string): void {
    void this.router.navigate(['/interview/session', sessionId]);
  }
}
