/**
 * The catalog is the single source of truth the frontend renders its toggles from.
 * `implemented: false` entries are visible but disabled — they are the queue of
 * providers waiting to be hooked in.
 */

import {
  CARTESIA_LANGUAGE_NAMES,
  CARTESIA_MODEL_LANGUAGES,
  CARTESIA_VOICES_BY_LANGUAGE,
} from './cartesia-catalog.js';
import {
  MURF_FALCON_LOCALES,
  MURF_FALCON_VOICES,
  MURF_GEN2_LOCALES,
  MURF_GEN2_VOICES,
} from './murf-catalog.js';

export type ProviderKind = 'realtime' | 'stt' | 'llm' | 'tts';

export interface ModelEntry {
  id: string;
  name: string;
  note?: string;
  /**
   * Voices this model in particular exposes, where the vendor keeps one catalogue
   * per model rather than one per provider (Murf: Falcon 2 and Gen2 share only
   * 100 of their 137/163 voices, and the wrong one is a hard error). A model's
   * own list wins over the provider's — see `voicesFor()`.
   */
  voices?: ModelEntry[];
  /**
   * Languages this model in particular accepts. Same precedence as `voices`, and
   * a language entry may itself carry `voices` where the choice narrows again —
   * Cartesia groups 934 voices by language, so picking Hindi is what makes the
   * 49 Hindi voices the list.
   */
  languages?: ModelEntry[];
}

export interface ProviderEntry {
  id: string;
  name: string;
  kind: ProviderKind;
  implemented: boolean;
  /** Env vars that must be present for this provider to run. */
  envKeys: string[];
  models: ModelEntry[];
  /** Voices, where the provider exposes named voices. */
  voices?: ModelEntry[];
  /**
   * True where the vendor accepts any voice id, not just the ones listed above —
   * the UI then offers a free-text voice id next to the dropdown. Only set it for
   * a vendor measured to accept one; a wrong guess here produces a 400 the UI
   * cannot explain.
   */
  acceptsVoiceId?: boolean;
  /** Shown under that field: where to find a valid id for this vendor. */
  voiceIdHint?: string;
  /**
   * Voices grouped by language, where the same grouping serves every model —
   * Cartesia's 934 are shared across its five Sonic models, and nesting them
   * under each model's language list would send the library five times over the
   * wire. `voicesFor` reads this when the model's own language entry has none.
   */
  voicesByLanguage?: Record<string, ModelEntry[]>;
  /** Languages, where the provider requires one to be named up front. */
  languages?: ModelEntry[];
  docs?: string;
}

/**
 * Cartesia's voices are grouped by language and its language support is per
 * model, so a model's language list is assembled from the two generated tables.
 */
function cartesiaLanguages(model: string): ModelEntry[] {
  // Names only. The voices themselves live once on the provider, in
  // `voicesByLanguage`, so /api/catalog carries the library a single time.
  return (CARTESIA_MODEL_LANGUAGES[model] ?? []).map((id) => ({
    id,
    name: CARTESIA_LANGUAGE_NAMES[id] ?? id,
  }));
}

/**
 * The 30 prebuilt Gemini speech voices, from the speech-generation guide. The
 * same set serves the TTS models and the Live API native-audio models.
 *
 * Hand-transcribed from the docs on 2026-09-05 and NOT probed — no Gemini call
 * could be made from here, the key's project answers 429 "prepayment credits are
 * depleted". Unlike the Murf and Cartesia tables, which a script generated from
 * each vendor's own list endpoint, nothing below has been echoed back by Google.
 *
 * Stored TitleCase because that is what every current sample uses; the guide's
 * prose mentions a `voice_name` field that does not exist in the API, so the
 * prose is not a reliable guide to the values either.
 * https://ai.google.dev/gemini-api/docs/speech-generation
 */
const GEMINI_VOICES: ModelEntry[] = [
  { id: 'Zephyr', name: 'Zephyr (bright)' },
  { id: 'Puck', name: 'Puck (upbeat)' },
  { id: 'Charon', name: 'Charon (informative)' },
  { id: 'Kore', name: 'Kore (firm)' },
  { id: 'Fenrir', name: 'Fenrir (excitable)' },
  { id: 'Leda', name: 'Leda (youthful)' },
  { id: 'Orus', name: 'Orus (firm)' },
  { id: 'Aoede', name: 'Aoede (breezy)' },
  { id: 'Callirrhoe', name: 'Callirrhoe (easy-going)' },
  { id: 'Autonoe', name: 'Autonoe (bright)' },
  { id: 'Enceladus', name: 'Enceladus (breathy)' },
  { id: 'Iapetus', name: 'Iapetus (clear)' },
  { id: 'Umbriel', name: 'Umbriel (easy-going)' },
  { id: 'Algieba', name: 'Algieba (smooth)' },
  { id: 'Despina', name: 'Despina (smooth)' },
  { id: 'Erinome', name: 'Erinome (clear)' },
  { id: 'Algenib', name: 'Algenib (gravelly)' },
  { id: 'Rasalgethi', name: 'Rasalgethi (informative)' },
  { id: 'Laomedeia', name: 'Laomedeia (upbeat)' },
  { id: 'Achernar', name: 'Achernar (soft)' },
  { id: 'Alnilam', name: 'Alnilam (firm)' },
  { id: 'Schedar', name: 'Schedar (even)' },
  { id: 'Gacrux', name: 'Gacrux (mature)' },
  { id: 'Pulcherrima', name: 'Pulcherrima (forward)' },
  { id: 'Achird', name: 'Achird (friendly)' },
  { id: 'Zubenelgenubi', name: 'Zubenelgenubi (casual)' },
  { id: 'Vindemiatrix', name: 'Vindemiatrix (gentle)' },
  { id: 'Sadachbia', name: 'Sadachbia (lively)' },
  { id: 'Sadaltager', name: 'Sadaltager (knowledgeable)' },
  { id: 'Sulafat', name: 'Sulafat (warm)' },
];

