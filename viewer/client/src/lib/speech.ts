/**
 * Dictation, where the browser has it.
 *
 * Answering a gate from a phone means typing a sentence of evidence with one
 * thumb on a lock screen, which is exactly the friction that makes people
 * approve with no note at all. `SpeechRecognition` removes it — on the
 * browsers that ship it.
 *
 * ## Feature-detected, and honest about it
 *
 * This is the least evenly supported API the console touches. Chrome and
 * Safari have it behind `webkitSpeechRecognition`; Firefox does not have it at
 * all; Chrome's implementation sends audio to a Google service, Safari's can
 * run on-device. So the contract here is deliberately narrow:
 *
 *   - `speechSupport()` answers before anything is rendered, and a surface
 *     that cannot dictate renders **no mic button** rather than a dead one. A
 *     control that does nothing is worse than an absent one: it teaches the
 *     operator the feature is broken rather than absent;
 *   - the text lands in a field the operator can still see and edit. Dictation
 *     fills a box, it never submits one — a transcript is a first draft, and
 *     "approve" is not a word to let a microphone say by itself;
 *   - every failure is terminal and reported. A recogniser that stops for a
 *     denied permission, a network problem or silence is not retried, because
 *     the operator is holding the phone and can press the button again.
 *
 * Nothing here is a dependency. It is ~60 lines over a browser global, and a
 * library would be larger than the surface it wraps.
 */

/** The slice of the Web Speech API this uses — the lib types do not ship it. */
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
};

type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * Can this browser dictate?
 *
 * Asked at render time, not at module load: a test that installs the global
 * after importing this file must still see it, and a real browser answers the
 * same either way.
 */
export function speechSupport(): boolean {
  return ctor() !== null;
}

export type Dictation = {
  /** Stop listening and keep whatever was heard. */
  stop: () => void;
};

export type DictationHandlers = {
  /** Called with the transcript so far — interim results included, so the field fills as you speak. */
  onText: (text: string) => void;
  /** Listening ended, for any reason. Always called exactly once. */
  onEnd: (error?: string) => void;
  /** Defaults to the page's, which is what a browser would guess anyway. */
  lang?: string;
};

/**
 * Start listening. Returns `null` when the browser cannot.
 *
 * `interimResults` is on because a field that stays empty until you stop
 * talking looks broken; the interim text is replaced by the final transcript,
 * never appended to it. `continuous` is off: this is a sentence, not a
 * dictaphone, and a recogniser left running is a microphone left on.
 */
export function dictate(handlers: DictationHandlers): Dictation | null {
  const Ctor = ctor();
  if (!Ctor) return null;

  let recognition: Recognition;
  try {
    recognition = new Ctor();
  } catch {
    return null;
  }

  recognition.lang =
    handlers.lang ?? (typeof document !== 'undefined' ? document.documentElement.lang : '') ?? 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  // `onend` fires after `onerror`, so the reason is remembered rather than
  // reported twice — one `onEnd`, with the error when there was one.
  let failure: string | undefined;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    handlers.onEnd(failure);
  };

  recognition.onresult = (event) => {
    let text = '';
    for (let i = 0; i < event.results.length; i += 1) {
      const alternative = event.results[i]?.[0];
      if (alternative?.transcript) text += alternative.transcript;
    }
    // Trimmed at the front only: a trailing space is where the next word goes,
    // and eating it makes dictated text run together.
    if (text.trimStart()) handlers.onText(text.trimStart());
  };
  recognition.onerror = (event) => {
    // `no-speech` and `aborted` are the operator's own doing — they stopped, or
    // said nothing. Reporting those as failures would put an error toast on a
    // deliberate act.
    const code = event?.error ?? 'unknown';
    if (code !== 'no-speech' && code !== 'aborted') failure = code;
  };
  recognition.onend = finish;

  try {
    recognition.start();
  } catch {
    // Already started, or the page is not allowed to. Either way there is
    // nothing listening, and the caller must not be left with a live-looking
    // control.
    return null;
  }

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        finish();
      }
    },
  };
}
