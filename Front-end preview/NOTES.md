# LiveRoom implementation notes

This revision owns the buyer frontend. It retains the existing Vite deployment and can be connected to a separately deployed Next.js API by setting VITE_API_BASE to that API's HTTPS origin at build time. Supply CORS on the API if it is served separately. Keep all provider credentials server-side.

## Buyer API contract

- POST /api/search accepts JSON `{text}` and returns `{results: Item[], spoken_summary?: string}`. See src/buyer.ts for the card type. Convert database rows to that shape at the server boundary.
- GET /api/item/:id returns an Item for QR visits. Include hosted USDZ and GLB URLs for ready items.
- POST /api/stt accepts multipart audio (field audio, native Safari MP4 when selected by MediaRecorder) and returns `{text}`.
- POST /api/tts accepts JSON `{text}` and returns `{url}` for playable audio.
- GET /api/pipeline returns `{counts, events}`. Read the main branch for this endpoint.
- POST /api/impact takes `{listing_id, kind}`.

The bundled collection is clearly marked sample inventory. Real matched items, car catalog, ElevenLabs, Mastra, Bright Data, Neon connectivity, worker and live pipeline are team integration work. db/001_init.sql is the supplied schema extracted into a migration; it has not been applied to Neon. Quick Look needs HTTPS and a compatible device, and its custom banner must be tested on the physical phone. Keep local fixtures out of the judging database.
