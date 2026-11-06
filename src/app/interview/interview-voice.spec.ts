import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTERVIEW_ANSWER_LIMIT,
  INTERVIEW_SPEECH_LANG,
  InterviewVoiceController,
  QuestionSpeaker,
  VOICE_EMPTY_MESSAGE,
  VOICE_GENERIC_MESSAGE,
  VOICE_NETWORK_MESSAGE,
  VOICE_NO_SPEECH_MESSAGE,
  VOICE_UNAVAILABLE_MESSAGE,
  appendRecognizedAnswer,
  recognitionMayStart,
  recognizedAnswerText,
} from './interview-voice.ts';
import { shouldAutoFinishSession } from './interview-timer.ts';
import type {
  BrowserSpeechRecognition,
  InterviewVoiceHandlers,
  SpeechErrorEvent,
  SpeechHost,
  SpeechResultEvent,
  SpeechUtteranceLike,
} from './interview-voice.ts';

class FakeRecognition implements BrowserSpeechRecognition {
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((event: SpeechResultEvent) => void) | null = null;
  onerror: ((event: SpeechErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;

  start(): void {
    this.started += 1;
  }

  stop(): void {
    this.stopped += 1;
    this.onend?.();
  }

  abort(): void {
    this.aborted += 1;
    const end = this.onend;
    end?.();
  }

  emit(parts: Array<{ text: string; isFinal: boolean }>, resultIndex = 0): void {
    this.onresult?.({
      resultIndex,
      results: parts.map((part) => ({
        isFinal: part.isFinal,
        length: 1,
        0: { transcript: part.text },
      })),
    });
  }

  fail(error?: string): void {
    this.onerror?.({ error });
  }
}

function setup(host?: SpeechHost) {
  let draft = '';
  let interim = '';
  let notice: string | null = null;
  let recording = false;
  const answers: string[] = [];
  const sends: Array<{ sessionId: string; answer: string; clientTurnId: string }> = [];
  let constructed = 0;
  let current = new FakeRecognition();
  const Ctor = function Recognition(): BrowserSpeechRecognition {
    constructed += 1;
    current = new FakeRecognition();
    return current;
  } as unknown as SpeechHost['SpeechRecognition'];

  const handlers: InterviewVoiceHandlers = {
    onAnswerText: (text) => {
      draft = text;
      answers.push(text);
    },
    onRecordingChange: (value) => {
      recording = value;
    },
    onNotice: (message) => {
      notice = message;
    },
    onInterim: (preview) => {
      interim = preview;
    },
  };

  const resolved: SpeechHost = host ?? { SpeechRecognition: Ctor };
  const voice = new InterviewVoiceController(resolved, () => draft, handlers);
  return {
    voice,
    handlers,
    sends,
    get draft() {
      return draft;
    },
    set draft(value: string) {
      draft = value;
    },
    get interim() {
      return interim;
    },
    get notice() {
      return notice;
    },
    get recording() {
      return recording;
    },
    get constructed() {
      return constructed;
    },
    get recognition() {
      return current;
    },
    submit: async (sessionId: string, clientTurnId: string) => {
      const answer = recognizedAnswerText(draft);
      if (!answer) return false;
      sends.push({ sessionId, answer, clientTurnId });
      return true;
    },
  };
}

test('text mode does not start recognition or change the typed answer', () => {
  const harness = setup();
  harness.draft = 'I compared two approaches.';
  assert.equal(harness.voice.inputMode(), 'text');
  harness.voice.start();
  harness.voice.stop();
  harness.voice.abandon();
  assert.equal(harness.constructed, 0);
  assert.equal(harness.draft, 'I compared two approaches.');
  assert.equal(harness.recording, false);
  assert.equal(harness.sends.length, 0);
});

test('voice mode can be enabled and disabled', () => {
  const harness = setup();
  harness.voice.setMode('voice');
  assert.equal(harness.voice.inputMode(), 'voice');
  harness.voice.start();
  assert.equal(harness.recording, true);
  assert.equal(harness.recognition.started, 1);
  assert.equal(harness.recognition.lang, INTERVIEW_SPEECH_LANG);
  assert.equal(harness.recognition.continuous, true);
  assert.equal(harness.recognition.interimResults, true);

  harness.voice.setMode('text');
  assert.equal(harness.voice.inputMode(), 'text');
  assert.equal(harness.recording, false);
  assert.equal(harness.recognition.aborted, 1);
  harness.voice.start();
  assert.equal(harness.constructed, 1);
});

test('a final recognition result fills the answer and a later phrase is appended', () => {
  const harness = setup();
  harness.draft = 'Earlier,';
  harness.voice.setMode('voice');
  harness.voice.start();
  harness.recognition.emit([{ text: ' I led the migration.', isFinal: true }]);
  assert.equal(harness.draft, 'Earlier, I led the migration.');

  harness.recognition.emit([
    { text: ' I led the migration.', isFinal: true },
    { text: ' We shipped it on Friday.', isFinal: true },
  ], 1);
  assert.equal(harness.draft, 'Earlier, I led the migration. We shipped it on Friday.');
  assert.equal(harness.notice, null);
});

test('recognized text is submitted only through the text-turn arguments', async () => {
  const harness = setup();
  harness.voice.setMode('voice');
  harness.voice.start();
  harness.recognition.emit([{ text: 'I led the release.', isFinal: true }]);
  assert.equal(harness.sends.length, 0);

  const sent = await harness.submit('session-1', 'turn-1');
  assert.equal(sent, true);
  assert.deepEqual(harness.sends, [{
    sessionId: 'session-1',
    answer: 'I led the release.',
    clientTurnId: 'turn-1',
  }]);
  assert.equal(JSON.stringify(harness.sends[0]).includes('audio'), false);
  assert.equal(recognizedAnswerText('  I led the release.  '), 'I led the release.');
});

test('partial recognition does not change the answer or submit it', () => {
  const harness = setup();
  harness.voice.setMode('voice');
  harness.voice.start();
  harness.recognition.emit([{ text: 'still talking', isFinal: false }]);
  assert.equal(harness.draft, '');
  assert.equal(harness.interim, 'still talking');
  assert.equal(harness.sends.length, 0);
  harness.voice.stop();
  assert.equal(harness.recognition.stopped, 1);
  assert.equal(harness.draft, '');
  assert.equal(harness.sends.length, 0);
});

test('an empty recognition result leaves the answer in place', () => {
  const harness = setup();
  harness.draft = 'Keep this draft.';
  harness.voice.setMode('voice');
  harness.voice.start();
  harness.recognition.emit([{ text: '   ', isFinal: true }]);
  assert.equal(harness.draft, 'Keep this draft.');
  assert.equal(harness.notice, VOICE_EMPTY_MESSAGE);
  assert.equal(harness.sends.length, 0);
  assert.equal(appendRecognizedAnswer('Keep this draft.', '   '), 'Keep this draft.');
});

test('microphone permission denial shows the text fallback and keeps the session', () => {
  const harness = setup();
  harness.draft = 'Typed while deciding.';
  harness.voice.setMode('voice');
  harness.voice.start();
  harness.recognition.fail('not-allowed');
  assert.equal(harness.notice, VOICE_UNAVAILABLE_MESSAGE);
  assert.equal(harness.notice?.includes('not-allowed'), false);
  assert.equal(harness.recording, false);
  assert.equal(harness.recognition.aborted, 1);
  assert.equal(harness.draft, 'Typed while deciding.');
  assert.equal(harness.voice.inputMode(), 'voice');
  harness.voice.setMode('text');
  assert.equal(harness.draft, 'Typed while deciding.');
});

test('unsupported speech recognition shows the text fallback', () => {
  const harness = setup({});
  assert.equal(harness.voice.supported, false);
  harness.voice.setMode('voice');
  assert.equal(harness.notice, VOICE_UNAVAILABLE_MESSAGE);
  harness.voice.start();
  assert.equal(harness.recording, false);
  assert.equal(harness.constructed, 0);
  assert.equal(harness.notice, VOICE_UNAVAILABLE_MESSAGE);
});

test('webkit speech recognition is used when the unprefixed API is missing', () => {
  let constructed = 0;
  let current = new FakeRecognition();
  const Ctor = function Recognition(): BrowserSpeechRecognition {
    constructed += 1;
    current = new FakeRecognition();
    return current;
  } as unknown as NonNullable<SpeechHost['webkitSpeechRecognition']>;
  const harness = setup({ webkitSpeechRecognition: Ctor });
  assert.equal(harness.voice.supported, true);
  harness.voice.setMode('voice');
  harness.voice.start();
  assert.equal(constructed, 1);
  assert.equal(current.started, 1);
});

test('recognition errors stay on the same session and hide raw browser errors', () => {
  const cases = [
    { code: 'service-not-allowed', message: VOICE_UNAVAILABLE_MESSAGE },
    { code: 'audio-capture', message: VOICE_UNAVAILABLE_MESSAGE },
    { code: 'network', message: VOICE_NETWORK_MESSAGE },
    { code: 'no-speech', message: VOICE_NO_SPEECH_MESSAGE },
    { code: 'audio-capture-device-busy', message: VOICE_GENERIC_MESSAGE },
  ];

  for (const item of cases) {
    const harness = setup();
    harness.draft = 'Still here.';
    harness.voice.setMode('voice');
    harness.voice.start();
    harness.recognition.fail(item.code);
    assert.equal(harness.notice, item.message);
    assert.equal(harness.notice?.includes(item.code), false);
    assert.equal(harness.recording, false);
    assert.equal(harness.draft, 'Still here.');
    assert.equal(harness.voice.inputMode(), 'voice');
    harness.voice.start();
    assert.equal(harness.recording, true);
  }

  const harness = setup();
  harness.voice.setMode('voice');
  harness.voice.start();
  harness.recognition.onerror?.({});
  assert.equal(harness.notice, VOICE_GENERIC_MESSAGE);
  assert.equal(harness.recording, false);
});

test('switching modes or ending the session stops recognition', () => {
  const harness = setup();
  harness.voice.setMode('voice');
  harness.voice.start();
  const active = harness.recognition;
  harness.voice.setMode('text');
  assert.equal(active.aborted, 1);
  assert.equal(active.onresult, null);
  active.emit([{ text: 'should not land', isFinal: true }]);
  assert.equal(harness.draft, '');

  harness.voice.setMode('voice');
  harness.voice.start();
  const ending = harness.recognition;
  harness.voice.abandon();
  assert.equal(ending.aborted, 1);
  assert.equal(harness.recording, false);
  ending.emit([{ text: 'too late', isFinal: true }]);
  assert.equal(harness.draft, '');
});

test('a second start while recording does not open another recognizer', () => {
  const harness = setup();
  harness.voice.setMode('voice');
  harness.voice.start();
  harness.voice.start();
  assert.equal(harness.constructed, 1);
  assert.equal(harness.recognition.started, 1);
});

test('starting recognition throws a friendly fallback instead of a browser error', () => {
  const Ctor = function Recognition(): BrowserSpeechRecognition {
    return {
      lang: '',
      continuous: false,
      interimResults: false,
      onresult: null,
      onerror: null,
      onend: null,
      start() {
        throw new Error('NotAllowedError: permission denied');
      },
      stop() {},
      abort() {},
    };
  } as unknown as SpeechHost['SpeechRecognition'];
  const harness = setup({ SpeechRecognition: Ctor });
  harness.voice.setMode('voice');
  harness.voice.start();
  assert.equal(harness.notice, VOICE_UNAVAILABLE_MESSAGE);
  assert.equal(harness.notice?.includes('NotAllowedError'), false);
  assert.equal(harness.recording, false);
});

test('recognized answers stop at the existing answer limit', () => {
  const full = 'a'.repeat(INTERVIEW_ANSWER_LIMIT);
  assert.equal(appendRecognizedAnswer(full, 'more'), full);
  assert.equal(appendRecognizedAnswer('Hello', 'there').length < INTERVIEW_ANSWER_LIMIT, true);
});

test('question playback does not submit and does not repeat from question notifications', () => {
  const spoken: string[] = [];
  let speaking = false;
  let submits = 0;
  const synth = {
    speaking: false,
    speak(utterance: SpeechUtteranceLike) {
      this.speaking = true;
      spoken.push(utterance.text);
      assert.equal(utterance.lang, INTERVIEW_SPEECH_LANG);
    },
    cancel() {
      this.speaking = false;
    },
  };
  const speaker = new QuestionSpeaker(synth, (text) => ({
    text,
    lang: '',
    onend: null,
    onerror: null,
  }), (value) => {
    speaking = value;
  });

  speaker.noteQuestion('question-1');
  speaker.noteQuestion('question-1');
  assert.equal(spoken.length, 0);
  assert.equal(submits, 0);

  assert.equal(speaker.speak('question-1', ' Tell me about a challenge. '), true);
  speaker.noteQuestion('question-1');
  assert.deepEqual(spoken, ['Tell me about a challenge.']);
  assert.equal(speaking, true);
  assert.equal(submits, 0);

  speaker.noteQuestion('question-2');
  assert.equal(synth.speaking, false);
  assert.equal(speaking, false);
  assert.equal(spoken.length, 1);
  assert.equal(submits, 0);

  speaker.cancel();
  assert.equal(synth.speaking, false);
  assert.equal(speaking, false);
  const silent = new QuestionSpeaker(null, (text) => ({ text, lang: '', onend: null, onerror: null }));
  assert.equal(silent.supported, false);
  assert.equal(silent.speak('question-3', 'Hello'), false);
  silent.noteQuestion('question-3');
  silent.cancel();
  assert.equal(submits, 0);
});

test('reconnect stops recognition and speech and does not resume on its own', () => {
  const harness = setup();
  const spoken: string[] = [];
  let speaking = false;
  const synth = {
    speaking: false,
    speak(utterance: SpeechUtteranceLike) {
      this.speaking = true;
      spoken.push(utterance.text);
    },
    cancel() {
      this.speaking = false;
    },
  };
  const speaker = new QuestionSpeaker(synth, (text) => ({
    text,
    lang: '',
    onend: null,
    onerror: null,
  }), (value) => {
    speaking = value;
  });

  harness.voice.setMode('voice');
  harness.voice.start();
  assert.equal(speaker.speak('question-1', 'Tell me about a challenge.'), true);
  assert.equal(harness.recording, true);
  assert.equal(speaking, true);

  const reconnecting = true;
  assert.equal(recognitionMayStart({
    mode: 'voice',
    reconnecting,
    sending: false,
    ending: false,
    expiring: false,
  }), false);
  harness.voice.abandon();
  speaker.cancel();

  assert.equal(harness.recording, false);
  assert.equal(harness.recognition.aborted, 1);
  assert.equal(speaking, false);
  assert.equal(synth.speaking, false);
  harness.recognition.emit([{ text: 'late phrase', isFinal: true }]);
  assert.equal(harness.draft, '');
  assert.equal(harness.voice.isRecording(), false);
  assert.equal(harness.constructed, 1);

  assert.equal(recognitionMayStart({
    mode: 'voice',
    reconnecting: false,
    sending: false,
    ending: false,
    expiring: false,
  }), true);
});

test('timer expiry stops recognition and speech before another answer can be sent', () => {
  const harness = setup();
  const synth = {
    speaking: false,
    speak() {
      this.speaking = true;
    },
    cancel() {
      this.speaking = false;
    },
  };
  let speaking = false;
  const speaker = new QuestionSpeaker(synth, (text) => ({
    text,
    lang: '',
    onend: null,
    onerror: null,
  }), (value) => {
    speaking = value;
  });

  harness.voice.setMode('voice');
  harness.voice.start();
  speaker.speak('question-1', 'What did you do next?');
  harness.draft = 'I was still speaking.';
  assert.equal(shouldAutoFinishSession('in_progress', 0), true);

  harness.voice.abandon();
  speaker.cancel();

  assert.equal(harness.recording, false);
  assert.equal(harness.recognition.aborted, 1);
  assert.equal(speaking, false);
  assert.equal(recognitionMayStart({
    mode: 'voice',
    reconnecting: false,
    sending: false,
    ending: false,
    expiring: true,
  }), false);
  harness.recognition.emit([{ text: 'after the timer', isFinal: true }]);
  assert.equal(harness.draft, 'I was still speaking.');
  assert.equal(harness.sends.length, 0);
});
