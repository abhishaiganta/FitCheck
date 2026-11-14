import { NextResponse } from 'next/server';
import { z } from 'zod';
import { textToSpeech } from '@/lib/elevenlabs';
import { route } from '@/lib/errors';
import { checkIpLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Body = z.object({ text: z.string().trim().min(1).max(400) });

/** Text in, MP3 out (ElevenLabs low-latency model), cached by text hash. */
export const POST = route('api.tts', async (req: Request) => {
  checkIpLimit(req, 'tts', 30);
  const { text } = Body.parse(await req.json());
  const out = await textToSpeech(text);
  if (out.url) return NextResponse.redirect(out.url, 303);
  return new Response(new Uint8Array(out.audio!), {
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'private, max-age=3600',
      'x-tts-cache': out.cached ? 'hit' : 'miss',
    },
  });
});
