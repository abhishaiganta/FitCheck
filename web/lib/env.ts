// Server-only configuration. Nothing here is ever sent to the browser.
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const env = {
  get DATABASE_URL() { return process.env.DATABASE_URL ?? ''; },
  get DATABASE_URL_DEMO() { return process.env.DATABASE_URL_DEMO ?? ''; },
  get DEMO_MODE() { return process.env.DEMO_MODE === '1'; },
  get DB_TIMEOUT_MS() { return num(process.env.DB_TIMEOUT_MS, 8000); },

  get GEMINI_API_KEYS() { return list(process.env.GEMINI_API_KEYS); },
  // "-latest" aliases keep working when Google retires dated ids; override in env to pin.
  get GEMINI_MODEL_FAST() { return process.env.GEMINI_MODEL_FAST || 'gemini-flash-lite-latest'; },
  get GEMINI_MODEL_VISION() { return process.env.GEMINI_MODEL_VISION || 'gemini-flash-latest'; },
  get GEMINI_EMBED_MODEL() { return process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001'; },
  get EMBED_DIM() { return num(process.env.EMBED_DIM, 768); },
  get GEMINI_RPM_PARSE() { return num(process.env.GEMINI_RPM_PARSE, 20); },
  get GEMINI_RPD() { return num(process.env.GEMINI_RPD, 900); },

  get ELEVENLABS_API_KEY() { return process.env.ELEVENLABS_API_KEY ?? ''; },
  get ELEVENLABS_STT_MODEL() { return process.env.ELEVENLABS_STT_MODEL || 'scribe_v1'; },
  get ELEVENLABS_TTS_MODEL() { return process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5'; },
  get ELEVENLABS_VOICE_ID() { return process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; },

  get BLOB_READ_WRITE_TOKEN() { return process.env.BLOB_READ_WRITE_TOKEN ?? ''; },
  get SITE_URL() { return (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, ''); },
  get ORIGIN_LAT() { return num(process.env.ORIGIN_LAT, 32.8801); },
  get ORIGIN_LNG() { return num(process.env.ORIGIN_LNG, -117.2376); },
  get FUEL_USD_PER_MI() { return num(process.env.FUEL_USD_PER_MI, 0.15); },

  get ADMIN_TOKEN() { return process.env.ADMIN_TOKEN ?? ''; },
  get BRIGHTDATA_API_TOKEN() { return process.env.BRIGHTDATA_API_TOKEN ?? ''; },
  get BD_UNLOCKER_ZONE() { return process.env.BD_UNLOCKER_ZONE ?? ''; },

  /** Car-fit badges are off unless CAR_FIT=1 (the cars table is not loaded yet). */
  get CAR_FIT() { return process.env.CAR_FIT === '1'; },

  /** direct (one Gemini function call, default, ~1 s) | agent (Mastra, slower) | keyword (no LLM) */
  get SEARCH_ENGINE() { return (process.env.SEARCH_ENGINE || 'direct') as 'agent' | 'direct' | 'keyword'; },
  get AGENT_TIMEOUT_MS() { return num(process.env.AGENT_TIMEOUT_MS, 7000); },
  get AGENT_MEMORY() { return process.env.AGENT_MEMORY !== '0'; },
};
