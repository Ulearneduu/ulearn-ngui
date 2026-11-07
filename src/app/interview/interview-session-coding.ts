import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  DEFAULT_INTERVIEW_CODING_LANGUAGE,
  INTERVIEW_CODING_LANGUAGES,
  InterviewCodingProblem,
  InterviewCodingPublicTestResult,
  normalizeInterviewCodingLanguage,
} from './interview-coding';
import { InterviewCatalogService, interviewErrorMessage } from './interview-catalog.service';

@Component({
  selector: 'app-interview-session-coding',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="coding-step" aria-labelledby="coding-step-title">
      <div class="coding-head">
        <h2 id="coding-step-title">{{ problem().title }}</h2>
        <p class="hint">Optional coding step. The interview timer keeps running.</p>
      </div>

      <div class="coding-split">
        <aside class="spec">
          <p class="prompt">{{ problem().prompt }}</p>
          <h3>Sample tests</h3>
          @if (problem().publicTestCases.length === 0) {
            <p class="muted">No public sample cases for this problem.</p>
          }
          @for (sample of problem().publicTestCases; track $index) {
            <div class="sample">
              <p><span>Input</span></p>
              <pre>{{ sample.input || '(empty)' }}</pre>
              <p><span>Expected</span></p>
              <pre>{{ sample.expectedOutput || '(empty)' }}</pre>
            </div>
          }
        </aside>

        <div class="workspace">
          <label class="lang">
            <span>Language</span>
            <select [ngModel]="language()" (ngModelChange)="onLanguage($event)" [disabled]="!editable()">
              @for (lang of languages; track lang.id) {
                <option [value]="lang.id">{{ lang.label }}</option>
              }
            </select>
          </label>

          <textarea
            class="code"
            rows="16"
            spellcheck="false"
            [ngModel]="code()"
            (ngModelChange)="code.set($event)"
            [disabled]="!editable()"
            placeholder="Write your solution here…"
          ></textarea>

          <div class="actions">
            <button
              type="button"
              class="run"
              (click)="runTests()"
              [disabled]="!editable() || running()"
            >
              {{ running() ? 'Running…' : 'Run public tests' }}
            </button>
            @if (lastSummary(); as summary) {
              <p class="summary" [class.ok]="summary.allPassed" role="status">{{ summary.text }}</p>
            }
          </div>

          @if (error()) {
            <p class="err" role="alert">{{ error() }}</p>
          }

          @if (results().length > 0) {
            <ul class="results">
              @for (tr of results(); track $index) {
                <li [class.pass]="tr.passed" [class.fail]="!tr.passed">
                  <strong>{{ tr.passed ? 'PASS' : 'FAIL' }}</strong>
                  <span>input: {{ formatInput(tr.input) }}</span>
                  @if (!tr.passed) {
                    <pre>expected: {{ tr.expectedOutput || '(empty)' }}
actual: {{ tr.actualOutput || '(empty)' }}</pre>
                  }
                </li>
              }
            </ul>
          }
        </div>
      </div>
    </section>
  `,
  styles: `
    .coding-step {
      margin: 20px 0 0;
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: color-mix(in srgb, var(--card) 94%, var(--navy));
    }
    .coding-head h2 {
      margin: 0 0 4px;
      color: var(--navy);
      font-size: 1.05rem;
    }
    .hint,
    .muted {
      margin: 0;
      color: var(--muted);
      font-size: 0.82rem;
    }
    .coding-split {
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
      gap: 16px;
      margin-top: 14px;
    }
    @media (max-width: 900px) {
      .coding-split {
        grid-template-columns: 1fr;
      }
    }
    .prompt {
      margin: 0 0 12px;
      white-space: pre-wrap;
      color: var(--navy);
      line-height: 1.45;
      font-size: 0.92rem;
    }
    .spec h3 {
      margin: 0 0 8px;
      font-size: 0.85rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .sample {
      margin: 0 0 10px;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--card);
      border: 1px solid var(--border);
    }
    .sample span {
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
    }
    .sample pre,
    .results pre {
      margin: 4px 0 8px;
      white-space: pre-wrap;
      font-family: ui-monospace, 'Cascadia Code', monospace;
      font-size: 0.78rem;
    }
    .lang {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 10px;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--navy);
    }
    .lang select,
    .code {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      background: #0f172a;
      color: #e2e8f0;
      font-family: ui-monospace, 'Cascadia Code', monospace;
      font-size: 0.85rem;
    }
    .lang select {
      background: var(--card);
      color: var(--navy);
      max-width: 280px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin-top: 10px;
    }
    .run {
      border: 0;
      border-radius: 8px;
      padding: 10px 16px;
      background: var(--navy);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    .run:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .summary {
      margin: 0;
      font-size: 0.85rem;
      color: var(--muted);
    }
    .summary.ok {
      color: #0f766e;
      font-weight: 700;
    }
    .err {
      margin: 10px 0 0;
      color: #b91c1c;
      font-size: 0.88rem;
    }
    .results {
      list-style: none;
      margin: 12px 0 0;
      padding: 0;
      display: grid;
      gap: 8px;
    }
    .results li {
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      font-size: 0.82rem;
    }
    .results li.pass {
      background: color-mix(in srgb, #0f766e 10%, var(--card));
    }
    .results li.fail {
      background: color-mix(in srgb, #b91c1c 8%, var(--card));
    }
  `,
})
export class InterviewSessionCoding {
  private readonly catalog = inject(InterviewCatalogService);

  readonly sessionId = input.required<string>();
  readonly problem = input.required<InterviewCodingProblem>();
  readonly editable = input(true);
  readonly initialCode = input<string | null>(null);
  readonly initialLanguage = input<string | null>(null);
  readonly initialResults = input<InterviewCodingPublicTestResult[]>([]);
  readonly initialPassedCount = input<number | null>(null);
  readonly initialTotalCount = input<number | null>(null);

  readonly languages = INTERVIEW_CODING_LANGUAGES;
  readonly code = signal('');
  readonly language = signal(DEFAULT_INTERVIEW_CODING_LANGUAGE);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly results = signal<InterviewCodingPublicTestResult[]>([]);
  readonly lastSummary = signal<{ text: string; allPassed: boolean } | null>(null);

  private seededFor = '';

  constructor() {
    effect(() => {
      const problem = this.problem();
      const sessionId = this.sessionId();
      const key = `${sessionId}:${problem.title}:${problem.prompt}`;
      if (this.seededFor === key) return;
      this.seededFor = key;

      const savedCode = this.initialCode();
      const savedLanguage = this.initialLanguage();
      this.language.set(
        normalizeInterviewCodingLanguage(savedLanguage ?? problem.language)
      );
      this.code.set(savedCode && savedCode.length > 0 ? savedCode : problem.starterCode || '');
      const savedResults = this.initialResults();
      this.results.set(savedResults);
      const passed = this.initialPassedCount();
      const total = this.initialTotalCount();
      if (typeof passed === 'number' && typeof total === 'number') {
        this.lastSummary.set({
          text: `${passed}/${total} public tests passed`,
          allPassed: total > 0 && passed === total,
        });
      } else {
        this.lastSummary.set(null);
      }
      this.error.set(null);
    });
  }

  onLanguage(value: string): void {
    this.language.set(normalizeInterviewCodingLanguage(value));
  }

  formatInput(value: string): string {
    const trimmed = value.trim();
    return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed || '(empty)';
  }

  async runTests(): Promise<void> {
    if (!this.editable() || this.running()) return;
    const code = this.code();
    if (!code.trim()) {
      this.error.set('Write some code before running tests.');
      return;
    }

    this.running.set(true);
    this.error.set(null);
    try {
      const outcome = await this.catalog.runCodingPublicTests(
        this.sessionId(),
        code,
        this.language()
      );
      this.results.set(outcome.results);
      this.lastSummary.set({
        text: `${outcome.passedCount}/${outcome.total} public tests passed`,
        allPassed: outcome.allPassed,
      });
    } catch (err) {
      this.error.set(interviewErrorMessage(err, 'Could not run public tests.'));
    } finally {
      this.running.set(false);
    }
  }
}
