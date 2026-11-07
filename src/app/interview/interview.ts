import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { InterviewTemplate, InterviewTemplateKind } from '../models';
import { InterviewCatalogService, interviewErrorMessage } from './interview-catalog.service';
import {
  RESUME_TEXT_MAX,
  extractResumeFile,
  resumeLimitMessage,
  resumeTextForSession,
  validateResumeFile,
} from './interview-resume';
import { InterviewQuota, InterviewService } from './interview.service';

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
  imports: [RouterLink, RouterLinkActive],
  template: `
    <div class="interview-page">
      <header class="page-header">
        <h1>Interview</h1>
        <p>Choose a published interview and start a new session.</p>
      </header>

      @if (quotaLoading()) {
        <p class="status" role="status">Loading your weekly quota…</p>
      } @else if (quotaError()) {
        <div class="banner error" role="alert">
          <p>{{ quotaError() }}</p>
          <button type="button" class="btn-outline" (click)="refreshQuota()">Try again</button>
        </div>
      } @else if (quota(); as currentQuota) {
        <section class="quota-card" aria-label="Weekly interview quota">
          <h2>This week</h2>
          <p class="meta">{{ currentQuota.used }} / {{ currentQuota.weekly_limit }} attempts used. {{ currentQuota.remaining }} remaining.</p>
          <p class="meta">Resets {{ formatReset(currentQuota.resets_at) }}.</p>
          @if (currentQuota.remaining === 0) {
            <p class="status">Weekly mock interview limit reached. Try again after the reset time shown above.</p>
          }
        </section>
      }

      <section class="resume-card" aria-labelledby="resume-heading">
        <h2 id="resume-heading">Resume (Optional)</h2>
        <p class="meta">Paste your resume or upload a PDF, DOCX, or TXT file. You can edit the text before you start.</p>
        <label class="field-label" for="resume-text">Resume (Optional)</label>
        <textarea
          id="resume-text"
          rows="8"
          placeholder="Paste resume text. Include projects, technologies, responsibilities, and achievements you want the interviewer to ask about."
          [value]="resumeText()"
          (input)="onResumeInput($event)"
        ></textarea>
        <p class="counter" [class.over]="resumeOverLimit()">{{ resumeText().length }} / {{ resumeMax }}</p>
        @if (extracting()) {
          <p class="status" role="status">Extracting resume text…</p>
        }
        @if (resumeError()) {
          <p class="resume-error" role="alert">{{ resumeError() }}</p>
        }
        @if (resumeFileName()) {
          <p class="meta">Loaded from {{ resumeFileName() }}. You can edit the extracted text before starting.</p>
        }
        <div class="resume-actions">
          <label class="btn-outline file-label">
            {{ extracting() ? 'Extracting…' : 'Upload PDF, DOCX, or TXT' }}
            <input
              #resumeFile
              type="file"
              accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
              [disabled]="extracting()"
              (change)="onResumeFile($event)"
            />
          </label>
          @if (resumeText() || resumeFileName()) {
            <button type="button" class="btn-outline" (click)="clearResume(resumeFile)">Remove resume</button>
          }
        </div>
        <p class="privacy">
          Providing a resume is optional. Resume information is used to personalize the mock interview.
          Resume information is associated with the interview session. Students should avoid submitting
          unnecessary sensitive personal information. Resume information is handled according to the
          documented retention policy.
        </p>
      </section>

      <nav class="interview-tabs" aria-label="Interview sections">
        <a routerLink="/interview" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">
          Catalog
        </a>
        <a routerLink="/interview/history" routerLinkActive="active">History</a>
      </nav>

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
                    [disabled]="startingId() !== null || quotaExhausted() || extracting() || resumeOverLimit()"
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
    .quota-card {
      margin-top: 32px;
      padding: 24px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--card);
    }
    .quota-card h2 {
      margin: 0 0 8px;
      color: var(--navy);
      font-size: 1.125rem;
    }
    .quota-card .meta + .meta,
    .quota-card .status {
      margin-top: 8px;
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
    .resume-card {
      margin-top: 24px;
      padding: 24px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--card);
    }
    .resume-card h2,
    .field-label {
      margin: 0 0 8px;
      color: var(--navy);
      font-size: 1.125rem;
    }
    .field-label {
      display: block;
      margin-top: 16px;
      font-size: 0.9375rem;
      font-weight: 700;
    }
    .resume-card textarea {
      width: 100%;
      min-height: 160px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 12px;
      resize: vertical;
      font: inherit;
      color: var(--navy);
      background: #fff;
    }
    .counter {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 0.875rem;
    }
    .counter.over,
    .resume-error {
      color: #9b1c1c;
    }
    .resume-error {
      margin: 8px 0 0;
      font-weight: 700;
    }
    .resume-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .file-label {
      display: inline-flex;
      align-items: center;
    }
    .file-label input {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      border: 0;
    }
    .privacy {
      margin: 16px 0 0;
      color: var(--muted);
      font-size: 0.875rem;
    }
    @media (max-width: 640px) {
      .interview-page {
        padding: 32px 16px 56px;
      }
      .resume-actions .btn-outline,
      .file-label {
        width: 100%;
        justify-content: center;
        text-align: center;
      }
    }
  `,
})
export class Interview implements OnInit {
  private readonly catalog = inject(InterviewCatalogService);
  private readonly quotaService = inject(InterviewService);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly startError = signal<string | null>(null);
  readonly startingId = signal<string | null>(null);
  readonly templates = signal<InterviewTemplate[]>([]);
  readonly quotaLoading = signal(true);
  readonly quotaError = signal<string | null>(null);
  readonly quota = signal<InterviewQuota | null>(null);
  readonly resumeText = signal('');
  readonly resumeError = signal<string | null>(null);
  readonly resumeFileName = signal<string | null>(null);
  readonly extracting = signal(false);
  readonly resumeMax = RESUME_TEXT_MAX;

