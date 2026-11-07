import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { InterviewTurn } from '../models';
import { InterviewRequestError } from './interview-api';
import {
  InterviewCodingPublicTestResult,
  InterviewCodingProblem,
} from './interview-coding';
import {
  InterviewCatalogService,
  InterviewSessionDetails,
  interviewErrorMessage,
} from './interview-catalog.service';
import { InterviewSessionCoding } from './interview-session-coding';
import {
  INTERVIEW_LOW_TIME_MS,
  formatInterviewClock,
  formatInterviewSpent,
  interviewEndedBecauseTime,
  interviewRemainingMs,
  shouldAutoFinishSession,
} from './interview-timer';
import {
  InterviewInputMode,
  InterviewVoiceController,
  QuestionSpeaker,
  VOICE_UNAVAILABLE_MESSAGE,
  browserSpeechHost,
  createQuestionSpeaker,
  recognitionMayStart,
  recognizedAnswerText,
} from './interview-voice';

type SubmitNotice = 'retry' | 'ai' | 'connection';

const AI_FAILURE_CODES = new Set([
  'AI_NOT_CONFIGURED',
  'INTERVIEW_AI_TIMEOUT',
  'INTERVIEW_AI_UNAVAILABLE',
  'INTERVIEW_AI_RATE_LIMIT',
]);

