import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { InterviewTemplate, InterviewTemplateKind } from '../models';
import { InterviewCatalogService, interviewErrorMessage } from './interview-catalog.service';

interface CatalogGroup {
  kind: InterviewTemplateKind;
  label: string;
  description: string;
  templates: InterviewTemplate[];
}

const KIND_COPY: Record<InterviewTemplateKind, { label: string; description: string }> = {
  hr: {
    label: 'HR',
    description:
      'Behavioral questions about teamwork, communication, challenges, and how you make decisions.',
  },
  technical: {
    label: 'Technical',
    description:
      'Programming, data structures, algorithms, and how you explain a technical solution.',
  },
  domain: {
    label: 'Domain',
    description: 'Questions focused on a specific subject area.',
  },
};

const KIND_ORDER: readonly InterviewTemplateKind[] = ['hr', 'technical', 'domain'];

@Component({
  selector: 'app-interview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="interview-page">
      <header class="page-header">
        <h1>Interview</h1>
        <p>Choose a published interview and start a new session.</p>
      </header>

      @if (loading()) {
        <p class="status" role="status">Loading interviews…</p>
      } @else if (loadError()) {
        <div class="banner error" role="alert">
          <p>{{ loadError() }}</p>
          <button type="button" class="btn-outline" (click)="load()">Try again</button>
        </div>
      } @else if (groups().length === 0) {
        <p class="status">No published interviews are available yet.</p>
      } @else {
        @if (startError()) {
          <div class="banner error" role="alert">
            <p>{{ startError() }}</p>
          </div>
        }

        @for (group of groups(); track group.kind) {
          <section class="group" [attr.aria-labelledby]="'interview-group-' + group.kind">
            <h2 [id]="'interview-group-' + group.kind">{{ group.label }}</h2>
            <div class="cards">
              @for (template of group.templates; track template.id) {
                <article class="card">
                  <p class="kind">{{ group.label }}</p>
                  <h3>{{ template.title }}</h3>
                  <p class="description">{{ group.description }}</p>
                  <p class="meta">{{ template.durationMinutes }} minutes</p>
                  <button
                    type="button"
                    class="btn-primary"
                    [disabled]="startingId() !== null"
                    (click)="start(template)"
                  >
                    {{ startingId() === template.id ? 'Starting…' : 'Start' }}
                  </button>
                </article>
              }
            </div>
          </section>
        }
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
    .description,
    .meta {
      margin: 0;
      color: var(--muted);
    }
    .group {
      margin-top: 32px;
    }
    .group h2 {
      margin: 0 0 12px;
      color: var(--navy);
      font-size: 1.15rem;
    }
    .cards {
      display: grid;
      gap: 16px;
    }
    @media (min-width: 768px) {
      .cards {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
    }
    .kind {
      margin: 0;
      color: var(--purple);
      font-size: 0.75rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .card h3 {
      margin: 0;
      color: var(--navy);
      font-size: 1.15rem;
    }
    .card .btn-primary {
      align-self: flex-start;
      margin-top: 8px;
    }
    .card .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
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
  `,
})
export class Interview implements OnInit {
  private readonly catalog = inject(InterviewCatalogService);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly startError = signal<string | null>(null);
  readonly startingId = signal<string | null>(null);
  readonly templates = signal<InterviewTemplate[]>([]);

  readonly groups = computed<CatalogGroup[]>(() => {
    const templates = this.templates();
    return KIND_ORDER.map((kind) => ({
      kind,
      label: KIND_COPY[kind].label,
      description: KIND_COPY[kind].description,
      templates: templates.filter((template) => template.kind === kind),
    })).filter((group) => group.templates.length > 0);
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      this.templates.set(await this.catalog.listPublishedTemplates());
    } catch (error: unknown) {
      this.templates.set([]);
      this.loadError.set(interviewErrorMessage(error, 'Could not load interviews.'));
    } finally {
      this.loading.set(false);
    }
  }

  async start(template: InterviewTemplate): Promise<void> {
    if (this.startingId()) return;
    this.startingId.set(template.id);
    this.startError.set(null);
    try {
      const sessionId = await this.catalog.startSession(template);
      const opened = await this.router.navigate(['/interview/session', sessionId]);
      if (!opened) {
        this.startError.set('The interview started, but the session page could not be opened.');
      }
    } catch (error: unknown) {
      this.startError.set(interviewErrorMessage(error, 'Could not start this interview.'));
    } finally {
      this.startingId.set(null);
    }
  }
}