  readonly resumeOverLimit = computed(() => resumeLimitMessage(this.resumeText()) !== null);

  readonly quotaExhausted = computed(() => {
    const current = this.quota();
    return current !== null && current.remaining <= 0;
  });

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
    void this.refreshQuota();
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

  async refreshQuota(): Promise<void> {
    this.quotaLoading.set(true);
    this.quotaError.set(null);
    const outcome = await this.quotaService.loadQuota();
    this.quotaLoading.set(false);
    if (!outcome.ok) {
      this.quota.set(null);
      this.quotaError.set(outcome.error);
      return;
    }
    this.quota.set(outcome.quota);
  }

  formatReset(iso: string): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Kolkata',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  onResumeInput(event: Event): void {
    const value = event.target instanceof HTMLTextAreaElement ? event.target.value : '';
    this.resumeText.set(value);
    this.resumeError.set(resumeLimitMessage(value));
  }

  async onResumeFile(event: Event): Promise<void> {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const file = input?.files?.[0];
    if (!file) return;
    const valid = validateResumeFile(file);
    if (!valid.ok) {
      this.resumeError.set(valid.error);
      if (input) input.value = '';
      return;
    }
    this.extracting.set(true);
    this.resumeError.set(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extracted = await extractResumeFile({
        name: file.name,
        type: file.type,
        size: file.size,
        bytes,
      });
      if (!extracted.ok) {
        this.resumeError.set(extracted.error);
        return;
      }
      this.resumeText.set(extracted.text);
      this.resumeFileName.set(file.name);
      this.resumeError.set(resumeLimitMessage(extracted.text));
    } catch {
      this.resumeError.set('The resume text could not be read from that file.');
    } finally {
      this.extracting.set(false);
      if (input) input.value = '';
    }
  }

  clearResume(input?: HTMLInputElement): void {
    this.resumeText.set('');
    this.resumeError.set(null);
    this.resumeFileName.set(null);
    if (input) input.value = '';
  }

  async start(template: InterviewTemplate): Promise<void> {
    if (this.startingId() || this.quotaExhausted() || this.extracting()) return;
    const resume = resumeTextForSession(this.resumeText());
    if (resume.error) {
      this.resumeError.set(resume.error);
      this.startError.set(resume.error);
      return;
    }
    this.startingId.set(template.id);
    this.startError.set(null);
    try {
      const sessionId = await this.catalog.startSession(template, resume.text);
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
