import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

/** Typed error used by every route. Never carries keys or stack traces to the client. */
export class AppError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  detail?: unknown;
  constructor(code: string, message: string, status = 500, opts: { retryable?: boolean; detail?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.code = code;
    this.status = status;
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail;
  }
}

export const err = {
  badRequest: (message: string, detail?: unknown) => new AppError('bad_request', message, 400, { detail }),
  unauthorized: () => new AppError('unauthorized', 'Admin token missing or wrong.', 401),
  notFound: (what = 'That item') => new AppError('not_found', `${what} was not found.`, 404),
  rateLimited: (message = 'Too many requests. Wait a few seconds and try again.') =>
    new AppError('rate_limited', message, 429, { retryable: true }),
  quota: (provider: string) => new AppError('quota_exceeded', `${provider} is out of quota right now.`, 503, { retryable: true }),
  upstream: (provider: string, message: string, retryable = true, detail?: unknown) =>
    new AppError(`${provider}_error`, message, retryable ? 503 : 502, { retryable, detail }),
  notConfigured: (what: string) => new AppError('not_configured', `${what} is not set up on this server.`, 503),
  db: (cause?: unknown) =>
    new AppError('db_unreachable', "Can't reach listings right now.", 503, { retryable: true, cause }),
};

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ZodError) {
    const first = e.issues[0];
    const path = first?.path?.join('.') ?? '';
    return err.badRequest(path ? `Invalid "${path}": ${first.message}` : (first?.message ?? 'Invalid request.'), e.issues);
  }
  if (e instanceof SyntaxError) return err.badRequest('Request body is not valid JSON.');
  return new AppError('internal', 'Something went wrong on our side. Try again.', 500, { cause: e });
}

export function errorJson(e: unknown) {
  const a = toAppError(e);
  return { error: { code: a.code, message: a.message, retryable: a.retryable } };
}

export function errorResponse(e: unknown, headers?: Record<string, string>) {
  const a = toAppError(e);
  return NextResponse.json(errorJson(a), { status: a.status, headers });
}

/** Never throws. Writes to the console and, best effort, to error_log. */
export function logError(where: string, e: unknown, extra: { listing_id?: number; detail?: unknown } = {}) {
  const a = toAppError(e);
  const cause = (a.cause ?? e) as { message?: string } | undefined;
  const message = a.code === 'internal' ? String(cause?.message ?? e) : a.message;
  console.error(`[${where}] ${a.code}: ${message}`);
  if (a.code === 'db_unreachable' || a.status === 400 || a.status === 404 || a.status === 429) return; // no point / noise
  import('./db')
    .then(({ query }) =>
      query(
        'insert into error_log (where_, listing_id, code, message, detail) values ($1,$2,$3,$4,$5::jsonb)',
        [where, extra.listing_id ?? null, a.code, message.slice(0, 500), JSON.stringify(scrub(extra.detail ?? a.detail ?? null))],
        { branch: 'main', timeoutMs: 3000 },
      ),
    )
    .catch(() => {});
}

function scrub(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null).replace(/(key|token|authorization)("?\s*[:=]\s*"?)[^",}\s]+/gi, '$1$2[redacted]').slice(0, 4000));
  } catch {
    return null;
  }
}

/** Wraps a route handler: consistent error JSON, logging, no leaked internals. */
export function route<A extends unknown[]>(where: string, fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      logError(where, e);
      return errorResponse(e);
    }
  };
}
