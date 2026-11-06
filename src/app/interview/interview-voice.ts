export type InterviewInputMode = 'text' | 'voice';

/** Matches the interview answer box maxlength. */
export const INTERVIEW_ANSWER_LIMIT = 8000;

export const INTERVIEW_SPEECH_LANG = 'en-IN';

export const VOICE_UNAVAILABLE_MESSAGE =
  "Microphone access isn't available. You can continue your interview using text mode.";

export const VOICE_EMPTY_MESSAGE =
  "We didn't catch any words. Try again, or type your answer.";

export const VOICE_NO_SPEECH_MESSAGE =
  "We didn't hear anything. Try speaking again, or switch to text mode.";

export const VOICE_NETWORK_MESSAGE =
  "Speech recognition is unavailable right now. You can continue your interview using text mode.";

export const VOICE_GENERIC_MESSAGE =
  "Voice input hit a problem. You can continue your interview using text mode.";

export interface SpeechRecognitionAlternative {
  transcript: string;
}

export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}

export interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechErrorEvent {
  error?: string;
}

export interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
}

export interface SpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition;
}

export interface SpeechUtteranceLike {
  text: string;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

export interface SpeechUtteranceConstructor {
  new (text: string): SpeechUtteranceLike;
}

export interface SpeechSynthesisLike {
  speaking: boolean;
  cancel(): void;
  speak(utterance: SpeechUtteranceLike): void;
}

export interface SpeechHost {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
  speechSynthesis?: SpeechSynthesisLike | null;
  SpeechSynthesisUtterance?: SpeechUtteranceConstructor;
}

export interface InterviewVoiceHandlers {
  onAnswerText: (text: string) => void;
  onRecordingChange: (recording: boolean) => void;
  onNotice: (message: string | null) => void;
  onInterim: (preview: string) => void;
}

export function friendlySpeechError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
    case 'audio-capture':
      return VOICE_UNAVAILABLE_MESSAGE;
    case 'no-speech':
      return VOICE_NO_SPEECH_MESSAGE;
    case 'network':
      return VOICE_NETWORK_MESSAGE;
    default:
      return VOICE_GENERIC_MESSAGE;
  }
}

export function appendRecognizedAnswer(draft: string, transcript: string): string {
  const text = transcript.replace(/\s+/g, ' ').trim();
  if (!text) return draft;
  const base = draft.replace(/\s+$/, '');
  const next = base ? `${base} ${text}` : text;
  return next.length <= INTERVIEW_ANSWER_LIMIT ? next : next.slice(0, INTERVIEW_ANSWER_LIMIT);
}

/** Text sent through the existing INT-005 turn call. Voice mode never submits audio. */
export function recognizedAnswerText(draft: string): string {
  return draft.trim();
}

/** Recording may start only while voice mode is idle of reconnect, send, end, and expiry. */
export function recognitionMayStart(state: {
  mode: InterviewInputMode;
  reconnecting: boolean;
  sending: boolean;
  ending: boolean;
  expiring: boolean;
}): boolean {
  return state.mode === 'voice'
    && !state.reconnecting
    && !state.sending
    && !state.ending
    && !state.expiring;
}

export function getRecognitionConstructor(host: SpeechHost): SpeechRecognitionConstructor | null {
  const ctor = host.SpeechRecognition ?? host.webkitSpeechRecognition;
  return typeof ctor === 'function' ? ctor : null;
}

export function browserSpeechHost(target: unknown = globalThis): SpeechHost {
  if (typeof target !== 'object' || target === null) return {};
  const source = target as Record<string, unknown>;
  return {
    SpeechRecognition: asRecognitionCtor(source['SpeechRecognition']),
    webkitSpeechRecognition: asRecognitionCtor(source['webkitSpeechRecognition']),
    speechSynthesis: asSynth(source['speechSynthesis']),
    SpeechSynthesisUtterance: asUtteranceCtor(source['SpeechSynthesisUtterance']),
  };
}

export class InterviewVoiceController {
  readonly supported: boolean;
  private readonly host: SpeechHost;
  private readonly currentDraft: () => string;
  private readonly handlers: InterviewVoiceHandlers;
  private mode: InterviewInputMode = 'text';
  private recognition: BrowserSpeechRecognition | null = null;
  private recording = false;

  constructor(host: SpeechHost, currentDraft: () => string, handlers: InterviewVoiceHandlers) {
    this.host = host;
    this.currentDraft = currentDraft;
    this.handlers = handlers;
    this.supported = getRecognitionConstructor(host) !== null;
  }

  inputMode(): InterviewInputMode {
    return this.mode;
  }

  isRecording(): boolean {
    return this.recording;
  }