/**
 * Gemini has THREE different language surfaces and they are not the same list —
 * the same trap Murf's locales and Cartesia's per-model sets already set here.
 *
 *   · the TTS models auto-detect language from the text and publish ~80 BARE
 *     codes (`en`, `hi`) as "supported"
 *   · `SpeechConfig.languageCode` accepts only the 30 LOCALES below, and the
 *     REST reference enumerates them exhaustively
 *   · Live API native-audio models refuse an explicit language entirely
 *
 * Only the middle list is a thing the caller can actually send, so only it is
 * offered. GeminiTtsProvider drops anything outside it rather than forwarding a
 * value the API would reject.
 * https://ai.google.dev/api/generate-content
 */
const GEMINI_TTS_LOCALES: ModelEntry[] = [
  { id: 'en-US', name: 'English (US)' },
  { id: 'en-IN', name: 'English (India)' },
  { id: 'en-AU', name: 'English (Australia)' },
  { id: 'en-GB', name: 'English (UK)' },
  { id: 'hi-IN', name: 'Hindi' },
  { id: 'bn-IN', name: 'Bengali' },
  { id: 'gu-IN', name: 'Gujarati' },
  { id: 'kn-IN', name: 'Kannada' },
  { id: 'ml-IN', name: 'Malayalam' },
  { id: 'mr-IN', name: 'Marathi' },
  { id: 'ta-IN', name: 'Tamil' },
  { id: 'te-IN', name: 'Telugu' },
  { id: 'ar-XA', name: 'Arabic' },
  { id: 'cmn-CN', name: 'Chinese (Mandarin)' },
  { id: 'de-DE', name: 'German' },
  { id: 'es-ES', name: 'Spanish (Spain)' },
  { id: 'es-US', name: 'Spanish (US)' },
  { id: 'fr-FR', name: 'French' },
  { id: 'fr-CA', name: 'French (Canada)' },
  { id: 'id-ID', name: 'Indonesian' },
  { id: 'it-IT', name: 'Italian' },
  { id: 'ja-JP', name: 'Japanese' },
  { id: 'ko-KR', name: 'Korean' },
  { id: 'nl-NL', name: 'Dutch' },
  { id: 'pl-PL', name: 'Polish' },
  { id: 'pt-BR', name: 'Portuguese (Brazil)' },
  { id: 'ru-RU', name: 'Russian' },
  { id: 'th-TH', name: 'Thai' },
  { id: 'tr-TR', name: 'Turkish' },
  { id: 'vi-VN', name: 'Vietnamese' },
];

/**
 * The 83 locales `inputAudioTranscription.languageCodes` accepts, from Google's
 * transcribe model page, plus the auto-detect default.
 *
 * `languageCodes: []` — which is what `auto` sends — is documented to auto-detect
 * AND code-switch mid-utterance, so it is the first entry rather than a fallback.
 * Read off the docs on 2026-09-05 and not probed: no transcription has been run
 * through this provider, because the key's project answers 429.
 * https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe
 */
const GEMINI_STT_LOCALES: ModelEntry[] = [
  { id: 'auto', name: 'Auto-detect (code-switching)' },
  { id: 'af-ZA', name: 'Afrikaans' },
  { id: 'am-ET', name: 'Amharic' },
  { id: 'ar-EG', name: 'Arabic (Egypt)' },
  { id: 'hy-AM', name: 'Armenian' },
  { id: 'as-IN', name: 'Assamese' },
  { id: 'az-AZ', name: 'Azerbaijani' },
  { id: 'be-BY', name: 'Belarusian' },
  { id: 'bn-BD', name: 'Bengali (Bangladesh)' },
  { id: 'bn-IN', name: 'Bengali (India)' },
  { id: 'bs-BA', name: 'Bosnian' },
  { id: 'bg-BG', name: 'Bulgarian' },
  { id: 'rup-BG', name: 'Bulgarian (Aromanian)' },
  { id: 'my-MM', name: 'Burmese' },
  { id: 'yue-Hant-HK', name: 'Cantonese (Traditional)' },
  { id: 'ca-ES', name: 'Catalan' },
  { id: 'ceb', name: 'Cebuano' },
  { id: 'km-KH', name: 'Central Khmer' },
  { id: 'hr-HR', name: 'Croatian' },
  { id: 'cs-CZ', name: 'Czech' },
  { id: 'da-DK', name: 'Danish' },
  { id: 'nl-NL', name: 'Dutch' },
  { id: 'en-GB', name: 'English (Great Britain)' },
  { id: 'en-IN', name: 'English (India)' },
  { id: 'en-US', name: 'English (United States)' },
  { id: 'et-EE', name: 'Estonian' },
  { id: 'fa-IR', name: 'Farsi' },
  { id: 'fil-PH', name: 'Filipino' },
  { id: 'fi-FI', name: 'Finnish' },
  { id: 'fr-FR', name: 'French' },
  { id: 'gl-ES', name: 'Galician' },
  { id: 'ka-GE', name: 'Georgian' },
  { id: 'de-DE', name: 'German' },
  { id: 'el-GR', name: 'Greek' },
  { id: 'gu-IN', name: 'Gujarati' },
  { id: 'ha-NG', name: 'Hausa' },
  { id: 'he-IL', name: 'Hebrew' },
  { id: 'hi-IN', name: 'Hindi' },
  { id: 'hu-HU', name: 'Hungarian' },
  { id: 'is-IS', name: 'Icelandic' },
  { id: 'id-ID', name: 'Indonesian' },
  { id: 'it-IT', name: 'Italian' },
  { id: 'ja-JP', name: 'Japanese' },
  { id: 'jv-ID', name: 'Javanese' },
  { id: 'kea-CV', name: 'Kabuverdianu' },
  { id: 'kn-IN', name: 'Kannada' },
  { id: 'kk-KZ', name: 'Kazakh' },
  { id: 'ko-KR', name: 'Korean' },
  { id: 'ky-KG', name: 'Kyrgyz' },
  { id: 'lv-LV', name: 'Latvian' },
  { id: 'ln-CD', name: 'Lingala' },
  { id: 'lt-LT', name: 'Lithuanian' },
  { id: 'mk-MK', name: 'Macedonian' },
  { id: 'ms-MY', name: 'Malay' },
  { id: 'ml-IN', name: 'Malayalam' },
  { id: 'mt-MT', name: 'Maltese' },
  { id: 'cmn-Hans-CN', name: 'Mandarin Chinese (Simplified)' },
  { id: 'mr-IN', name: 'Marathi' },
  { id: 'mn-MN', name: 'Mongolian' },
  { id: 'ne-NP', name: 'Nepali' },
  { id: 'nb-NO', name: 'Norwegian' },
  { id: 'or-IN', name: 'Oriya' },
  { id: 'pl-PL', name: 'Polish' },
  { id: 'pt-BR', name: 'Portuguese (Brazil)' },
  { id: 'pt-PT', name: 'Portuguese (Portugal)' },
  { id: 'pa-IN', name: 'Punjabi' },
  { id: 'pa-Guru-IN', name: 'Punjabi (Gurmukhi script)' },
  { id: 'ro-RO', name: 'Romanian' },
  { id: 'ru-RU', name: 'Russian' },
  { id: 'sr-RS', name: 'Serbian' },
  { id: 'sd-Arab-IN', name: 'Sindhi (Arabic script)' },
  { id: 'sk-SK', name: 'Slovak' },
  { id: 'sl-SI', name: 'Slovenian' },
  { id: 'es-419', name: 'Spanish (Latin America)' },
  { id: 'es-US', name: 'Spanish (United States)' },
  { id: 'sw-KE', name: 'Swahili (Kenya)' },
  { id: 'sv-SE', name: 'Swedish' },
  { id: 'tg-TJ', name: 'Tajik' },
  { id: 'te-IN', name: 'Telugu' },
  { id: 'th-TH', name: 'Thai' },
  { id: 'tr-TR', name: 'Turkish' },
  { id: 'uk-UA', name: 'Ukrainian' },
  { id: 'uz-UZ', name: 'Uzbek' },
  { id: 'vi-VN', name: 'Vietnamese' },
];

