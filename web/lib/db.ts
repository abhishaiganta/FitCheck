import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { env } from './env';
import { AppError, err } from './errors';

export type Branch = 'main' | 'demo';
export type Row = Record<string, any>;

/** Search and item pages read the frozen demo branch in DEMO_MODE; the pipeline board always reads main. */
export function readBranch(): Branch {
  return env.DEMO_MODE && env.DATABASE_URL_DEMO ? 'demo' : 'main';
}

function urlFor(branch: Branch) {
  const url = branch === 'demo' ? env.DATABASE_URL_DEMO || env.DATABASE_URL : env.DATABASE_URL;
  if (!url) throw err.db(new Error(`DATABASE_URL${branch === 'demo' ? '_DEMO' : ''} is not set`));
  return url;
}

type G = typeof globalThis & {
  __lr_neon?: Map<string, NeonQueryFunction<false, false>>;
  __lr_pglite?: Promise<{ query: (t: string, p?: unknown[]) => Promise<{ rows: Row[] }> }>;
};
const g = globalThis as G;

/** In-process Postgres (pglite + pgvector) seeded with fixtures. Used by tests and `npm run dev:fixtures`. */
async function pglite() {
  if (!g.__lr_pglite) {
    g.__lr_pglite = (async () => {
      const [{ PGlite }, { vector }, fs, path] = await Promise.all([
        import('@electric-sql/pglite'),
        import('@electric-sql/pglite-pgvector'),
        import('node:fs/promises'),
        import('node:path'),
      ]);
      const db = new PGlite({ extensions: { vector } });
      const dir = path.join(process.cwd(), 'tests', 'fixtures');
      await db.exec(await fs.readFile(path.join(dir, 'schema.sql'), 'utf8'));
      await db.exec(await fs.readFile(path.join(dir, 'fixtures.sql'), 'utf8'));
      return db as any;
    })();
    g.__lr_pglite.catch(() => { g.__lr_pglite = undefined; });
  }
  return g.__lr_pglite;
}

/** Test hook: drop the in-process database so the next query re-seeds it. */
export function resetFixtureDb() { g.__lr_pglite = undefined; }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`database timeout after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Postgres errors that mean "your SQL/data is wrong", not "the database is down". */
function isQueryError(e: any) {
  const code = String(e?.code ?? '');
  return /^(22|23|42)/.test(code);
}

export async function query<T extends Row = Row>(
  text: string,
  params: unknown[] = [],
  opts: { branch?: Branch; timeoutMs?: number } = {},
): Promise<T[]> {
  const branch = opts.branch ?? 'main';
  const timeoutMs = opts.timeoutMs ?? env.DB_TIMEOUT_MS;
  let url: string;
  try {
    url = urlFor(branch);
  } catch (e) {
    throw e;
  }
  try {
    if (url.startsWith('pglite:')) {
      const db = await pglite();
      return (await withTimeout(db.query(text, params), timeoutMs)).rows as T[];
    }
    g.__lr_neon ??= new Map();
    let sql = g.__lr_neon.get(url);
    if (!sql) {
      sql = neon(url);
      g.__lr_neon.set(url, sql);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return (await withTimeout(sql.query(text, params as any[], { fetchOptions: { signal: ctl.signal } }), timeoutMs + 250)) as T[];
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (isQueryError(e)) throw new AppError('db_query', 'A database query failed.', 500, { cause: e });
    throw err.db(e);
  }
}

export const toVector = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? +x.toFixed(6) : 0)).join(',')}]`;