  setMode(mode: InterviewInputMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'text') {
      this.abandon();
      return;
    }
    if (!this.supported) this.handlers.onNotice(VOICE_UNAVAILABLE_MESSAGE);
  }

  start(): void {
    if (this.mode !== 'voice' || this.recording) return;
    const Ctor = getRecognitionConstructor(this.host);
    if (!Ctor) {
      this.handlers.onRecordingChange(false);
      this.handlers.onNotice(VOICE_UNAVAILABLE_MESSAGE);
      return;
    }
    if (this.recognition) this.abandon();

    let recognition: BrowserSpeechRecognition;
    try {
      recognition = new Ctor();
    } catch {
      this.handlers.onNotice(VOICE_UNAVAILABLE_MESSAGE);
      return;
    }

    recognition.lang = INTERVIEW_SPEECH_LANG;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => this.handleError(event);
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      this.recording = false;
      this.handlers.onRecordingChange(false);
      this.handlers.onInterim('');
    };
    this.recognition = recognition;

    try {
      recognition.start();
    } catch {
      this.recognition = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      this.recording = false;
      this.handlers.onRecordingChange(false);
      this.handlers.onNotice(VOICE_UNAVAILABLE_MESSAGE);
      return;
    }

    this.recording = true;
    this.handlers.onRecordingChange(true);
    this.handlers.onNotice(null);
  }

  /** Student pressed Stop. A final phrase may still arrive before recognition ends. */
  stop(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    this.recording = false;
    this.handlers.onRecordingChange(false);
    this.handlers.onInterim('');
    try {
      recognition.stop();
    } catch {
      this.detach(recognition);
    }
  }

  /** Drop the microphone immediately. Used when leaving voice mode or the session. */
  abandon(): void {
    const recognition = this.recognition;
    if (!recognition && !this.recording) return;
    this.detach(recognition);
  }

  private detach(recognition: BrowserSpeechRecognition | null): void {
    this.recognition = null;
    this.recording = false;
    this.handlers.onRecordingChange(false);
    this.handlers.onInterim('');
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      // The browser already released the microphone.
    }
  }

  private handleResult(event: SpeechResultEvent): void {
    if (!this.recognition || this.mode !== 'voice') return;
    const results = event.results;
    const start = Number.isInteger(event.resultIndex) && event.resultIndex > 0 ? event.resultIndex : 0;
    let interim = '';
    let finalText = '';
    let sawFinal = false;
    for (let index = start; index < results.length; index += 1) {
      const result = results[index];
      const transcript = result?.[0]?.transcript ?? '';
      if (result?.isFinal) {
        sawFinal = true;
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }
    this.handlers.onInterim(interim.replace(/\s+/g, ' ').trim());
    if (!sawFinal) return;

    const trimmed = finalText.replace(/\s+/g, ' ').trim();
    if (!trimmed) {
      this.handlers.onNotice(VOICE_EMPTY_MESSAGE);
      return;
    }
    const next = appendRecognizedAnswer(this.currentDraft(), trimmed);
    if (next === this.currentDraft()) return;
    this.handlers.onNotice(null);
    this.handlers.onAnswerText(next);
  }

  private handleError(event: SpeechErrorEvent): void {
    if (!this.recognition) return;
    const code = typeof event?.error === 'string' ? event.error : '';
    if (code === 'aborted') return;
    this.handlers.onNotice(friendlySpeechError(code));
    this.abandon();
  }
}

export class QuestionSpeaker {
  private readonly synth: SpeechSynthesisLike | null;
  private readonly createUtterance: (text: string) => SpeechUtteranceLike;
  private readonly onSpeaking: (speaking: boolean) => void;
  private questionId: string | null = null;
  private active: SpeechUtteranceLike | null = null;

  constructor(
    synth: SpeechSynthesisLike | null,
    createUtterance: (text: string) => SpeechUtteranceLike,
    onSpeaking: (speaking: boolean) => void = () => undefined,
  ) {
    this.synth = synth;
    this.createUtterance = createUtterance;
    this.onSpeaking = onSpeaking;
  }

  get supported(): boolean {
    return this.synth !== null;
  }

  /**
   * Track the assistant question currently on screen.
   * A repeated id (change detection) does not speak and does not interrupt playback.
   * A new id cancels speech that belongs to the previous question.
   */
  noteQuestion(questionId: string | null): void {
    if (questionId === this.questionId) return;
    const hadQuestion = this.questionId !== null;
    this.questionId = questionId;
    if (hadQuestion) this.cancel();
  }

  speak(questionId: string, text: string): boolean {
    if (!this.synth) return false;
    const spoken = text.trim();
    if (!spoken) return false;
    this.cancel();
    const utterance = this.createUtterance(spoken);
    utterance.lang = INTERVIEW_SPEECH_LANG;
    utterance.onend = () => this.finish(utterance);
    utterance.onerror = () => this.finish(utterance);
    this.active = utterance;
    this.onSpeaking(true);
    try {
      this.synth.speak(utterance);
    } catch {
      this.finish(utterance);
      return false;
    }
    return true;
  }

  cancel(): void {
    const utterance = this.active;
    const speaking = this.synth?.speaking === true;
    if (!utterance && !speaking) return;
    this.active = null;
    try {
      this.synth?.cancel();
    } catch {
      // Already idle.
    }
    this.onSpeaking(false);
  }

  private finish(utterance: SpeechUtteranceLike): void {
    if (this.active !== utterance) return;
    this.active = null;
    this.onSpeaking(false);
  }
}

export function createQuestionSpeaker(onSpeaking: (speaking: boolean) => void): QuestionSpeaker {
  const host = browserSpeechHost();
  const Utterance = host.SpeechSynthesisUtterance;
  if (!host.speechSynthesis || !Utterance) {
    return new QuestionSpeaker(null, () => ({ text: '', lang: '', onend: null, onerror: null }), onSpeaking);
  }
  return new QuestionSpeaker(host.speechSynthesis, (text) => new Utterance(text), onSpeaking);
}

function asRecognitionCtor(value: unknown): SpeechRecognitionConstructor | undefined {
  return typeof value === 'function' ? (value as SpeechRecognitionConstructor) : undefined;
}

function asUtteranceCtor(value: unknown): SpeechUtteranceConstructor | undefined {
  return typeof value === 'function' ? (value as SpeechUtteranceConstructor) : undefined;
}

function asSynth(value: unknown): SpeechSynthesisLike | null {
  if (typeof value !== 'object' || value === null) return null;
  const synth = value as Partial<SpeechSynthesisLike>;
  if (typeof synth.cancel !== 'function' || typeof synth.speak !== 'function') return null;
  return value as SpeechSynthesisLike;
}
