import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import type { InterviewEvaluationSnapshot } from '../models';
import { InterviewRequestError } from './interview-api';
import { InterviewCatalogService } from './interview-catalog.service';
import {
  EVAL_POLL_MAX_MS,
  EVAL_POLL_MS,
  canReclaimEvaluation,
  evaluationPhase,
  formatCompletedAt,
  formatScore,
  interviewKindLabel,
  isInterviewAccessError,
  scoreBarPercent,
  shouldPollEvaluation,
  shouldStartEvaluation,
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
            </p>
          </div>
        </header>

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
    .feedback { color: var(--text); }
    .evidence { font-size: 14px; }
    .notes { list-style: disc; padding-left: 20px; }
    .notes li { margin-top: 8px; line-height: 1.5; font-weight: 700; }
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
      .context, .title-row, .score-card { align-items: stretch; flex-direction: column; }
      h1 { font-size: 26px; }
      .score-figure { min-width: 0; }
      .primary, .secondary { width: 100%; margin-right: 0; }
    }
  `,
})
export class InterviewResult {
  private readonly route = inject(ActivatedRoute);
  private readonly catalog = inject(InterviewCatalogService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly sessionId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' }
  );

  readonly phase = signal<ResultPhase | 'loading' | 'not_found' | 'unauthorized' | 'network'>('loading');
  readonly snapshot = signal<InterviewEvaluationSnapshot | null>(null);
  readonly working = signal(false);
  private readonly nowMs = signal(Date.now());

  readonly reclaim = computed(() => {
    const current = this.snapshot();
    if (!current) return false;
    return canReclaimEvaluation(current.evaluationStatus, current.claimedAt, this.nowMs());
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

  private async open(sessionId: string): Promise<void> {
    const generation = ++this.generation;
    this.clearPoll();
    this.startedFor = '';
    this.snapshot.set(null);
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
