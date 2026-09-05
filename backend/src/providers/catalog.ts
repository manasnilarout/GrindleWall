/**
 * The catalog is the single source of truth the frontend renders its toggles from.
 * `implemented: false` entries are visible but disabled — they are the queue of
 * providers waiting to be hooked in.
 */

export type ProviderKind = 'realtime' | 'stt' | 'llm' | 'tts';

export interface ModelEntry {
  id: string;
  name: string;
  note?: string;
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
  /** Languages, where the provider requires one to be named up front. */
  languages?: ModelEntry[];
  docs?: string;
}

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
    implemented: false,
    envKeys: ['OPENAI_API_KEY'],
    docs: 'https://platform.openai.com/docs/guides/realtime',
    models: [
      { id: 'gpt-realtime', name: 'gpt-realtime' },
      { id: 'gpt-4o-realtime-preview', name: 'gpt-4o-realtime-preview' },
      { id: 'gpt-4o-mini-realtime-preview', name: 'gpt-4o-mini-realtime-preview' },
    ],
    voices: [
      { id: 'marin', name: 'Marin' },
      { id: 'cedar', name: 'Cedar' },
      { id: 'alloy', name: 'Alloy' },
      { id: 'shimmer', name: 'Shimmer' },
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
    implemented: false,
    envKeys: ['OPENAI_API_KEY'],
    docs: 'https://platform.openai.com/docs/api-reference/chat',
    models: [
      { id: 'gpt-4o', name: 'gpt-4o' },
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
      { id: 'gpt-4.1-mini', name: 'gpt-4.1-mini' },
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
    // Model ids and voice ids below were all confirmed against the live API.
    // Sonic streams raw pcm_s16le @ 24kHz — the bench's canonical format — so
    // this leg does no transcoding and no resampling.
    models: [
      { id: 'sonic-3.6', name: 'sonic-3.6', note: 'Latest — ~174ms TTFB measured' },
      { id: 'sonic-3.5', name: 'sonic-3.5', note: '~149ms TTFB measured' },
      { id: 'sonic-3', name: 'sonic-3', note: '~219ms TTFB measured' },
      { id: 'sonic-turbo', name: 'sonic-turbo', note: 'Previous gen, ~189ms TTFB' },
      { id: 'sonic-2', name: 'sonic-2', note: 'Previous gen, ~235ms TTFB' },
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
    voices: [
      { id: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', name: 'Skylar', note: 'friendly guide' },
      { id: '47c38ca4-5f35-497b-b1a3-415245fb35e1', name: 'Daniel', note: 'modern assistant' },
      { id: '62ae83ad-4f6a-430b-af41-a9bede9286ca', name: 'Gemma', note: 'decisive agent' },
      { id: '30894953-bcce-41fe-892c-15ce19c843ff', name: 'Parker', note: 'supportive pal' },
      { id: 'ef191366-f52f-447a-a398-ed8c0f2943a1', name: 'Archie', note: 'approachable mate' },
      { id: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc', name: 'Jacqueline', note: 'reassuring agent' },
      { id: 'b24f41fd-00a3-4cd8-992a-a0c9f13f3ef1', name: 'Clive', note: 'measured expert' },
      { id: '2a12b36c-7f9b-4c3a-9f7a-72731b15323a', name: 'Ella', note: 'caring scout' },
    ],
  },
  {
    id: 'murf-tts',
    name: 'Murf Falcon',
    kind: 'tts',
    implemented: true,
    envKeys: ['MURF_API_KEY'],
    docs: 'https://murf.ai/api/docs/text-to-speech-models/falcon-2',
    // UNVERIFIED: written without an API key, so the voice ids and locales below
    // come from Murf's docs rather than from the live API. Correct them in one
    // step with `npm run murf:voices`, which prints a paste-ready block; resolve
    // the request-shape ambiguities with `npm run murf:probe`.
    models: [
      { id: 'falcon-2', name: 'falcon-2', note: 'Falcon 2 — Murf claims ~100ms time-to-first-audio' },
      { id: 'gen2', name: 'gen2', note: 'Previous generation' },
    ],
    languages: [
      { id: 'en-US', name: 'English (US)' },
      { id: 'en-UK', name: 'English (UK)' },
      { id: 'en-IN', name: 'English (India)' },
      { id: 'en-AU', name: 'English (Australia)' },
      { id: 'hi-IN', name: 'Hindi' },
      { id: 'ta-IN', name: 'Tamil' },
      { id: 'bn-IN', name: 'Bengali' },
      { id: 'es-ES', name: 'Spanish' },
      { id: 'es-MX', name: 'Spanish (Mexico)' },
      { id: 'fr-FR', name: 'French' },
      { id: 'de-DE', name: 'German' },
      { id: 'it-IT', name: 'Italian' },
      { id: 'pt-BR', name: 'Portuguese (Brazil)' },
      { id: 'nl-NL', name: 'Dutch' },
      { id: 'zh-CN', name: 'Chinese' },
      { id: 'ja-JP', name: 'Japanese' },
      { id: 'ko-KR', name: 'Korean' },
    ],
    voices: [
      { id: 'en-US-natalie', name: 'Natalie (en-US)' },
      { id: 'en-US-terrell', name: 'Terrell (en-US)' },
      { id: 'en-US-miles', name: 'Miles (en-US)' },
      { id: 'en-US-amara', name: 'Amara (en-US)' },
      { id: 'en-UK-hazel', name: 'Hazel (en-UK)' },
      { id: 'en-UK-theo', name: 'Theo (en-UK)' },
      { id: 'en-IN-aarav', name: 'Aarav (en-IN)' },
      { id: 'en-IN-alia', name: 'Alia (en-IN)' },
      { id: 'en-AU-jimm', name: 'Jimm (en-AU)' },
    ],
  },
  {
    id: 'elevenlabs-tts',
    name: 'ElevenLabs',
    kind: 'tts',
    implemented: false,
    envKeys: ['ELEVENLABS_API_KEY'],
    docs: 'https://elevenlabs.io/docs/websockets',
    models: [
      { id: 'eleven_flash_v2_5', name: 'eleven_flash_v2_5', note: '~75ms model latency' },
      { id: 'eleven_turbo_v2_5', name: 'eleven_turbo_v2_5' },
      { id: 'eleven_multilingual_v2', name: 'eleven_multilingual_v2', note: 'Highest quality, slowest' },
    ],
    voices: [
      { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' },
      { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
      { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
    ],
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

/** Catalog + whether the required env vars are actually present in this process. */
export function catalogWithReadiness() {
  return CATALOG.map((p) => ({
    ...p,
    missingEnv: p.envKeys.filter((k) => !process.env[k]),
    ready: p.implemented && p.envKeys.every((k) => !!process.env[k]),
  }));
}
