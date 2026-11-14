"""Apply /db/*.sql in order. Idempotent (every migration is written to be re-runnable).

    python -m scripts.migrate                 # main branch (DATABASE_URL_DIRECT)
    python -m scripts.seed_demo               # afterwards, optional: FAKE fixture rows for Person B
    python -m scripts.migrate --url <conn>    # another branch, e.g. a Neon test branch
"""
from __future__ import annotations

import argparse

from worker.config import ROOT
from worker.db import connect


def apply(url: str | None = None, fixtures: bool = False, quiet: bool = False, schema: str | None = None) -> list[str]:
    done = []
    conn = connect(url, schema=schema)
    try:
        conn.execute("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())")
        for path in sorted((ROOT / "db").glob("*.sql")):
            if "fixtures" in path.name:
                continue        # fake rows are loaded only by scripts.seed_demo (it fills in the hosted URLs)
            sql = path.read_text(encoding="utf-8")
            with conn.transaction():
                conn.execute(sql)   # simple-query protocol: several statements per file are fine
                conn.execute("insert into schema_migrations (name) values (%s) on conflict (name) do update set applied_at = now()",
                             (path.name,))
            done.append(path.name)
            if not quiet:
                print(f"applied {path.name}")
    finally:
        conn.close()
    return done


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    a = ap.parse_args()
    apply(a.url)