export const CATALOG: ProviderEntry[] = [
  /* ------------------------------- realtime ------------------------------- */
  {
    id: 'mock-realtime',
    name: 'Mock (echo)',
    kind: 'realtime',
    implemented: true,
    envKeys: [],
    models: [{ id: 'mock-s2s', name: 'Echo speech-to-speech', note: 'Local, no network. Sanity-checks the audio path.' }],
    voices: [{ id: 'beep', name: 'Beep tone' }],
  },
  {
    id: 'openai-realtime',
    name: 'OpenAI Realtime',
    kind: 'realtime',
    implemented: true,
    envKeys: ['OPENAI_API_KEY'],
    docs: 'https://developers.openai.com/api/docs/guides/voice-agents',
    // The one leg of this bench where the vendor's audio format needs no
    // adapting: the GA session schema pins PCM at 24 kHz — the format object's
    // own docstrings read "Always `audio/pcm`" and "Always `24000`" — which is
    // CANONICAL_SAMPLE_RATE exactly, in both directions.
    //
    // The session shape below is the nested GA one (`session.audio.input.format`),
    // not the flat `input_audio_format` the older guides show; that was read off
    // OpenAI's published API schema rather than a prose page, because the two
    // disagree and the prose is the stale half.
    //
    // Doc-derived throughout. A key IS present in the shell environment and the
    // free GET /v1/models answers with it — which is how the two model ids below
    // were confirmed to exist — but no billable call has ever been made, because
    // a realtime session costs real money and that was not authorised. So the
    // ids are checked and everything else here is read off a doc page. The
    // `gpt-4o-realtime-preview` pair this entry used to list are gone.
    models: [
      { id: 'gpt-realtime-2.1', name: 'gpt-realtime-2.1', note: 'Current flagship speech-to-speech' },
      {
        id: 'gpt-realtime-2.1-mini',
        name: 'gpt-realtime-2.1-mini',
        note: 'Distilled — vendor prices audio at half the flagship and claims better alphanumeric recognition',
      },
    ],
    // OpenAI recommends marin and cedar; the other eight are the older set.
    voices: [
      { id: 'marin', name: 'Marin (recommended)' },
      { id: 'cedar', name: 'Cedar (recommended)' },
      { id: 'alloy', name: 'Alloy' },
      { id: 'ash', name: 'Ash' },
      { id: 'ballad', name: 'Ballad' },
      { id: 'coral', name: 'Coral' },
      { id: 'echo', name: 'Echo' },
      { id: 'sage', name: 'Sage' },
      { id: 'shimmer', name: 'Shimmer' },
      { id: 'verse', name: 'Verse' },
    ],
  },
  {
    id: 'gemini-live',
    name: 'Google Gemini Live',
    kind: 'realtime',
    implemented: false,
    envKeys: ['GOOGLE_API_KEY'],
    docs: 'https://ai.google.dev/gemini-api/docs/live',
    models: [
      { id: 'gemini-2.5-flash-native-audio-preview', name: 'gemini-2.5-flash native audio' },
      { id: 'gemini-live-2.5-flash-preview', name: 'gemini-live-2.5-flash' },
    ],
    voices: [
      { id: 'Puck', name: 'Puck' },
      { id: 'Charon', name: 'Charon' },
      { id: 'Kore', name: 'Kore' },
      { id: 'Aoede', name: 'Aoede' },
    ],
  },
  {
    id: 'elevenlabs-agents',
    name: 'ElevenLabs Agents',
    kind: 'realtime',
    implemented: false,
    envKeys: ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID'],
    docs: 'https://elevenlabs.io/docs/agents-platform',
    models: [{ id: 'agent', name: 'Configured agent', note: 'Model/voice/prompt live in the ElevenLabs dashboard.' }],
  },
  {
    id: 'aws-nova-sonic',
    name: 'AWS Nova Sonic',
    kind: 'realtime',
    implemented: false,
    envKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    docs: 'https://docs.aws.amazon.com/nova/latest/userguide/speech.html',
    models: [{ id: 'amazon.nova-sonic-v1:0', name: 'nova-sonic-v1' }],
    voices: [
      { id: 'matthew', name: 'Matthew' },
      { id: 'tiffany', name: 'Tiffany' },
      { id: 'amy', name: 'Amy' },
    ],
  },

  /* --------------------------------- STT --------------------------------- */
  {
    id: 'mock-stt',
    name: 'Mock (canned)',
    kind: 'stt',
    implemented: true,
    envKeys: [],
    models: [{ id: 'mock-asr', name: 'Canned transcript', note: 'Emits placeholder text after silence.' }],
  },
  {
    id: 'sarvam-stt',
    name: 'Sarvam Saaras',
    kind: 'stt',
    implemented: true,
    envKeys: ['SARVAM_API_KEY'],
    docs: 'https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/realtime/ws',
    models: [
      { id: 'saaras:v3-realtime@fast', name: 'saaras:v3-realtime (fast)', note: 'Lowest latency stream_type' },
      { id: 'saaras:v3-realtime@balanced', name: 'saaras:v3-realtime (balanced)', note: 'Sarvam default — more accurate' },
      { id: 'saaras:v4-realtime@fast', name: 'saaras:v4-realtime (fast)' },
      { id: 'saaras:v4-realtime@balanced', name: 'saaras:v4-realtime (balanced)' },
    ],
    languages: [
      { id: 'auto', name: 'Auto-detect' },
      { id: 'en-IN', name: 'English (India)' },
      { id: 'hi-IN', name: 'Hindi' },
      { id: 'bn-IN', name: 'Bengali' },
      { id: 'ta-IN', name: 'Tamil' },
      { id: 'te-IN', name: 'Telugu' },
      { id: 'kn-IN', name: 'Kannada' },
      { id: 'ml-IN', name: 'Malayalam' },
      { id: 'mr-IN', name: 'Marathi' },
      { id: 'gu-IN', name: 'Gujarati' },
      { id: 'pa-IN', name: 'Punjabi' },
      { id: 'or-IN', name: 'Odia' },
      { id: 'as-IN', name: 'Assamese' },
      { id: 'ur-IN', name: 'Urdu' },
    ],
  },
  {
    id: 'cartesia-stt',
    name: 'Cartesia Ink',
    kind: 'stt',
    implemented: true,
    envKeys: ['CARTESIA_API_KEY'],
    docs: 'https://docs.cartesia.ai/api-reference/stt/stt',
    // Sonic is TTS-only; Ink is Cartesia's STT family. Audio goes up as raw
    // binary at 24kHz, so this leg is resample-free too.
    models: [
      { id: 'ink-2', name: 'ink-2', note: 'Streams word-level segments from ~1.0s' },
      { id: 'ink-whisper', name: 'ink-whisper', note: 'Whole-utterance finals, ~3.5s — much slower' },
    ],
    languages: [
      { id: 'en', name: 'English' },
      { id: 'hi', name: 'Hindi' },
      { id: 'bn', name: 'Bengali' },
      { id: 'ta', name: 'Tamil' },
      { id: 'te', name: 'Telugu' },
      { id: 'kn', name: 'Kannada' },
      { id: 'ml', name: 'Malayalam' },
      { id: 'mr', name: 'Marathi' },
      { id: 'gu', name: 'Gujarati' },
      { id: 'pa', name: 'Punjabi' },
      { id: 'or', name: 'Odia' },
      { id: 'ur', name: 'Urdu' },
      { id: 'es', name: 'Spanish' },
      { id: 'fr', name: 'French' },
      { id: 'de', name: 'German' },
      { id: 'pt', name: 'Portuguese' },
      { id: 'it', name: 'Italian' },
      { id: 'nl', name: 'Dutch' },
      { id: 'pl', name: 'Polish' },
      { id: 'ru', name: 'Russian' },
      { id: 'tr', name: 'Turkish' },
      { id: 'ar', name: 'Arabic' },
      { id: 'ja', name: 'Japanese' },
      { id: 'ko', name: 'Korean' },
      { id: 'zh', name: 'Chinese' },
      { id: 'vi', name: 'Vietnamese' },
      { id: 'id', name: 'Indonesian' },
      { id: 'th', name: 'Thai' },
    ],
  },
  {
    id: 'gemini-stt',
    name: 'Google Gemini Transcribe',
    kind: 'stt',
    implemented: true,
    envKeys: ['GOOGLE_API_KEY'],
    docs: 'https://ai.google.dev/gemini-api/docs/live-api/live-transcribe',
    // Streaming transcription rides the Live API's bidiGenerateContent socket:
    // `gemini-3.5-transcribe-live` publishes no other method, so there is no
    // HTTP streaming path to fall back to. Its sibling `gemini-3.5-transcribe`
    // is generateContent-only — a file endpoint, not a stream — so it is absent
    // here rather than offered as a slower option it could not serve.
    //
    // Both facts come from Google's own ListModels response, which is the only
    // part of this entry that was checked against the live API: the project's
    // key answers 429 "prepayment credits are depleted", so no transcription has
    // ever been performed through this provider.
    models: [
      {
        id: 'gemini-3.5-transcribe-live',
        name: 'gemini-3.5-transcribe-live',
        note: 'Live API socket · sessions capped at 10 min · no diarization or word timestamps',
      },
    ],
    // Auto-detect leads the list because `languageCodes: []` is the documented
    // default and code-switches mid-utterance, which is the right behaviour for
    // an Indian-English bench; the 83 explicit locales are there to pin it.
    languages: GEMINI_STT_LOCALES,
  },
  {
    id: 'deepgram-stt',
    name: 'Deepgram',
    kind: 'stt',
    implemented: false,
    envKeys: ['DEEPGRAM_API_KEY'],
    docs: 'https://developers.deepgram.com/docs/streaming',
    models: [
      { id: 'nova-3', name: 'nova-3' },
      { id: 'nova-2', name: 'nova-2' },
    ],
  },
  {
    id: 'assemblyai-stt',
    name: 'AssemblyAI',
    kind: 'stt',
    implemented: false,
    envKeys: ['ASSEMBLYAI_API_KEY'],
    docs: 'https://www.assemblyai.com/docs/speech-to-text/universal-streaming',
    models: [{ id: 'universal-streaming', name: 'Universal Streaming' }],
  },
  {
    id: 'openai-stt',
    name: 'OpenAI',
    kind: 'stt',
    implemented: false,
    envKeys: ['OPENAI_API_KEY'],
    docs: 'https://platform.openai.com/docs/guides/speech-to-text',
    models: [
      { id: 'gpt-4o-transcribe', name: 'gpt-4o-transcribe' },
      { id: 'gpt-4o-mini-transcribe', name: 'gpt-4o-mini-transcribe' },
      { id: 'whisper-1', name: 'whisper-1' },
    ],
  },
  {
    id: 'elevenlabs-stt',
    name: 'ElevenLabs Scribe',
    kind: 'stt',
    implemented: false,
    envKeys: ['ELEVENLABS_API_KEY'],
    docs: 'https://elevenlabs.io/docs/capabilities/speech-to-text',
    models: [{ id: 'scribe_v1', name: 'scribe_v1' }],
  },

  /* --------------------------------- LLM --------------------------------- */
  {
    id: 'mock-llm',
    name: 'Mock (echo)',
    kind: 'llm',
    implemented: true,
    envKeys: [],
    models: [{ id: 'mock-chat', name: 'Echo + canned reply' }],
  },
  {
    id: 'anthropic-llm',
    name: 'Anthropic',
    kind: 'llm',
    implemented: false,
    envKeys: ['ANTHROPIC_API_KEY'],
    docs: 'https://docs.anthropic.com/en/api/messages',
    models: [
      { id: 'claude-opus-5', name: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', note: 'Cheapest/fastest — good default for a voice loop.' },
    ],
  },
  {
    id: 'openai-llm',
    name: 'OpenAI',
    kind: 'llm',
    implemented: true,
    envKeys: ['OPENAI_API_KEY'],
    docs: 'https://developers.openai.com/api/docs/guides/migrate-to-responses',
    // Driven through the Responses API, not Chat Completions — from GPT-5.4 on,
    // Chat Completions cannot combine tool calling with a `reasoning_effort`
    // other than `none`, and reasoning depth is the dial this bench exists to
    // compare.
    //
    // Reasoning depth rides in the model id as `@variant` (`gpt-5.6-luna@none`),
    // the same convention as the Gemini entry, and the variant names are
    // OpenAI's own `reasoning.effort` values so nothing is invented in
    // translation. `@none` leads each family because OpenAI names that the
    // effort intended for voice.
    //
    // The model IDS below were checked against the live account's GET /v1/models
    // and all exist, and `gpt-5.4-nano@none` has streamed a real completion
    // (2026-09-05). Everything else — which effort values each model takes, and
    // the ordering — is still doc-derived: unlike the Gemini list above, whose
    // notes carry per-variant measured TTFT from `npm run gemini:live`, there is
    // no equivalent sweep for OpenAI. One model timed once is not a ranking, so
    // the list is NOT ordered fastest-first and no note claims a latency.
    models: [
      { id: 'gpt-5.6-luna@none', name: 'gpt-5.6-luna (none)', note: 'Cheapest 5.6 · no reasoning — the effort OpenAI names for voice' },
      { id: 'gpt-5.6-luna@low', name: 'gpt-5.6-luna (low)' },
      { id: 'gpt-5.6-luna@medium', name: 'gpt-5.6-luna (medium)', note: "OpenAI's default effort for this family" },
      { id: 'gpt-5.6-terra@none', name: 'gpt-5.6-terra (none)', note: 'Mid 5.6 tier' },
      { id: 'gpt-5.6-terra@low', name: 'gpt-5.6-terra (low)' },
      { id: 'gpt-5.6-sol@none', name: 'gpt-5.6-sol (none)', note: 'Most capable 5.6 · 20x luna on output' },
      { id: 'gpt-5.6-sol@low', name: 'gpt-5.6-sol (low)' },
      { id: 'gpt-5.4-mini@none', name: 'gpt-5.4-mini (none)' },
      { id: 'gpt-5.4-mini@low', name: 'gpt-5.4-mini (low)' },
      { id: 'gpt-5.4-nano@none', name: 'gpt-5.4-nano (none)', note: 'Cheapest reasoning-capable model here' },
      { id: 'gpt-5.4-nano@low', name: 'gpt-5.4-nano (low)' },
      // No reasoning parameter at all — the provider never sends one for these,
      // so they carry no @variant either.
      { id: 'gpt-4.1-mini', name: 'gpt-4.1-mini', note: 'No reasoning parameter — previous generation' },
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini', note: 'No reasoning parameter — cheapest overall' },
    ],
  },
  {
    id: 'google-llm',
    name: 'Google Gemini',
    kind: 'llm',
    implemented: true,
    envKeys: ['GOOGLE_API_KEY'],
    docs: 'https://ai.google.dev/gemini-api/docs/gemini-3',
    // Every entry below was verified against the live API — thinking support is
    // per-model and does not follow the docs, so unsupported pairings are simply
    // absent and cannot be selected. Notes carry median streaming TTFT over 3
    // runs on a one-sentence reply, so the list doubles as a latency cheat sheet.
    // Ordered fastest-first. Re-measure any time with `npm run gemini:live all`.
    // gemini-2.5-flash / -lite are deliberately absent: they now 404 with
    // "no longer available to new users".
    models: [
      { id: 'gemini-3.1-flash-lite@minimal', name: 'gemini-3.1-flash-lite (minimal)', note: 'Fastest measured — no thinking · ~858ms TTFT, 0 thinking tokens' },
      { id: 'gemini-3.1-flash-lite@off', name: 'gemini-3.1-flash-lite (off)', note: '~953ms TTFT, 0 thinking tokens' },
      { id: 'gemini-3.1-flash-lite@low', name: 'gemini-3.1-flash-lite (low)', note: '~1302ms TTFT, 128 thinking tokens' },
      { id: 'gemini-3.1-flash-lite@medium', name: 'gemini-3.1-flash-lite (medium)', note: '~1478ms TTFT, 121 thinking tokens' },
      { id: 'gemini-3.1-flash-lite@high', name: 'gemini-3.1-flash-lite (high)', note: '~1972ms TTFT, 287 thinking tokens' },
      { id: 'gemini-3.5-flash-lite@minimal', name: 'gemini-3.5-flash-lite (minimal)', note: 'Fastest for this model — no thinking · ~946ms TTFT, 0 thinking tokens' },
      { id: 'gemini-3.5-flash-lite@low', name: 'gemini-3.5-flash-lite (low)', note: '~1395ms TTFT, 0 thinking tokens' },
      { id: 'gemini-3.5-flash-lite@high', name: 'gemini-3.5-flash-lite (high)', note: '~1499ms TTFT, 231 thinking tokens' },
      { id: 'gemini-3.5-flash-lite@medium', name: 'gemini-3.5-flash-lite (medium)', note: '~1700ms TTFT, 192 thinking tokens' },
      { id: 'gemini-3.5-flash@off', name: 'gemini-3.5-flash (off)', note: 'Fastest for this model — no thinking · ~980ms TTFT, 0 thinking tokens' },
      { id: 'gemini-3.5-flash@minimal', name: 'gemini-3.5-flash (minimal)', note: '~1335ms TTFT, 0 thinking tokens' },
      { id: 'gemini-3.5-flash@low', name: 'gemini-3.5-flash (low)', note: '~1670ms TTFT, 203 thinking tokens' },
      { id: 'gemini-3.5-flash@medium', name: 'gemini-3.5-flash (medium)', note: '~2050ms TTFT, 332 thinking tokens' },
      { id: 'gemini-3.5-flash@high', name: 'gemini-3.5-flash (high)', note: '~2147ms TTFT, 316 thinking tokens' },
      { id: 'gemini-3.6-flash@minimal', name: 'gemini-3.6-flash (minimal)', note: 'Fastest for this model — no thinking · ~1160ms TTFT, 0 thinking tokens' },
      { id: 'gemini-3.6-flash@low', name: 'gemini-3.6-flash (low)', note: '~1933ms TTFT, 164 thinking tokens' },
      { id: 'gemini-3.6-flash@high', name: 'gemini-3.6-flash (high)', note: '~2606ms TTFT, 295 thinking tokens' },
      { id: 'gemini-3.6-flash@medium', name: 'gemini-3.6-flash (medium)', note: '~2693ms TTFT, 272 thinking tokens' },
      { id: 'gemini-3.8-flash@off', name: 'gemini-3.8-flash (off)', note: 'Fastest for this model — no thinking · ~1186ms TTFT, 0 thinking tokens' },
      { id: 'gemini-3.8-flash@low', name: 'gemini-3.8-flash (low)', note: '~1283ms TTFT, 0 thinking tokens' },
      { id: 'gemini-3.8-flash@medium', name: 'gemini-3.8-flash (medium)', note: '~2113ms TTFT, 235 thinking tokens' },
      { id: 'gemini-3.8-flash@high', name: 'gemini-3.8-flash (high)', note: '~2409ms TTFT, 277 thinking tokens' },
      { id: 'gemini-3.7-flash@low', name: 'gemini-3.7-flash (low)', note: 'Best of a bad set — this model always thinks · ~1712ms TTFT, 182 thinking tokens' },
      { id: 'gemini-3.7-flash@high', name: 'gemini-3.7-flash (high)', note: '~1868ms TTFT, 314 thinking tokens' },
      { id: 'gemini-3.7-flash@medium', name: 'gemini-3.7-flash (medium)', note: '~1884ms TTFT, 255 thinking tokens' },
      { id: 'gemini-3.7-flash@off', name: 'gemini-3.7-flash (off)', note: 'thinkingBudget 0 is accepted but ignored here · ~2067ms TTFT, 203 thinking tokens' },
    ],
  },
  {
    id: 'groq-llm',
    name: 'Groq',
    kind: 'llm',
    implemented: false,
    envKeys: ['GROQ_API_KEY'],
    docs: 'https://console.groq.com/docs',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'llama-3.3-70b-versatile' },
      { id: 'llama-3.1-8b-instant', name: 'llama-3.1-8b-instant' },
    ],
  },

  /* --------------------------------- TTS --------------------------------- */
  {
    id: 'mock-tts',
    name: 'Mock (tone)',
    kind: 'tts',
    implemented: true,
    envKeys: [],
    models: [{ id: 'mock-voice', name: 'Synthetic tone', note: 'One beep per word. Verifies streaming + barge-in.' }],
    voices: [{ id: 'beep', name: 'Beep tone' }],
  },
  {
    id: 'sarvam-tts',
    name: 'Sarvam Bulbul',
    kind: 'tts',
    implemented: true,
    envKeys: ['SARVAM_API_KEY'],
    docs: 'https://docs.sarvam.ai/api-reference-docs/text-to-speech-streaming/stream',
    models: [
      { id: 'bulbul:v3', name: 'bulbul:v3', note: 'Streaming WS, linear16 @ 24kHz — no transcoding' },
      { id: 'bulbul:v3-beta', name: 'bulbul:v3-beta' },
      { id: 'bulbul:v2', name: 'bulbul:v2', note: 'Previous generation, 7 voices' },
    ],
    languages: [
      { id: 'en-IN', name: 'English (India)' },
      { id: 'hi-IN', name: 'Hindi' },
      { id: 'bn-IN', name: 'Bengali' },
      { id: 'ta-IN', name: 'Tamil' },
      { id: 'te-IN', name: 'Telugu' },
      { id: 'kn-IN', name: 'Kannada' },
      { id: 'ml-IN', name: 'Malayalam' },
      { id: 'mr-IN', name: 'Marathi' },
      { id: 'gu-IN', name: 'Gujarati' },
      { id: 'pa-IN', name: 'Punjabi' },
      { id: 'od-IN', name: 'Odia' },
    ],
    voices: [
      { id: 'shubh', name: 'Shubh (m)' },
      { id: 'aditya', name: 'Aditya (m)' },
      { id: 'rahul', name: 'Rahul (m)' },
      { id: 'rohan', name: 'Rohan (m)' },
      { id: 'amit', name: 'Amit (m)' },
      { id: 'dev', name: 'Dev (m)' },
      { id: 'ratan', name: 'Ratan (m)' },
      { id: 'varun', name: 'Varun (m)' },
      { id: 'manan', name: 'Manan (m)' },
      { id: 'sumit', name: 'Sumit (m)' },
      { id: 'kabir', name: 'Kabir (m)' },
      { id: 'aayan', name: 'Aayan (m)' },
      { id: 'ashutosh', name: 'Ashutosh (m)' },
      { id: 'advait', name: 'Advait (m)' },
      { id: 'anand', name: 'Anand (m)' },
      { id: 'tarun', name: 'Tarun (m)' },
      { id: 'sunny', name: 'Sunny (m)' },
      { id: 'mani', name: 'Mani (m)' },
      { id: 'gokul', name: 'Gokul (m)' },
      { id: 'vijay', name: 'Vijay (m)' },
      { id: 'mohit', name: 'Mohit (m)' },
      { id: 'rehan', name: 'Rehan (m)' },
      { id: 'soham', name: 'Soham (m)' },
      { id: 'ritu', name: 'Ritu (f)' },
      { id: 'priya', name: 'Priya (f)' },
      { id: 'neha', name: 'Neha (f)' },
      { id: 'pooja', name: 'Pooja (f)' },
      { id: 'simran', name: 'Simran (f)' },
      { id: 'kavya', name: 'Kavya (f)' },
      { id: 'ishita', name: 'Ishita (f)' },
      { id: 'shreya', name: 'Shreya (f)' },
      { id: 'roopa', name: 'Roopa (f)' },
      { id: 'tanya', name: 'Tanya (f)' },
      { id: 'shruti', name: 'Shruti (f)' },
      { id: 'suhani', name: 'Suhani (f)' },
      { id: 'kavitha', name: 'Kavitha (f)' },
      { id: 'rupali', name: 'Rupali (f)' },
    ],
  },
  {
    id: 'cartesia-tts',
    name: 'Cartesia Sonic',
    kind: 'tts',
    implemented: true,
    envKeys: ['CARTESIA_API_KEY'],
    docs: 'https://docs.cartesia.ai/api-reference/tts/tts',
    // Sonic streams raw pcm_s16le @ 24kHz — the bench's canonical format — so
    // this leg does no transcoding and no resampling.
    //
    // Voices and languages both hang off the model, from `npm run cartesia:voices`:
    // the library is 934 voices across 44 languages, and which languages a model
    // takes was measured live rather than read off a doc page — sonic-3.6 accepts
    // all 44, sonic-3/3.5 all but Odia and Urdu, sonic-turbo 9, sonic-2 8.
    models: [
      { id: 'sonic-3.6', name: 'sonic-3.6', note: 'Latest — ~174ms TTFB measured · 44 languages', languages: cartesiaLanguages('sonic-3.6') },
      { id: 'sonic-3.5', name: 'sonic-3.5', note: '~149ms TTFB measured · 42 languages', languages: cartesiaLanguages('sonic-3.5') },
      { id: 'sonic-3', name: 'sonic-3', note: '~219ms TTFB measured · 42 languages', languages: cartesiaLanguages('sonic-3') },
      { id: 'sonic-turbo', name: 'sonic-turbo', note: 'Previous gen, ~189ms TTFB · 9 languages', languages: cartesiaLanguages('sonic-turbo') },
      { id: 'sonic-2', name: 'sonic-2', note: 'Previous gen, ~235ms TTFB · 8 languages', languages: cartesiaLanguages('sonic-2') },
    ],
    // Any voice id from the account, including cloned ones and voices grouped
    // under another language — a voice is not bound to the language it is filed
    // under (an English voice speaking Hindi is accepted; measured).
    acceptsVoiceId: true,
    voiceIdHint: 'Any Cartesia voice id — overrides the dropdown, and reaches voices filed under other languages.',
    voicesByLanguage: CARTESIA_VOICES_BY_LANGUAGE,
  },
  {
    id: 'murf-tts',
    name: 'Murf Falcon',
    kind: 'tts',
    implemented: true,
    envKeys: ['MURF_API_KEY'],
    docs: 'https://murf.ai/api/docs/text-to-speech-models/falcon-2',
    // Verified against the live API on 2026-09-05. Two things the docs do not say
    // and one they say wrongly, all measured:
    //   · each model has its own voice catalogue, so the voices hang off the model
    //   · Gen2 is not served by the global websocket host at all — the provider
    //     sends it to api.murf.ai, and it is ~12x slower from here
    //   · the docs' `voiceId: "Namrita"` sample is not a valid streaming voice id;
    //     every real one is locale-prefixed (`en-US-natalie`)
    models: [
      {
        id: 'falcon-2',
        name: 'falcon-2',
        note: '~186ms TTFB measured through the full open+synthesise path — the fastest TTS in this bench',
        voices: MURF_FALCON_VOICES,
        languages: MURF_FALCON_LOCALES,
      },
      {
        id: 'gen2',
        name: 'gen2',
        note: 'Previous generation · ~1.75s TTFB measured — US host only, the global endpoint refuses it',
        voices: MURF_GEN2_VOICES,
        languages: MURF_GEN2_LOCALES,
      },
    ],
    // Beyond the per-model lists above, Murf takes cloned and Voice Library ids.
    acceptsVoiceId: true,
    voiceIdHint: 'Any voice id this model supports — overrides the dropdown. npm run murf:voices refreshes the lists.',
  },
  {
    id: 'gemini-tts',
    name: 'Google Gemini TTS',
    kind: 'tts',
    implemented: true,
    envKeys: ['GOOGLE_API_KEY'],
    docs: 'https://ai.google.dev/gemini-api/docs/speech-generation',
    // The odd one out in this bench: Gemini TTS takes ONE complete text body per
    // request and has no socket to feed tokens into, so PipelineSession's stream
    // of LLM tokens has to be buffered to the end of the turn before synthesis
    // can start. Its TTFB therefore measures a different thing from Cartesia's or
    // Murf's — whole-utterance synthesis, not time to the first frame of a stream
    // — and the two numbers are not comparable. That is a property of the vendor,
    // not of the adapter.
    //
    // Only `gemini-3.1-flash-tts-preview` streams the audio back out, which is
    // the one thing that keeps its first-frame number meaningful; the 2.5 pair
    // return the whole utterance in a single response and are deprecated in
    // Google's favour of the 3.1 model.
    //
    // Nothing here has been exercised against the live API — the project's key
    // answers 429 "prepayment credits are depleted".
    models: [
      {
        id: 'gemini-3.1-flash-tts-preview',
        name: 'gemini-3.1-flash-tts-preview',
        note: 'The only Gemini TTS model that streams audio out (SSE) — the rest return one blob',
        languages: GEMINI_TTS_LOCALES,
      },
      {
        id: 'gemini-2.5-flash-preview-tts',
        name: 'gemini-2.5-flash-preview-tts',
        note: 'One-shot: no audio until the whole utterance is synthesised · deprecated in favour of 3.1',
        languages: GEMINI_TTS_LOCALES,
      },
      {
        id: 'gemini-2.5-pro-preview-tts',
        name: 'gemini-2.5-pro-preview-tts',
        note: 'One-shot, and the priciest of the three · deprecated in favour of 3.1',
        languages: GEMINI_TTS_LOCALES,
      },
    ],
    voices: GEMINI_VOICES,
  },
  {
    id: 'elevenlabs-tts',
    name: 'ElevenLabs',
    kind: 'tts',
    implemented: true,
    envKeys: ['ELEVENLABS_API_KEY'],
    docs: 'https://elevenlabs.io/docs/websockets',
    // Verified live 2026-09-05 on the two models actually exercised:
    // `eleven_flash_v2_5` (426ms TTFB) and `eleven_multilingual_v2` (717ms),
    // median of three, warm socket, one-shot text. `pcm_24000` is served on this
    // account tier. The remaining models' notes still carry ElevenLabs' own
    // published claims rather than measurements — a different kind of fact from
    // the two above, hence the wording.
    // `eleven_v3` is absent because the docs list it as excluded from this
    // endpoint — v3 dialogue is served by /v1/text-to-dialogue/stream-input.
    // `eleven_v3_conversational` is absent for a weaker reason: only `eleven_v3`
    // is *explicitly* excluded, so it might work here, and it is the one model
    // that would give this bench a mid-latency multilingual option. Absent until
    // something proves it, on the "absent beats optimistic" rule.
    models: [
      { id: 'eleven_flash_v2_5', name: 'eleven_flash_v2_5', note: 'Vendor claims ~75ms model latency — unmeasured here · 32 languages' },
      { id: 'eleven_multilingual_v2', name: 'eleven_multilingual_v2', note: 'Vendor positions this as highest quality, slowest · ignores language_code' },
      {
        id: 'eleven_turbo_v2_5',
        name: 'eleven_turbo_v2_5',
        note: 'DEPRECATED by the vendor — "use Flash over Turbo in all use cases"; kept only for comparison',
      },
    ],
    /**
     * These three are ElevenLabs' legacy default voices and they are on a
     * published sunset: the help centre says all default voices expire
     * 2026-12-31 and are ALREADY unavailable on accounts created after March
     * 2026. So on a new account this dropdown is expected to fail, and the
     * free-text voice id below is the working path, not a convenience.
     *
     * The replacement voices are named in the docs but their ids are not
     * published, which is why they are not listed here. The real fix is a
     * generated catalog from GET /v2/voices, the way murf-voices.ts and
     * cartesia-voices.ts already work — this vendor is a stronger case for
     * generation than either, because its ids have an expiry date.
     */
    voices: [
      { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George (legacy default — expires 2026-12-31)' },
      { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (legacy default — expires 2026-12-31)' },
      { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah (legacy default — expires 2026-12-31)' },
    ],
    // ElevenLabs voice ids are opaque 20-character strings and an account's own
    // library is not enumerable from a static table, so the free-text field is
    // the only way to reach a cloned or Voice Library voice.
    acceptsVoiceId: true,
    voiceIdHint: 'Any ElevenLabs voice id — overrides the dropdown. Find one under Voices in the dashboard, or via GET /v1/voices.',
  },
  {
    id: 'openai-tts',
    name: 'OpenAI',
    kind: 'tts',
    implemented: false,
    envKeys: ['OPENAI_API_KEY'],
    docs: 'https://platform.openai.com/docs/guides/text-to-speech',
    models: [
      { id: 'gpt-4o-mini-tts', name: 'gpt-4o-mini-tts' },
      { id: 'tts-1', name: 'tts-1' },
    ],
    voices: [
      { id: 'alloy', name: 'Alloy' },
      { id: 'nova', name: 'Nova' },
      { id: 'shimmer', name: 'Shimmer' },
    ],
  },
  {
    id: 'deepgram-tts',
    name: 'Deepgram Aura',
    kind: 'tts',
    implemented: false,
    envKeys: ['DEEPGRAM_API_KEY'],
    docs: 'https://developers.deepgram.com/docs/tts-streaming',
    models: [
      { id: 'aura-2-thalia-en', name: 'aura-2 (Thalia)' },
      { id: 'aura-2-apollo-en', name: 'aura-2 (Apollo)' },
    ],
  },
];

export function byKind(kind: ProviderKind): ProviderEntry[] {
  return CATALOG.filter((p) => p.kind === kind);
}

export function findProvider(id: string): ProviderEntry | undefined {
  return CATALOG.find((p) => p.id === id);
}

function modelEntry(providerId: string, modelId?: string): ModelEntry | undefined {
  const provider = findProvider(providerId);
  if (!provider) return undefined;
  return modelId ? provider.models.find((m) => m.id === modelId) : provider.models[0];
}

/**
 * Voices for a provider/model/language triple, narrowest list first: the selected
 * language's own voices, else the model's, else the provider's.
 *
 * Both narrowings are real vendor behaviour, not tidiness. Murf rejects a voice
 * that belongs to its other model outright, and Cartesia's 934 voices are only
 * navigable once a language has been picked.
 */
export function voicesFor(providerId: string, modelId?: string, languageId?: string): ModelEntry[] {
  const provider = findProvider(providerId);
  const model = modelEntry(providerId, modelId);
  const byLanguage = provider?.voicesByLanguage;
  // An unknown or absent language falls back to the first the model offers, so a
  // caller that does not track language still gets a list rather than nothing.
  const language =
    model?.languages?.find((l) => l.id === languageId) ??
    model?.languages?.find((l) => l.voices?.length || byLanguage?.[l.id]?.length);
  return (
    language?.voices ??
    (language ? byLanguage?.[language.id] : undefined) ??
    model?.voices ??
    provider?.voices ??
    []
  );
}

/** Languages for a provider/model pair, same precedence as `voicesFor`. */
export function languagesFor(providerId: string, modelId?: string): ModelEntry[] {
  return modelEntry(providerId, modelId)?.languages ?? findProvider(providerId)?.languages ?? [];
}

/** Catalog + whether the required env vars are actually present in this process. */
export function catalogWithReadiness() {
  return CATALOG.map((p) => ({
    ...p,
    missingEnv: p.envKeys.filter((k) => !process.env[k]),
    ready: p.implemented && p.envKeys.every((k) => !!process.env[k]),
  }));
}
