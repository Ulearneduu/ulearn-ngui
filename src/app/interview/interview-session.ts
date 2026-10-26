import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { InterviewSessionSummary } from '../models';
import { InterviewCatalogService, interviewErrorMessage } from './interview-catalog.service';

@Component({
  selector: 'app-interview-session',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="session-page">
      @if (loading()) {
        <p class="status" role="status">Opening interview…</p>
      } @else if (error()) {
        <div class="banner error" role="alert">
          <p>{{ error() }}</p>
          <a class="btn-outline" routerLink="/interview">Back to interviews</a>
        </div>
      } @else if (session(); as current) {
        <p class="kind">{{ kindLabel(current.templateKind) }}</p>
        <h1>{{ current.templateTitle }}</h1>
        <p class="status">{{ statusLabel(current.status) }}</p>
        <p class="meta">Session {{ current.id }}</p>
        <a class="btn-outline" routerLink="/interview">Back to interviews</a>
      }
    </div>
  `,
  styles: `
    .session-page {
      max-width: 720px;
      margin: 0 auto;
      padding: 48px 24px 72px;
    }
    h1 {
      margin: 0 0 8px;
      color: var(--navy);
      font-family: 'Poppins', sans-serif;
    }
    .kind {
      margin: 0 0 8px;
      color: var(--purple);
      font-size: 0.75rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .status,
    .meta {
      margin: 0 0 12px;
      color: var(--muted);
    }
    .banner {
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
    a.btn-outline {
      text-decoration: none;
    }
  `,
})
export class InterviewSession {
  private readonly route = inject(ActivatedRoute);
  private readonly catalog = inject(InterviewCatalogService);

  private readonly sessionId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' }
  );

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly session = signal<InterviewSessionSummary | null>(null);

  constructor() {
    effect(() => {
      const id = this.sessionId();
      void this.load(id);
    });
  }

  kindLabel(kind: InterviewSessionSummary['templateKind']): string {
    if (kind === 'hr') return 'HR';
    if (kind === 'technical') return 'Technical';
    return 'Domain';
  }

  statusLabel(status: InterviewSessionSummary['status']): string {
    if (status === 'in_progress') return 'This interview is in progress.';
    if (status === 'completed') return 'This interview is complete.';
    return 'This interview could not be finished.';
  }

  private async load(sessionId: string): Promise<void> {
    if (!sessionId) {
      this.session.set(null);
      this.error.set('This interview session could not be opened.');
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    try {
      const session = await this.catalog.getOwnSession(sessionId);
      this.session.set(session);
      if (!session) {
        this.error.set('This interview session could not be opened.');
      }
    } catch (error: unknown) {
      this.session.set(null);
      this.error.set(interviewErrorMessage(error, 'Could not open this interview.'));
    } finally {
      this.loading.set(false);
    }
  }
}
