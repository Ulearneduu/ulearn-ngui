import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import type { InterviewEvaluationComparison, InterviewEvaluationSnapshot } from '../models';
import { InterviewRequestError } from './interview-api';
import { InterviewCatalogService, interviewErrorMessage } from './interview-catalog.service';
import {
  EVAL_POLL_MAX_MS,
  EVAL_POLL_MS,
  canReclaimEvaluation,
  canStartInterviewRedo,
  compareInterviewEvaluations,
  evaluationPhase,
  formatCompletedAt,
  formatScore,
  formatScoreDelta,
  interviewKindLabel,
  interviewRedoBlockedReason,
  isInterviewAccessError,
  scoreBarPercent,
  shouldPollEvaluation,
  shouldStartEvaluation,
  trendLabel,
  type ResultPhase,
} from './interview-evaluation';

@Component({
  selector: 'app-interview-result',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="result-page">
      @if (phase() === 'loading') {
        <p class="opening" role="status">Loading results…</p>
      } @else if (phase() === 'not_found') {
        <section class="panel" role="alert">
          <h1>This interview isn't available.</h1>
          <p>We couldn't open this session. It may have been removed, or the link may be incorrect.</p>
          <a class="primary" routerLink="/interview">Back to Interview Catalog</a>
        </section>
      } @else if (phase() === 'unauthorized') {
        <section class="panel" role="alert">
          <h1>You don't have access to this interview.</h1>
          <p>Interview access is not available for this account, or this session is not open to you.</p>
          <a class="primary" routerLink="/interview">Back to Interview Catalog</a>
        </section>
      } @else if (phase() === 'network' && !snapshot()) {
        <section class="panel" role="alert">
          <h1>Results could not be loaded.</h1>
          <p>The connection failed before the saved interview could be read. Your completed interview is not changed by this page.</p>
          <button type="button" class="primary" (click)="reload()">Try again</button>
        </section>
      } @else if (snapshot(); as data) {
        <div class="context">
          <a class="back" routerLink="/interview">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
            Interview Catalog
          </a>
          <a class="back" [routerLink]="['/interview/session', data.session.id]">Interview session</a>
        </div>
        <header class="title-row">
          <div>
            <p class="eyebrow">{{ kindLabel(data.session.templateKind) }} interview</p>
            <h1>{{ data.session.templateTitle }}</h1>
            <p class="meta">
              @if (completedLabel(data.session.endedAt); as ended) {
                Completed {{ ended }}
              } @else {
                Interview completed
              }
              · {{ data.session.durationMinutes }} min allotted
              @if (data.session.redoOfSessionId) {
                · Redo attempt
              }
            </p>
          </div>
          @if (data.session.status === 'completed') {
            <div class="redo-actions">
              <button
                type="button"
                class="primary"
                (click)="redo()"
                [disabled]="!canRedo() || redoWorking()"
              >
                {{ redoWorking() ? 'Starting redo…' : 'Redo Interview' }}
              </button>
              @if (redoBlocked(); as reason) {
                <p class="redo-hint" role="status">{{ reason }}</p>
              }
              @if (redoError(); as error) {
                <p class="redo-error" role="alert">{{ error }}</p>
              }
            </div>
          }
        </header>

        @if (comparison(); as compare) {
          <section class="block compare" aria-labelledby="compare-heading">
            <h2 id="compare-heading">Progress vs previous attempt</h2>
            <p class="compare-lead">
              Before is your previous linked attempt.
              After is this redo.
            </p>
            <div class="compare-overall" [attr.data-trend]="compare.overall.trend">
              <div>
                <p class="score-label">Before</p>
                <p class="compare-value">{{ scoreOrDash(compare.overall.before) }}</p>
              </div>
              <div>
                <p class="score-label">After</p>
                <p class="compare-value">{{ scoreOrDash(compare.overall.after) }}</p>
              </div>
              <div>
                <p class="score-label">Change</p>
                <p class="compare-value">{{ deltaText(compare.overall.delta) }}</p>
                <p class="trend">{{ trendText(compare.overall.trend) }}</p>
              </div>
            </div>
            @if (compare.competencies.length > 0) {
              <table class="compare-table">
                <thead>
                  <tr>
                    <th scope="col">Competency</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of compare.competencies; track row.competency) {
                    <tr [attr.data-trend]="row.trend">
                      <th scope="row">{{ row.competency }}</th>
                      <td>{{ scoreOrDash(row.before) }}</td>
                      <td>{{ scoreOrDash(row.after) }}</td>
                      <td>
                        <span>{{ deltaText(row.delta) }}</span>
                        <span class="trend">{{ trendText(row.trend) }}</span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>
        }

        @if (phase() === 'not_completed') {
          <section class="panel">
            <h2>This interview is still open.</h2>
            <p>Evaluation starts after the session is completed.</p>
            <a class="primary" [routerLink]="['/interview/session', data.session.id]">Return to interview</a>
          </section>
        } @else if (phase() === 'empty_transcript') {
          <section class="panel" role="status">
            <h2>No conversation to evaluate.</h2>
            <p>The session is completed, but it has no saved questions or answers, so a score was not created.</p>
          </section>
        } @else if (phase() === 'incomplete_transcript') {
          <section class="panel" role="status">
            <h2>The conversation is incomplete.</h2>
            <p>Evaluation needs at least one interviewer question and one saved answer. The transcript below is unchanged.</p>
          </section>
        } @else if (phase() === 'processing' || phase() === 'ready') {
          <section class="panel" role="status">
            <h2>Generating your results</h2>
            <p>Your interview is saved. The scorecard is being prepared and usually appears within about half a minute when the evaluator is available.</p>
          </section>
        } @else if (phase() === 'processing_timeout') {
          <section class="panel" role="status">
            <h2>Results are still being prepared.</h2>
            <p>The interview remains completed. This page is checking the saved result, and it will not start a second evaluation while the first one is still running.</p>
            <button type="button" class="primary" (click)="checkAgain()">Check again</button>
            @if (reclaim()) {
              <button type="button" class="secondary" (click)="retry()" [disabled]="working()">Try evaluation again</button>
            }
          </section>
        } @else if (phase() === 'failed' || phase() === 'network') {
          <section class="panel" role="alert">
            <h2>The score is currently unavailable.</h2>
            <p>Your completed interview and transcript are still here. You can request evaluation again.</p>
            <button type="button" class="primary" (click)="retry()" [disabled]="working()">
              {{ working() ? 'Trying again…' : 'Retry evaluation' }}
            </button>
          </section>
        } @else {
          <section class="score-card" aria-labelledby="overall-heading">
            <div class="score-figure">
              <p id="overall-heading" class="score-label">Overall score</p>
              @if (data.overallScore !== null) {
                <p class="score-value">{{ scoreText(data.overallScore) }}<span>/100</span></p>
              } @else {
                <p class="score-value">—</p>
              }
              @if (data.mentorAdjusted) {
                <p class="mentor-adjusted" role="status">Mentor-adjusted score</p>
                @if (data.aiOverallScore !== null && data.aiOverallScore !== data.overallScore) {
                  <p class="ai-baseline">AI score {{ scoreText(data.aiOverallScore) }}/100</p>
                }
              }
            </div>
            <div>
              <h2>Overall performance</h2>
              @if (data.summary) {
                <p class="summary">{{ data.summary }}</p>
              }
              @if (data.evalVersion) {
                <p class="version">Evaluation {{ data.evalVersion }}</p>
              }
            </div>
          </section>

          @if (data.competencies.length > 0) {
            <section class="block" aria-labelledby="scorecard-heading">
              <h2 id="scorecard-heading">Competency scorecard</h2>
              <ul class="scores">
                @for (item of data.competencies; track item.id) {
                  <li>
                    <div class="score-head">
                      <h3>{{ item.competency }}</h3>
                      <p>{{ scoreText(item.score) }}/100</p>
                    </div>
                    @if (item.mentorAdjusted) {
                      <p class="mentor-adjusted" role="status">
                        Mentor-adjusted (AI {{ scoreText(item.aiScore) }})
                      </p>
                    }
                    @if (isCodingCompetency(item.competency)) {
                      <p class="coding-outcome" [class.ok]="item.score >= 100" role="status">
                        {{ codingOutcomeLabel(item.score) }}
                      </p>
                    }
                    <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="bar(item.score)" [attr.aria-label]="item.competency">
                      <span [style.width.%]="bar(item.score)"></span>
                    </div>
                    <p class="feedback">{{ item.feedback }}</p>
                    @if (item.evidence) {
                      <p class="evidence">{{ item.evidence }}</p>
                    }
                  </li>
                }
              </ul>
            </section>
          }

          @if (data.strengths.length > 0) {
            <section class="block">
              <h2>Strengths</h2>
              <ul class="notes">
                @for (item of data.strengths; track item) {
                  <li>{{ item }}</li>
                }
              </ul>
            </section>
          }

          @if (data.improvements.length > 0) {
            <section class="block">
              <h2>Areas for improvement</h2>
              <ul class="notes">
                @for (item of data.improvements; track item) {
                  <li>{{ item }}</li>
                }
              </ul>
            </section>
          }

          @if (data.tips.length > 0) {
            <section class="block next-steps" aria-labelledby="next-steps-heading">
              <h2 id="next-steps-heading">Your Next Steps</h2>
              <p class="next-subtitle">Personalized recommendations based on your interview performance.</p>
              <ol class="tips">
                @for (tip of data.tips; track tip; let index = $index) {
                  <li>
                    <span class="tip-index">{{ index + 1 }}</span>
                    <p>{{ tip }}</p>
                  </li>
                }
              </ol>
            </section>
          }
        }

        <section class="block transcript" aria-labelledby="transcript-heading">
          <h2 id="transcript-heading">Full interview transcript</h2>
          @if (data.turns.length === 0) {
            <p class="empty">No saved messages.</p>
          } @else {
            <ol>
              @for (turn of data.turns; track turn.id) {
                <li [class.student]="turn.role === 'user'">
                  <p class="who">{{ turn.role === 'assistant' ? 'Interviewer' : 'You' }}</p>
                  <p class="content">{{ turn.content }}</p>
                </li>
              }
            </ol>
          }
        </section>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .result-page {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 0 64px;
      color: var(--text);
      font-family: 'Nunito', sans-serif;
    }
    h1, h2, h3 { margin: 0; color: var(--navy); font-family: 'Poppins', sans-serif; font-weight: 700; }
    h1 { font-size: 32px; }
    h2 { font-size: 22px; }
    h3 { font-size: 16px; }
    p { margin: 0; }
    .opening { margin: 48px 0; color: #626277; font-weight: 700; }
    .context, .title-row, .score-card, .score-head { display: flex; justify-content: space-between; gap: 16px; }
    .context { margin-bottom: 20px; }
    .back {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--purple);
      font-weight: 800;
      text-decoration: none;
    }
    .back svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .title-row { align-items: flex-end; margin-bottom: 20px; }
    .eyebrow, .meta, .version, .evidence, .empty { color: #626277; }
    .eyebrow { margin-bottom: 6px; font-size: 13px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; }
    .meta, .version, .evidence { margin-top: 8px; font-weight: 700; }
    .panel, .score-card, .block {
      margin-bottom: 16px;
      padding: 24px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: #fff;
    }
    .panel p, .summary, .feedback { margin-top: 10px; line-height: 1.6; font-weight: 650; }
    .score-card { align-items: center; }
    .redo-actions {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      min-width: 200px;
    }
    .redo-hint, .redo-error {
      margin: 0;
      max-width: 260px;
      text-align: right;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.4;
    }
    .redo-hint { color: #626277; }
    .redo-error { color: #991b1b; }
    .compare-lead { margin-top: 8px; color: #626277; font-weight: 700; }
    .compare-overall {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      margin-top: 18px;
      padding: 16px;
      border-radius: 14px;
      background: #f7f8fc;
    }
    .compare-value { margin-top: 6px; color: var(--navy); font-family: 'Poppins', sans-serif; font-size: 28px; font-weight: 700; }
    .compare-table { width: 100%; margin-top: 18px; border-collapse: collapse; }
    .compare-table th, .compare-table td {
      padding: 12px 10px;
      border-top: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
      font-weight: 700;
    }
    .compare-table thead th { border-top: 0; color: #626277; font-size: 13px; text-transform: uppercase; letter-spacing: 0.03em; }
    .compare-table [data-trend='improved'] .trend, .compare-overall[data-trend='improved'] .trend { color: #166534; }
    .compare-table [data-trend='regressed'] .trend, .compare-overall[data-trend='regressed'] .trend { color: #991b1b; }
    .trend { display: block; margin-top: 4px; font-size: 12px; font-weight: 800; letter-spacing: 0.02em; text-transform: uppercase; }
    .score-figure {
      min-width: 180px;
      padding: 8px 8px 8px 0;
    }
    .score-label { color: #626277; font-size: 13px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; }
    .score-value { color: var(--navy); font-family: 'Poppins', sans-serif; font-size: 56px; font-weight: 700; line-height: 1; }
    .score-value span { margin-left: 4px; color: #626277; font-size: 18px; }
    .scores, .notes, .transcript ol { margin: 16px 0 0; padding: 0; list-style: none; }
    .scores li + li, .transcript li + li { margin-top: 18px; }
    .score-head { align-items: baseline; }
    .score-head p { color: var(--navy); font-weight: 800; }
    .track { height: 8px; margin-top: 8px; border-radius: 99px; background: #eceaf3; overflow: hidden; }
    .track span { display: block; height: 100%; border-radius: inherit; background: #65469b; }
    .coding-outcome {
      margin-top: 6px;
      color: #991b1b;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .coding-outcome.ok { color: #166534; }
    .mentor-adjusted {
      margin-top: 8px;
      color: #65469b;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .ai-baseline {
      margin-top: 4px;
      color: #626277;
      font-size: 13px;
      font-weight: 700;
    }
    .feedback { color: var(--text); }
    .evidence { font-size: 14px; }
    .notes { list-style: disc; padding-left: 20px; }
    .notes li { margin-top: 8px; line-height: 1.5; font-weight: 700; }
    .next-steps { background: #f8f6fc; border-color: #d9d0ea; }
    .next-subtitle { margin-top: 8px; color: #626277; font-weight: 700; line-height: 1.5; }
    .tips {
      display: grid;
      gap: 12px;
      margin: 16px 0 0;
      padding: 0;
      list-style: none;
    }
    .tips li {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: #fff;
    }
    .tips p { line-height: 1.5; font-weight: 700; }
    .tip-index {
      display: grid;
      place-items: center;
      flex: 0 0 28px;
      width: 28px;
      height: 28px;
      border-radius: 99px;
      background: #65469b;
      color: #fff;
      font-size: 13px;
      font-weight: 800;
    }
    .transcript li { padding: 14px 16px; border-radius: 16px; background: #f7f8fc; }
    .transcript li.student { background: #f3eff9; }
    .who { margin-bottom: 6px; color: var(--purple); font-size: 13px; font-weight: 800; }
    .content { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; font-weight: 650; }
    .primary, .secondary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 48px;
      margin-top: 16px;
      margin-right: 8px;
      padding: 0 18px;
      border: 2px solid #65469b;
      border-radius: 12px;
      font: inherit;
      font-weight: 800;
      text-decoration: none;
      cursor: pointer;
    }
    .primary { background: #65469b; color: #fff; }
    .secondary { background: #fff; color: #65469b; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    a:focus-visible, button:focus-visible { outline: 2px solid var(--purple); outline-offset: 2px; }
    @media (max-width: 1024px) {
      .result-page { padding: 28px 8px 56px; }
      .score-value { font-size: 48px; }
    }
    @media (max-width: 720px) {
      .result-page { padding: 20px 0 48px; }
      .context, .title-row, .score-card, .redo-actions, .compare-overall { align-items: stretch; flex-direction: column; }
      .compare-overall { display: flex; }
      .redo-actions { align-items: stretch; min-width: 0; }
      .redo-hint, .redo-error { text-align: left; max-width: none; }
      h1 { font-size: 26px; }
      .score-figure { min-width: 0; }
      .primary, .secondary { width: 100%; margin-right: 0; }
      .tips li { padding: 12px; }
    }
  `,
})
export class InterviewResult {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly catalog = inject(InterviewCatalogService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly sessionId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' }
  );

  readonly phase = signal<ResultPhase | 'loading' | 'not_found' | 'unauthorized' | 'network'>('loading');
  readonly snapshot = signal<InterviewEvaluationSnapshot | null>(null);
  readonly parentSnapshot = signal<InterviewEvaluationSnapshot | null>(null);
  readonly working = signal(false);
  readonly redoWorking = signal(false);
  readonly redoError = signal<string | null>(null);
  private readonly nowMs = signal(Date.now());

  readonly reclaim = computed(() => {
    const current = this.snapshot();
    if (!current) return false;
    return canReclaimEvaluation(current.evaluationStatus, current.claimedAt, this.nowMs());
  });

  readonly canRedo = computed(() => {
    const current = this.snapshot();
    if (!current) return false;
    return canStartInterviewRedo(current.session.status, current.evaluationStatus);
  });

  readonly redoBlocked = computed(() => {
    const current = this.snapshot();
    if (!current || current.session.status !== 'completed') return null;
    return interviewRedoBlockedReason(current.session.status, current.evaluationStatus);
  });

  readonly comparison = computed((): InterviewEvaluationComparison | null => {
    const current = this.snapshot();
    if (!current?.session.redoOfSessionId) return null;
    return compareInterviewEvaluations(this.parentSnapshot(), current);
  });

  private generation = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollStarted = 0;
  private startedFor = '';

  constructor() {
    this.destroyRef.onDestroy(() => this.clearPoll());
    effect(() => {
      const id = this.sessionId();
      void this.open(id);
    });
  }

  scoreText(score: number): string {
    return formatScore(score);
  }

  isCodingCompetency(name: string): boolean {
    return name.trim().toLowerCase() === 'coding';
  }

  codingOutcomeLabel(score: number): string {
    if (score >= 100) return 'Public tests: passed';
    return 'Public tests: not fully passed';
  }

  bar(score: number): number {
    return scoreBarPercent(score);
  }

  kindLabel(kind: string): string {
    return interviewKindLabel(kind);
  }

  completedLabel(value: string | null): string | null {
    return formatCompletedAt(value);
  }

  reload(): void {
    const id = this.sessionId();
    if (id) void this.open(id);
  }

  async checkAgain(): Promise<void> {
    const id = this.snapshot()?.session.id;
    if (!id || this.working()) return;
    this.nowMs.set(Date.now());
    await this.refresh(id, false);
    if (this.phase() === 'processing') this.beginPoll(id);
  }

  async retry(): Promise<void> {
    const id = this.snapshot()?.session.id;
    if (!id || this.working()) return;
    this.startedFor = '';
    await this.beginEvaluation(id, true);
  }

  scoreOrDash(score: number | null): string {
    return score === null ? '—' : this.scoreText(score);
  }

  deltaText(delta: number | null): string {
    return formatScoreDelta(delta);
  }

  trendText(trend: InterviewEvaluationComparison['overall']['trend']): string {
    return trendLabel(trend);
  }

  async redo(): Promise<void> {
    const current = this.snapshot();
    if (!current || !this.canRedo() || this.redoWorking()) return;
    this.redoWorking.set(true);
    this.redoError.set(null);
    try {
      const newSessionId = await this.catalog.startRedoSession(current.session.id);
      const opened = await this.router.navigate(['/interview/session', newSessionId]);
      if (!opened) {
        this.redoError.set('The redo started, but the session page could not be opened.');
      }
    } catch (error: unknown) {
      this.redoError.set(interviewErrorMessage(error, 'Could not start a redo of this interview.'));
    } finally {
      this.redoWorking.set(false);
    }
  }

  private async open(sessionId: string): Promise<void> {
    const generation = ++this.generation;
    this.clearPoll();
    this.startedFor = '';
    this.snapshot.set(null);
    this.parentSnapshot.set(null);
    this.redoError.set(null);
    this.phase.set('loading');
    if (!sessionId) {
      this.phase.set('not_found');
      return;
    }
    try {
      const snapshot = await this.catalog.getOwnEvaluation(sessionId);
      if (generation !== this.generation) return;
      if (!snapshot) {
        this.phase.set('not_found');
        return;
      }
      this.applySnapshot(snapshot, false);
      await this.loadParentComparison(snapshot, generation);
      if (shouldStartEvaluation(this.viewPhase(snapshot, false), false)) {
        await this.beginEvaluation(sessionId, false);
      } else if (shouldPollEvaluation(this.viewPhase(snapshot, false))) {
        this.beginPoll(sessionId);
      }
    } catch (error: unknown) {
      if (generation !== this.generation) return;
      this.phase.set(isInterviewAccessError(error) ? 'unauthorized' : 'network');
    }
  }

  private async loadParentComparison(
    snapshot: InterviewEvaluationSnapshot,
    generation: number
  ): Promise<void> {
    const parentId = snapshot.session.redoOfSessionId;
    if (!parentId) {
      this.parentSnapshot.set(null);
      return;
    }
    try {
      const parent = await this.catalog.getOwnEvaluation(parentId);
      if (generation !== this.generation) return;
      this.parentSnapshot.set(parent);
    } catch {
      if (generation !== this.generation) return;
      this.parentSnapshot.set(null);
    }
  }

  private async beginEvaluation(sessionId: string, userRetry: boolean): Promise<void> {
    if (this.startedFor === sessionId && !userRetry) return;
    this.startedFor = sessionId;
    this.working.set(true);
    this.phase.set('processing');
    try {
      await this.catalog.requestEvaluation(sessionId);
      await this.refresh(sessionId, false);
    } catch (error: unknown) {
      if (error instanceof InterviewRequestError && error.code === 'EVALUATION_IN_PROGRESS') {
        this.phase.set('processing');
        this.beginPoll(sessionId);
        return;
      }
      if (error instanceof InterviewRequestError && error.code === 'EMPTY_TRANSCRIPT') {
        this.phase.set('empty_transcript');
        return;
      }
      if (error instanceof InterviewRequestError && error.code === 'INCOMPLETE_TRANSCRIPT') {
        this.phase.set('incomplete_transcript');
        return;
      }
      if (error instanceof InterviewRequestError && error.code === 'SESSION_NOT_COMPLETED') {
        this.phase.set('not_completed');
        return;
      }
      if (isInterviewAccessError(error)) {
        this.phase.set('unauthorized');
        return;
      }
      await this.refresh(sessionId, false);
      if (this.phase() === 'ready' || this.phase() === 'processing') this.phase.set('failed');
    } finally {
      this.working.set(false);
    }
  }

  private beginPoll(sessionId: string): void {
    this.clearPoll();
    this.pollStarted = Date.now();
    this.phase.set('processing');
    const tick = (): void => {
      this.pollTimer = setTimeout(() => {
        void this.pollOnce(sessionId);
      }, EVAL_POLL_MS);
    };
    tick();
  }

  private async pollOnce(sessionId: string): Promise<void> {
    if (this.snapshot()?.session.id !== sessionId) return;
    const timedOut = Date.now() - this.pollStarted >= EVAL_POLL_MAX_MS;
    await this.refresh(sessionId, timedOut);
    if (!timedOut && this.phase() === 'processing') {
      this.pollTimer = setTimeout(() => {
        void this.pollOnce(sessionId);
      }, EVAL_POLL_MS);
    }
  }

  private async refresh(sessionId: string, pollTimedOut: boolean): Promise<void> {
    try {
      const snapshot = await this.catalog.getOwnEvaluation(sessionId);
      if (this.snapshot()?.session.id !== sessionId && this.sessionId() !== sessionId) return;
      if (!snapshot) {
        this.phase.set('not_found');
        return;
      }
      this.applySnapshot(snapshot, pollTimedOut);
    } catch (error: unknown) {
      if (!this.snapshot()) this.phase.set(isInterviewAccessError(error) ? 'unauthorized' : 'network');
      else if (pollTimedOut) this.phase.set('network');
    }
  }

  private applySnapshot(snapshot: InterviewEvaluationSnapshot, pollTimedOut: boolean): void {
    this.snapshot.set(snapshot);
    this.phase.set(this.viewPhase(snapshot, pollTimedOut));
  }

  private viewPhase(snapshot: InterviewEvaluationSnapshot, pollTimedOut: boolean): ResultPhase {
    const userTurns = snapshot.turns.filter((turn) => turn.role === 'user').length;
    const assistantTurns = snapshot.turns.filter((turn) => turn.role === 'assistant').length;
    return evaluationPhase({
      sessionStatus: snapshot.session.status,
      evaluationStatus: snapshot.evaluationStatus,
      overallScore: snapshot.overallScore,
      competencyCount: snapshot.competencies.length,
      userTurns,
      assistantTurns,
      pollTimedOut,
    });
  }

  private clearPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}