@Component({
  selector: 'app-interview-session',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, InterviewSessionCoding],
  template: `
    <div class="session-page">
      @if (loading() && !session()) {
        <p class="opening" role="status">Opening interview…</p>
      } @else if (error() && !session()) {
        <a class="back" routerLink="/interview">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
          Interview Catalog
        </a>
        <section class="outcome" role="alert">
          <div class="symbol">
            @if (accessDenied()) {
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>
            } @else {
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9.5 13.5h.01M12 17h.01"/></svg>
            }
          </div>
          <h1>{{ accessDenied() ? "You don't have access to this interview." : "This interview isn't available." }}</h1>
          <p class="lead">{{ accessDenied() ? "This session isn't available for your account. Return to the catalog to choose an interview you can access." : "We couldn't open this session. Try loading it again, or choose another interview from the catalog." }}</p>
          @if (accessDenied()) {
            <a class="primary wide" routerLink="/interview">Back to Interview Catalog</a>
          } @else {
            <button type="button" class="primary wide" (click)="retryLoad()">Retry loading</button>
            <a class="secondary wide" routerLink="/interview">Back to Interview Catalog</a>
          }
        </section>
      } @else if (session(); as current) {
        <div class="context">
          <a class="back" routerLink="/interview">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
            Interview Catalog
          </a>
          <div class="mode-group">
            <p class="mode">{{ current.status === 'in_progress' && inputMode() === 'voice' ? 'Voice interview' : 'Text interview' }}</p>
            @if (current.status === 'in_progress') {
              <div class="mode-switch" role="group" aria-label="Answer input mode">
                <button type="button" [attr.aria-pressed]="inputMode() === 'text'" (click)="setInputMode('text')">Text</button>
                <button type="button" [attr.aria-pressed]="inputMode() === 'voice'" (click)="setInputMode('voice')">Voice</button>
              </div>
            }
          </div>
        </div>

        @if (current.status === 'completed' || current.status === 'failed') {
          <section class="outcome" role="status">
            <div class="symbol" [class.done]="current.status === 'completed'" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
            </div>
            <h1>{{ current.status === 'completed' ? 'Interview completed' : 'This interview could not be finished.' }}</h1>
            <p class="lead">
              @if (current.status === 'failed') {
                The interview ended before it could be completed.
              } @else if (endedByTime()) {
                Your interview time has ended. Your session is complete. Well done for taking the time to practise.
              } @else {
                Well done for taking the time to practise. Every conversation is a step toward your next opportunity.
              }
            </p>
            <div class="details">
              <p class="eyebrow">AI Mock Interview</p>
              <p class="detail-title">{{ current.templateTitle }}</p>
              <p class="confirmed">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>
                @if (current.status === 'failed') {
                  Could not be finished
                } @else if (endedByTime()) {
                  Completed · Time ended
                } @else {
                  Completed
                }
              </p>
              @if (timeSpentLabel(); as spent) {
                <p>{{ endedByTime() ? 'Time remaining 00:00' : 'Time spent ' + spent }}</p>
              }
            </div>
            @if (current.status === 'failed' && submitError()) {
              <p class="alert error" role="alert">{{ submitError() }}</p>
            }
            @if (current.status === 'failed') {
              <div class="surface transcript-saved">
                <div class="conversation" role="log" aria-label="Saved interview transcript">
                  @if (turns().length === 0) {
                    <p class="empty">No messages were saved before the interview stopped.</p>
                  }
                  @for (turn of turns(); track turn.id) {
                    @if (turn.role === 'assistant') {
                      <article class="turn interviewer">
                        <span class="mark" aria-hidden="true">
                          <svg viewBox="0 0 24 24"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/></svg>
                        </span>
                        <div>
                          <p class="who">AI interviewer</p>
                          <p class="content">{{ turn.content }}</p>
                        </div>
                      </article>
                    } @else {
                      <article class="turn student">
                        <span class="avatar" aria-hidden="true">
                          <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3"/><path d="M6 19c1.5-3 3.5-4 6-4s4.5 1 6 4"/></svg>
                        </span>
                        <div>
                          <p class="who">You · Saved</p>
                          <p class="content">{{ turn.content }}</p>
                        </div>
                      </article>
                    }
                  }
                </div>
              </div>
            }
            @if (current.status === 'completed') {
              <a class="primary wide" [routerLink]="['/interview/session', current.id, 'result']">View results</a>
              <a class="secondary wide" routerLink="/interview">Back to Interview Catalog</a>
            } @else {
              <a class="primary wide" routerLink="/interview">Back to Interview Catalog</a>
            }
            @if (draft()) {
              <label class="field-label" for="unsent-answer">Unsent answer</label>
              <textarea id="unsent-answer" [value]="draft()" readonly rows="4"></textarea>
            }
          </section>
        } @else {
          <div class="identity">
            <p>
              <span>AI Mock Interview</span>
              <span class="dot" [class.warn]="lowTime() || timeUp()" [class.busy]="reconnecting()"></span>
              <span>{{ statusText() }}</span>
            </p>
          </div>
          <div class="title-row">
            <h1>{{ current.templateTitle }}</h1>
            <div class="controls">
              <p class="timer" [class.low]="lowTime()" [class.ended]="timeUp()">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/></svg>
                <strong>{{ timerLabel() }}</strong>
                <span>{{ timeUp() ? 'time ended' : 'remaining' }}</span>
              </p>
              <button type="button" class="end" (click)="confirmEnd()" [disabled]="!canEnd()">
                {{ timeUp() ? 'Time ended' : ending() ? 'Ending…' : 'End Interview' }}
              </button>
            </div>
          </div>

          @if (codingProblem(); as coding) {
            <app-interview-session-coding
              [sessionId]="current.id"
              [problem]="coding"
              [editable]="canUseCoding()"
              [initialCode]="savedCodingCode()"
              [initialLanguage]="savedCodingLanguage()"
              [initialResults]="savedCodingResults()"
              [initialPassedCount]="savedCodingPassed()"
              [initialTotalCount]="savedCodingTotal()"
            />
          }

          <section class="surface">
            <div #transcript class="conversation" role="log" aria-relevant="additions" aria-label="Interview conversation">
              @if (lowTime()) {
                <p class="alert warn" role="status">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>
                  Less than 2 minutes left. Finish your current answer.
                </p>
              }
              @if (turns().length === 0 && !sending()) {
                <p class="empty">No questions yet. Send an answer, or ask for the first question.</p>
                <button type="button" class="quiet" (click)="askFirstQuestion()" [disabled]="!canAskFirst()">
                  Ask the first question
                </button>
              }
              @for (turn of turns(); track turn.id) {
                @if (turn.role === 'assistant') {
                  <article class="turn interviewer">
                    <span class="mark" aria-hidden="true">
                      <svg viewBox="0 0 24 24"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/></svg>
                    </span>
                    <div>
                      <p class="who">AI interviewer</p>
                      <p class="content">{{ turn.content }}</p>
                    </div>
                  </article>
                } @else {
                  <article class="turn student">
                    <span class="avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3"/><path d="M6 19c1.5-3 3.5-4 6-4s4.5 1 6 4"/></svg>
                    </span>
                    <div>
                      <p class="who">You · Saved</p>
                      <p class="content">{{ turn.content }}</p>
                    </div>
                  </article>
                }
              }
              @if (sending() && !answerAlreadyStored() && inflightAnswer(); as pending) {
                <article class="turn student pending">
                  <span class="avatar" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3"/><path d="M6 19c1.5-3 3.5-4 6-4s4.5 1 6 4"/></svg>
                  </span>
                  <div>
                    <p class="who">You · Sending…</p>
                    <p class="content">{{ pending }}</p>
                  </div>
                </article>
                <p class="progress" role="status">Submitting answer…</p>
              }
              @if (sending() && answerAlreadyStored()) {
                <p class="progress" role="status">AI interviewer is thinking…</p>
              }
              @if (!sending() && draft().trim() && (submitNotice() === 'retry' || submitNotice() === 'ai' || submitNotice() === 'connection')) {
                <article class="turn student">
                  <span class="avatar" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3"/><path d="M6 19c1.5-3 3.5-4 6-4s4.5 1 6 4"/></svg>
                  </span>
                  <div>
                    <p class="who bad">You · {{ submitNotice() === 'connection' ? 'Not confirmed' : 'Not sent' }}</p>
                    <p class="content">{{ draft() }}</p>
                  </div>
                </article>
              }
              @if (reconnecting()) {
                <p class="alert error" role="status">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
                  <span>
                    Reconnecting to this interview. Checking saved messages before you send again. Your draft stays here.
                    <button type="button" class="quiet" disabled>Reconnecting…</button>
                  </span>
                </p>
              } @else if (submitNotice() === 'connection') {
                <p class="alert error" role="alert">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
                  <span>
                    {{ submitError() }}
                    <button type="button" class="quiet" (click)="reconnect()">Reconnect</button>
                  </span>
                </p>
              } @else if (submitNotice() === 'ai' || submitNotice() === 'retry') {
                <p class="alert error" role="alert">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
                  <span>{{ submitError() }}</span>
                </p>
              } @else if (submitError()) {
                <p class="alert error" role="alert">{{ submitError() }}</p>
              }
              @if (expiring()) {
                <p class="progress" role="status">Completing your session…</p>
              }
            </div>

            <form class="composer" (submit)="onSubmit($event)">
              @if (timeUp()) {
                <div class="composer-head">
                  <p class="field-label">Interview time has ended</p>
                  <p class="hint">This session will complete automatically.</p>
                </div>
                <p class="locked">No further answers can be submitted.</p>
                <div class="composer-actions">
                  <p class="hint">
                    @if (expiring()) {
                      Time is up. Completing your interview automatically.
                    } @else if (expireError()) {
                      {{ expireError() }}
                    } @else {
                      Time is up.
                    }
                  </p>
                  @if (expireError()) {
                    <button type="button" class="primary" (click)="retryTimeUp()" [disabled]="expiring()">Try again</button>
                  } @else {
                    <button type="button" class="primary" disabled>Time ended</button>
                  }
                </div>
              } @else if (remainingMs() === null) {
                <p class="alert error" role="alert">This interview timer could not be read. Refresh the page before answering.</p>
              } @else {
                <div class="composer-head">
                  <label class="field-label" for="interview-answer">
                    {{ sending() ? (answerAlreadyStored() ? 'Your answer' : 'Your answer · Submitting') : 'Your answer' }}
                  </label>
                  <p class="hint">
                    @if (sending() && answerAlreadyStored()) {
                      Answer saved. Waiting for the next question.
                    } @else if (sending()) {
                      Please wait while your answer is submitted.
                    } @else if (reconnecting()) {
                      Checking this session before enabling submission. Your draft stays here.
                    } @else if (restored()) {
                      Continue where you left off.
                    } @else if (submitNotice() === 'retry' || submitNotice() === 'ai') {
                    } @else if (inputMode() === 'voice' && recording()) {
                      Listening. Recognized phrases are added to the answer box. Send when you are ready.
                    } @else if (inputMode() === 'voice') {
                      Review the recognized answer, edit it if needed, then send.
                    } @else {
                      Be specific. A real example works best.
                    }
                  </p>
                </div>
                @if (inputMode() === 'voice') {
                  <div class="voice-panel">
                    @if (!speechSupported()) {
                      <p class="voice-note" role="status">{{ voiceUnavailableMessage }}</p>
                    } @else {
                      <div class="voice-controls">
                        <button
                          type="button"
                          class="mic"
                          [class.live]="recording()"
                          (click)="toggleRecording()"
                          [attr.aria-pressed]="recording()"
                          [disabled]="sending() || reconnecting() || ending()"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3"/></svg>
                          {{ recording() ? 'Stop recording' : 'Start recording' }}
                        </button>
                        <p class="rec-status" [class.live]="recording()" role="status" aria-live="polite">
                          <span class="rec-dot" aria-hidden="true"></span>
                          {{ recording() ? 'Recording' : 'Microphone idle' }}
                        </p>
                      </div>
                      @if (interimTranscript()) {
                        <p class="interim" role="status">Hearing: {{ interimTranscript() }}</p>
                      }
                      @if (voiceNotice()) {
                        <p class="voice-note" role="status">{{ voiceNotice() }}</p>
                      }
                    }
                    @if (ttsSupported()) {
                      <button
                        type="button"
                        class="quiet"
                        (click)="toggleQuestionSpeech()"
                        [disabled]="!latestAssistant()"
                        [attr.aria-pressed]="speakingQuestion()"
                      >
                        {{ speakingQuestion() ? 'Stop reading' : 'Read question aloud' }}
                      </button>
                    }
                  </div>
                }
                <textarea
                  id="interview-answer"
                  rows="4"
                  maxlength="8000"
                  [value]="draft()"
                  (input)="onDraft($event)"
                  (keydown)="onAnswerKeydown($event)"
                  [readOnly]="sending()"
                  [disabled]="reconnecting()"
                  [attr.aria-invalid]="submitNotice() === 'retry' || submitNotice() === 'ai' ? true : null"
                  [placeholder]="sending() && answerAlreadyStored() ? 'Waiting for the AI interviewer…' : inputMode() === 'voice' ? 'Your spoken answer appears here. You can edit it before sending.' : 'Type your answer here. Share the situation, your actions, and what you learned.'"
                ></textarea>
                <div class="composer-actions" [class.stack]="submitNotice() === 'retry' || submitNotice() === 'ai'">
                  @if (submitNotice() !== 'retry' && submitNotice() !== 'ai') {
                    <p class="hint">
                      @if (sending() && answerAlreadyStored()) {
                        Please wait for the next question.
                      } @else if (sending()) {
                        Not saved yet. Please wait.
                      } @else if (reconnecting()) {
                        Checking this session before enabling submission. Your draft stays here.
                      } @else if (submitNotice() === 'connection') {
                        Reconnect above before sending again. Your draft stays here.
                      } @else {
                        Enter to send · Shift+Enter for a new line
                      }
                    </p>
                  }
                  <button type="submit" class="primary" [disabled]="!canSend() && draft().trim().length > 0">
                    {{ sending() && answerAlreadyStored() ? 'Send Answer' : sending() ? 'Sending…' : submitNotice() === 'retry' || submitNotice() === 'ai' ? 'Retry send' : 'Send Answer' }}
                  </button>
                </div>
              }
            </form>
          </section>
        }

        @if (confirmOpen()) {
          <div class="overlay" role="presentation">
            <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="end-title">
              <span class="symbol" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M5 21V4h9l1 3h5v10h-6l-1-3H7v7"/></svg>
              </span>
              <h2 id="end-title">End this interview?</h2>
              <p>Ending will complete your current session and open your results. You won't be able to send any more answers in this interview.</p>
              <button type="button" class="primary wide" (click)="confirmEndNow()" [disabled]="ending()">
                {{ ending() ? 'Ending…' : 'End Interview' }}
              </button>
              <button type="button" class="secondary wide" (click)="cancelEnd()" [disabled]="ending()">Continue Interview</button>
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .session-page {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 0 64px;
      color: var(--text);
      font-family: 'Nunito', sans-serif;
    }
    .opening { margin: 48px 0; color: #626277; }
    .context, .identity, .title-row, .controls, .composer-head, .composer-actions, .turn, .alert, .confirmed {
      display: flex;
      align-items: center;
    }
    .context, .title-row, .composer-head, .composer-actions { justify-content: space-between; gap: 16px; }
    .context { margin-bottom: 20px; }
    .back, .mode, .hint, .eyebrow, .lead { color: #626277; }
    .back {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--purple);
      font-weight: 800;
      text-decoration: none;
    }
    .back svg, .timer svg, .mark svg, .avatar svg, .symbol svg, .alert svg, .confirmed svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .mode { margin: 0; font-size: 13px; font-weight: 700; }
    .identity { margin: 0 0 8px; }
    .identity p { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--purple); font-size: 13px; font-weight: 800; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #2f9e44; }
    .dot.warn { background: #b8860b; }
    .dot.busy { background: var(--purple); }
    .title-row { align-items: flex-start; margin-bottom: 20px; }
    h1, h2 { margin: 0; color: var(--navy); font-family: 'Poppins', sans-serif; font-weight: 700; letter-spacing: 0; }
    h1 { font-size: 28px; line-height: 1.35; }
    h2 { font-size: 24px; line-height: 1.3; }
    .controls { gap: 12px; flex-shrink: 0; }
    .timer {
      gap: 8px;
      margin: 0;
      padding: 0 16px;
      height: 48px;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: #fff;
      color: var(--navy);
    }
    .timer strong { font-size: 22px; font-weight: 900; font-variant-numeric: tabular-nums; }
    .timer span { color: #626277; font-size: 13px; font-weight: 700; }
    .timer.low, .timer.ended { background: #fff6df; border-color: #f0ddaa; color: #8a5a00; }
    .timer.low span, .timer.ended span { color: #8a5a00; }
    .surface {
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: #fff;
      box-shadow: 0 4px 24px #00000012;
      overflow: hidden;
    }
    .transcript-saved { width: 100%; margin: 20px 0; text-align: left; }
    .outcome .alert { width: 100%; margin: 16px 0 0; box-sizing: border-box; }
    .conversation {
      display: flex;
      flex-direction: column;
      gap: 16px;
      max-height: min(469px, 52vh);
      padding: 32px;
      overflow: auto;
    }
    .turn { align-items: flex-start; gap: 14px; min-width: 0; }
    .turn > div, .alert, .alert span { min-width: 0; }
    .turn > div { flex: 1; }
    .turn.student {
      margin-left: 42px;
      padding: 14px 16px;
      border-radius: 18px;
      background: #f4f5f8;
    }
    .mark, .avatar, .symbol {
      display: grid;
      place-items: center;
      flex-shrink: 0;
      border-radius: 12px;
    }
    .mark, .avatar { width: 28px; height: 28px; color: var(--purple); background: #f3eff9; }
    .who { margin: 0 0 4px; color: var(--purple); font-size: 13px; font-weight: 800; }
    .turn.student .who { color: #626277; }
    .who.bad { color: #c23b3b; }
    .content, .empty, .progress, .lead, .details p { margin: 0; white-space: pre-wrap; }
    .content { color: var(--text); font-size: 16px; font-weight: 600; line-height: 1.6; overflow-wrap: anywhere; }
    .progress, .empty, .restored { color: #626277; font-weight: 700; }
    .alert {
      align-items: flex-start;
      gap: 10px;
      margin: 0;
      padding: 14px 16px;
      border-radius: 12px;
      font-weight: 700;
      line-height: 1.5;
    }
    .alert.warn { background: #fff6df; color: #8a5a00; }
    .alert.error { background: #fdecec; color: #8d2f2f; border: 1px solid #f3c2c2; }
    .alert span { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
    .composer { padding: 24px; border-top: 1px solid var(--border); }
    .field-label { margin: 0; color: var(--navy); font-weight: 800; }
    .hint { margin: 0; font-size: 13px; font-weight: 700; }
    textarea {
      width: 100%;
      box-sizing: border-box;
      margin-top: 12px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text);
      font: inherit;
      font-weight: 600;
      resize: vertical;
      background: #fff;
    }
    textarea[aria-invalid='true'] { border-color: #e08b8b; }
    textarea:read-only, textarea:disabled { background: #f7f8fc; }
    .locked {
      margin: 12px 0 0;
      padding: 16px;
      border-radius: 12px;
      background: #f7f8fc;
      color: #626277;
      font-weight: 700;
    }
    .composer-actions { margin-top: 16px; }
    .composer-actions.stack { justify-content: flex-start; }
    button, .primary, .secondary, .quiet {
      border-radius: 12px;
      font-family: inherit;
      font-size: 15px;
      font-weight: 800;
      cursor: pointer;
    }
    .primary, .end, .secondary {
      height: 48px;
      padding: 0 18px;
      border: 2px solid #65469b;
    }
    .primary { background: #65469b; color: #fff; }
    .end, .secondary { background: #fff; color: #65469b; }
    .primary.wide, .secondary.wide { display: flex; width: 100%; align-items: center; justify-content: center; text-decoration: none; }
    .secondary.wide { margin-top: 12px; }
    .quiet {
      padding: 8px 14px;
      border: 1px solid #d9d4ea;
      background: #fff;
      color: #65469b;
    }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button:focus-visible, a:focus-visible, textarea:focus-visible {
      outline: 2px solid var(--purple);
      outline-offset: 2px;
    }
    .outcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: min(600px, 100%);
      margin: 48px auto 0;
      padding: 48px 48px 40px;
      border-radius: 24px;
      background: #fff;
      box-shadow: 0 4px 24px #00000012;
      text-align: center;
    }
    .outcome .symbol { width: 64px; height: 64px; margin-bottom: 24px; color: var(--purple); background: #f3eff9; }
    .outcome .symbol.done { color: #2f9e44; background: #e8f7ec; }
    .outcome .symbol svg { width: 28px; height: 28px; }
    .outcome h1 { margin-bottom: 12px; }
    .lead { max-width: 504px; margin-bottom: 24px; font-size: 16px; line-height: 1.6; }
    .details {
      width: 100%;
      margin-bottom: 24px;
      padding: 20px;
      border-radius: 18px;
      background: #f7f8fc;
      text-align: left;
    }
    .eyebrow { margin-bottom: 6px; font-size: 13px; font-weight: 700; }
    .detail-title { margin-bottom: 10px; color: var(--navy); font-size: 18px; font-weight: 800; }
    .confirmed { gap: 8px; margin-bottom: 8px; color: #2f9e44; font-weight: 800; }
    .outcome textarea { text-align: left; }
    .overlay {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #1e1e2e88;
    }
    .dialog {
      width: min(480px, 100%);
      padding: 32px;
      border-radius: 24px;
      background: #fff;
      box-shadow: 0 8px 32px #00000022;
    }
    .dialog .symbol { width: 44px; height: 44px; margin-bottom: 24px; color: var(--purple); background: #f3eff9; }
    .dialog p { margin: 12px 0 24px; color: #626277; font-weight: 700; line-height: 1.6; }
    .mode-group { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
    .mode-switch { display: flex; gap: 8px; }
    .mode-switch button {
      min-height: 40px;
      padding: 0 14px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: #fff;
      color: var(--navy);
      font-family: inherit;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
    }
    .mode-switch button[aria-pressed='true'] { border-color: #65469b; background: #65469b; color: #fff; }
    .voice-panel { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; margin-top: 12px; }
    .voice-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
    .mic {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 48px;
      padding: 0 16px;
      border: 2px solid #65469b;
      border-radius: 12px;
      background: #fff;
      color: #65469b;
    }
    .mic.live { background: #fdecec; border-color: #c23b3b; color: #8d2f2f; }
    .mic svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .rec-status { display: flex; align-items: center; gap: 8px; margin: 0; color: #626277; font-size: 13px; font-weight: 800; }
    .rec-dot { width: 8px; height: 8px; border-radius: 50%; background: #c9c9d4; }
    .rec-status.live .rec-dot { background: #c23b3b; animation: rec-pulse 1.2s ease-in-out infinite; }
    .interim { margin: 0; color: #626277; font-size: 14px; font-weight: 700; }
    .voice-note {
      margin: 0;
      padding: 14px 16px;
      border-radius: 12px;
      background: #fff6df;
      color: #8a5a00;
      font-weight: 700;
      line-height: 1.5;
    }
    @keyframes rec-pulse { 50% { opacity: 0.35; } }
    @media (prefers-reduced-motion: reduce) {
      .rec-dot { animation: none; }
    }
    @media (max-width: 720px) {
      .session-page { padding: 20px 16px 48px; }
      .context, .title-row, .controls, .composer-head, .composer-actions { align-items: stretch; flex-direction: column; }
      h1 { font-size: 24px; }
      .controls, .primary, .end { width: 100%; }
      .conversation { padding: 20px 16px; }
      .turn.student { margin-left: 0; }
      .outcome { padding: 32px 20px; }
      .mode-switch, .voice-controls, .mic { width: 100%; }
      .mode-switch button { flex: 1; }
      .mic { justify-content: center; }
    }
  `,
})
export class InterviewSession {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly catalog = inject(InterviewCatalogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);
  private readonly transcript = viewChild<ElementRef<HTMLElement>>('transcript');
  private voice!: InterviewVoiceController;
  private speaker!: QuestionSpeaker;

