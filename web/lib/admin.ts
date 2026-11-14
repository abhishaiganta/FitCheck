import { timingSafeEqual } from 'node:crypto';
import { env } from './env';
import { err } from './errors';

/** Admin routes need `Authorization: Bearer <ADMIN_TOKEN>` (or x-admin-token). Closed when no token is set. */
export function requireAdmin(req: Request) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) throw err.notConfigured('ADMIN_TOKEN');
  const got = (req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.headers.get('x-admin-token') ?? '').trim();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw err.unauthorized();
}