  private readonly sessionId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' }
  );

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly submitError = signal<string | null>(null);
  readonly submitNotice = signal<SubmitNotice | null>(null);
  readonly session = signal<InterviewSessionDetails | null>(null);
  readonly turns = signal<InterviewTurn[]>([]);
  readonly draft = signal('');
  readonly inputMode = signal<InterviewInputMode>('text');
  readonly recording = signal(false);
  readonly voiceNotice = signal<string | null>(null);
  readonly interimTranscript = signal('');
  readonly speechSupported = signal(false);
  readonly ttsSupported = signal(false);
  readonly speakingQuestion = signal(false);
  readonly voiceUnavailableMessage = VOICE_UNAVAILABLE_MESSAGE;
  readonly sending = signal(false);
  readonly ending = signal(false);
  readonly expiring = signal(false);
  readonly expireError = signal<string | null>(null);
  readonly confirmOpen = signal(false);
  readonly reconnecting = signal(false);
  readonly restored = signal(false);
  readonly inflightAnswer = signal<string | null>(null);
  readonly codingProblem = signal<InterviewCodingProblem | null>(null);
  readonly savedCodingCode = signal<string | null>(null);
  readonly savedCodingLanguage = signal<string | null>(null);
  readonly savedCodingResults = signal<InterviewCodingPublicTestResult[]>([]);
  readonly savedCodingPassed = signal<number | null>(null);
  readonly savedCodingTotal = signal<number | null>(null);
  private readonly nowMs = signal(Date.now());
  private readonly clockOffsetMs = signal(0);

  private loadSeq = 0;
  private loadedId = '';
  private clientTurnId: string | null = null;
  private finishRequestedFor: string | null = null;

  readonly remainingMs = computed(() => {
    const current = this.session();
    if (!current) return null;
    return interviewRemainingMs(
      current.startedAt,
      current.durationMinutes,
      this.nowMs() + this.clockOffsetMs()
    );
  });

  readonly lowTime = computed(() => {
    const current = this.session();
    const remaining = this.remainingMs();
    return (
      current?.status === 'in_progress' &&
      remaining !== null &&
      remaining > 0 &&
      remaining <= INTERVIEW_LOW_TIME_MS
    );
  });

  readonly timeUp = computed(() => {
    const current = this.session();
    return current?.status === 'in_progress' && this.remainingMs() === 0;
  });

  readonly canUseCoding = computed(
    () => this.session()?.status === 'in_progress' && !this.timeUp() && !this.ending()
  );

  readonly timerLabel = computed(() => {
    const current = this.session();
    if (!current) return '';
    if (current.status !== 'in_progress') return '00:00';
    const remaining = this.remainingMs();
    if (remaining === null) return '--:--';
    return formatInterviewClock(remaining);
  });

  readonly timeSpentLabel = computed(() => {
    const current = this.session();
    if (!current?.endedAt) return null;
    const started = Date.parse(current.startedAt);
    const ended = Date.parse(current.endedAt);
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
    return formatInterviewSpent(ended - started);
  });

  readonly endedByTime = computed(() => {
    const current = this.session();
    if (!current) return false;
    return interviewEndedBecauseTime(current.startedAt, current.durationMinutes, current.endedAt);
  });

  readonly answerAlreadyStored = computed(() => {
    const answer = this.inflightAnswer();
    if (!this.sending() || !answer) return false;
    const last = this.turns().at(-1);
    return last?.role === 'user' && last.content.trim() === answer;
  });

  readonly accessDenied = computed(() => /access|permission|forbidden/i.test(this.error() ?? ''));

  readonly statusText = computed(() => {
    if (this.reconnecting()) return 'Reconnecting';
    if (this.restored() && !this.submitError() && !this.sending()) return 'History restored';
    if (this.timeUp() || this.expiring()) return 'Time ended';
    return 'In progress';
  });

  readonly latestAssistant = computed(() => {
    const turns = this.turns();
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn?.role === 'assistant') return turn;
    }
    return null;
  });

  constructor() {
    const run = (work: () => void): void => {
      this.zone.run(work);
    };
    this.voice = new InterviewVoiceController(browserSpeechHost(), () => this.draft(), {
      onAnswerText: (text) => run(() => {
        if (this.sending()) return;
        this.draft.set(text);
        this.restored.set(false);
      }),
      onRecordingChange: (recording) => run(() => this.recording.set(recording)),
      onNotice: (message) => run(() => this.voiceNotice.set(message)),
      onInterim: (preview) => run(() => this.interimTranscript.set(preview)),
    });
    this.speaker = createQuestionSpeaker((speaking) => run(() => this.speakingQuestion.set(speaking)));
    this.speechSupported.set(this.voice.supported);
    this.ttsSupported.set(this.speaker.supported);

    const timer = setInterval(() => this.nowMs.set(Date.now()), 1000);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.stopVoiceActivity();
    });

    effect(() => {
      const id = this.sessionId();
      void this.load(id);
    });

    effect(() => {
      const current = this.session();
      const remaining = this.remainingMs();
      if (!current || !shouldAutoFinishSession(current.status, remaining)) return;
      untracked(() => this.stopVoiceActivity());
      if (this.finishRequestedFor === current.id || this.expiring()) return;
      this.finishRequestedFor = current.id;
      void this.finishBecauseTimeIsUp(current.id);
    });

    effect(() => {
      const status = this.session()?.status;
      if (!status || status === 'in_progress') return;
      untracked(() => this.stopVoiceActivity());
    });

    effect(() => {
      const questionId = this.latestAssistant()?.id ?? null;
      untracked(() => this.speaker.noteQuestion(questionId));
    });

    effect(() => {
      this.turns();
      this.sending();
      queueMicrotask(() => {
        const element = this.transcript()?.nativeElement;
        if (element) element.scrollTop = element.scrollHeight;
      });
    });
  }

  canSend(): boolean {
    const current = this.session();
    return (
      !!current &&
      current.status === 'in_progress' &&
      this.remainingMs() !== null &&
      (this.remainingMs() ?? 0) > 0 &&
      this.draft().trim().length > 0 &&
      !this.sending() &&
      !this.ending() &&
      !this.reconnecting() &&
      this.submitNotice() !== 'connection'
    );
  }

  canEnd(): boolean {
    const current = this.session();
    return !!current && current.status === 'in_progress' && !this.timeUp() && !this.ending() && !this.sending() && !this.expiring();
  }

  canAskFirst(): boolean {
    return this.turns().length === 0 && !this.draft().trim() && !this.sending() && !this.ending() && (this.remainingMs() ?? 0) > 0;
  }

  onDraft(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || this.sending()) return;
    this.draft.set(target.value);
    this.restored.set(false);
  }

  setInputMode(mode: InterviewInputMode): void {
    if (this.inputMode() === mode) return;
    this.inputMode.set(mode);
    this.voice.setMode(mode);
    if (mode === 'text') {
      this.speaker.cancel();
      if (this.interimTranscript()) this.interimTranscript.set('');
    }
  }

  toggleRecording(): void {
    if (!recognitionMayStart({
      mode: this.inputMode(),
      reconnecting: this.reconnecting(),
      sending: this.sending(),
      ending: this.ending(),
      expiring: this.expiring(),
    })) return;
    if (this.recording()) {
      this.voice.stop();
      return;
    }
    this.speaker.cancel();
    this.voice.start();
  }

  toggleQuestionSpeech(): void {
    if (this.inputMode() !== 'voice' || !this.speaker.supported) return;
    if (this.speakingQuestion()) {
      this.speaker.cancel();
      return;
    }
    const turn = this.latestAssistant();
    if (!turn) return;
    this.speaker.speak(turn.id, turn.content);
  }

  onAnswerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.onSubmit();
  }

  askFirstQuestion(): void {
    if (!this.canAskFirst()) return;
    this.draft.set('I am ready. Please ask the first question.');
    void this.onSubmit();
  }

  retryLoad(): void {
    const id = this.sessionId();
    if (id) void this.load(id);
  }

  async reconnect(): Promise<void> {
    const current = this.session();
    if (!current || this.reconnecting()) return;
    this.reconnecting.set(true);
    this.confirmOpen.set(false);
    this.voice.abandon();
    this.speaker.cancel();
    try {
      await this.load(current.id, true);
      if (!this.error()) {
        const pending = this.draft().trim();
        if (pending && this.turns().some((turn) => turn.role === 'user' && turn.content.trim() === pending)) {
          this.draft.set('');
          this.clientTurnId = null;
        }
        this.submitError.set(null);
        this.submitNotice.set(null);
        this.restored.set(true);
      }
    } finally {
      this.reconnecting.set(false);
    }
  }

  async onSubmit(event?: Event): Promise<void> {
    event?.preventDefault();
    const current = this.session();
    const answer = recognizedAnswerText(this.draft());
    if (!current || this.sending() || this.ending() || this.reconnecting()) return;
    if (!answer) {
      this.submitNotice.set('retry');
      this.submitError.set('Enter an answer before sending.');
      return;
    }
    if (!this.canSend()) return;

    this.voice.abandon();
    if (this.interimTranscript()) this.interimTranscript.set('');
    this.clientTurnId ??= crypto.randomUUID();
    const clientTurnId = this.clientTurnId;
    this.inflightAnswer.set(answer);
    this.sending.set(true);
    this.submitError.set(null);
    this.submitNotice.set(null);
    this.restored.set(false);
    try {
      const result = await this.catalog.submitAnswer(current.id, answer, clientTurnId);
      this.mergeTurns(result.turns);
      this.draft.set('');
      this.clientTurnId = null;
    } catch (error: unknown) {
      this.noteSubmitFailure(error);
      const code = error instanceof InterviewRequestError ? error.code : '';
      if (
        code === 'SESSION_EXPIRED' ||
        code === 'SESSION_CLOSED' ||
        code === 'NOT_FOUND' ||
        AI_FAILURE_CODES.has(code)
      ) {
        await this.load(current.id, true);
      } else if (code === 'TURN_CONFLICT') {
        await this.reloadTurns(current.id);
      }
    } finally {
      this.sending.set(false);
      this.inflightAnswer.set(null);
    }
  }

  retryTimeUp(): void {
    const current = this.session();
    if (!current || this.expiring() || current.status !== 'in_progress') return;
    this.expireError.set(null);
    void this.finishBecauseTimeIsUp(current.id);
  }

  private async finishBecauseTimeIsUp(sessionId: string): Promise<void> {
    if (this.expiring()) return;
    this.expiring.set(true);
    this.confirmOpen.set(false);
    this.stopVoiceActivity();
    try {
      const result = await this.catalog.finishOwnSession(sessionId, 'expired');
      if (this.session()?.id !== sessionId) return;
      if (result.session?.status === 'completed') {
        this.session.set(result.session);
        this.expireError.set(null);
        void this.catalog.requestEvaluation(sessionId).catch(() => undefined);
        await this.router.navigate(['/interview/session', sessionId, 'result']);
        return;
      }
      if (!result.timeUp && result.serverNow) {
        const serverMs = Date.parse(result.serverNow);
        if (Number.isFinite(serverMs)) {
          const offset = serverMs - Date.now();
          const current = this.session();
          const nextRemaining = current
            ? interviewRemainingMs(current.startedAt, current.durationMinutes, Date.now() + offset)
            : 0;
          this.clockOffsetMs.set(offset);
          if (nextRemaining !== 0) {
            this.finishRequestedFor = null;
            this.expireError.set(null);
            return;
          }
        }
      }
      this.expireError.set('Time is up, but the interview could not be saved as ended. Please try again.');
    } catch {
      if (this.session()?.id === sessionId) {
        this.expireError.set('Time is up, but the interview could not be saved as ended. Please try again.');
      }
    } finally {
      this.expiring.set(false);
    }
  }

  confirmEnd(): void {
    if (!this.canEnd()) return;
    this.confirmOpen.set(true);
  }

  cancelEnd(): void {
    if (this.ending()) return;
    this.confirmOpen.set(false);
  }

  async confirmEndNow(): Promise<void> {
    const current = this.session();
    if (!current || current.status !== 'in_progress' || this.ending() || this.sending()) return;
    this.ending.set(true);
    this.stopVoiceActivity();
    this.submitError.set(null);
    this.submitNotice.set(null);
    let completed = false;
    try {
      const updated = await this.catalog.completeOwnSession(current.id);
      if (updated.status !== 'completed') {
        throw new Error('This interview could not be ended.');
      }
      completed = true;
      this.session.set(updated);
      this.confirmOpen.set(false);
      void this.catalog.requestEvaluation(updated.id).catch(() => undefined);
      await this.router.navigate(['/interview/session', updated.id, 'result']);
    } catch (error: unknown) {
      if (!completed) {
        this.submitError.set(interviewErrorMessage(error, 'This interview could not be ended.'));
        this.confirmOpen.set(false);
      }
    } finally {
      this.ending.set(false);
    }
  }

  private noteSubmitFailure(error: unknown): void {
    if (!(error instanceof InterviewRequestError)) {
      this.submitNotice.set('connection');
      this.submitError.set(
        'Connection interrupted. We couldn\'t confirm your latest answer was saved. Keep your answer here and reconnect to check the session before retrying.'
      );
      return;
    }

    const message = this.accurateFailureMessage(error);
    if (error.code === 'REQUEST_FAILED') {
      this.submitNotice.set('connection');
      this.submitError.set(
        'Connection interrupted. We couldn\'t confirm your latest answer was saved. Keep your answer here and reconnect to check the session before retrying.'
      );
      return;
    }
    if (AI_FAILURE_CODES.has(error.code) || error.code === 'NOT_SAVED') {
      this.submitNotice.set('ai');
      this.submitError.set(message);
      return;
    }
    this.submitNotice.set('retry');
    this.submitError.set(message);
  }

  private accurateFailureMessage(error: InterviewRequestError): string {
    const message = error.message.trim();
    if (/not saved|wasn.t sent|was not sent/i.test(message)) return message;
    if (AI_FAILURE_CODES.has(error.code) || error.code === 'NOT_SAVED') {
      return `${message} Your answer was not saved.`;
    }
    return message;
  }

  private async load(sessionId: string, preserveDraft = false): Promise<void> {
    const request = ++this.loadSeq;
    const quiet = preserveDraft && this.session()?.id === sessionId;
    if (this.loadedId !== sessionId) {
      this.loadedId = sessionId;
      this.clientTurnId = null;
      this.finishRequestedFor = null;
      this.clockOffsetMs.set(0);
      this.expireError.set(null);
      this.confirmOpen.set(false);
      this.restored.set(false);
      this.inputMode.set('text');
      this.voice.setMode('text');
      this.speaker.cancel();
      this.voiceNotice.set(null);
      if (this.interimTranscript()) this.interimTranscript.set('');
    }
    if (!quiet) this.loading.set(true);
    this.error.set(null);
    if (!preserveDraft) {
      this.draft.set('');
      this.submitError.set(null);
      this.submitNotice.set(null);
      this.turns.set([]);
      this.session.set(null);
    }
    if (!sessionId) return;

    try {
      const session = await this.catalog.getOwnSession(sessionId);
      if (request !== this.loadSeq) return;
      if (!session) {
        this.session.set(null);
        this.turns.set([]);
        this.error.set('This interview session could not be opened. Try loading it again, or choose another interview from the catalog.');
        return;
      }
      const turns = await this.catalog.listOwnTurns(sessionId);
      if (request !== this.loadSeq) return;
      this.session.set(session);
      this.turns.set(turns);
      this.codingProblem.set(session.codingProblem);
      try {
        const saved = await this.catalog.getSessionCoding(sessionId);
        if (request !== this.loadSeq) return;
        if (saved) {
          this.savedCodingCode.set(saved.code);
          this.savedCodingLanguage.set(saved.language);
          this.savedCodingResults.set(saved.results);
          this.savedCodingPassed.set(saved.passedCount);
          this.savedCodingTotal.set(saved.totalCount);
        } else {
          this.savedCodingCode.set(null);
          this.savedCodingLanguage.set(null);
          this.savedCodingResults.set([]);
          this.savedCodingPassed.set(null);
          this.savedCodingTotal.set(null);
        }
      } catch {
        // Coding table may not exist until migration is applied; chat still works.
        this.savedCodingCode.set(null);
        this.savedCodingLanguage.set(null);
        this.savedCodingResults.set([]);
        this.savedCodingPassed.set(null);
        this.savedCodingTotal.set(null);
      }
    } catch (error: unknown) {
      if (request !== this.loadSeq) return;
      if (!preserveDraft) {
        this.session.set(null);
        this.turns.set([]);
      }
      this.error.set(interviewErrorMessage(error, 'Could not open this interview.'));
    } finally {
      if (request === this.loadSeq) this.loading.set(false);
    }
  }

  private async reloadTurns(sessionId: string): Promise<void> {
    try {
      this.turns.set(await this.catalog.listOwnTurns(sessionId));
    } catch {
      this.submitNotice.set('retry');
      this.submitError.set('Could not refresh the conversation. Your answer is still in the box and was not confirmed as saved.');
    }
  }

  private stopVoiceActivity(): void {
    this.voice.abandon();
    this.speaker.cancel();
    if (this.interimTranscript()) this.interimTranscript.set('');
  }

  private mergeTurns(incoming: InterviewTurn[]): void {
    const byId = new Map(this.turns().map((turn) => [turn.id, turn]));
    for (const turn of incoming) byId.set(turn.id, turn);
    this.turns.set([...byId.values()].sort((left, right) => left.seq - right.seq));
  }
}
