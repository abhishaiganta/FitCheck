"""Create or refresh the Neon `demo` branch from `main` (spec section 4), once demo items are ready.

With DEMO_MODE=1 the web app reads the frozen demo branch (DATABASE_URL_DEMO) while the worker keeps
writing to main, so judges see stable results and a live pipeline board at the same time.

    python -m scripts.branch_demo             # needs NEON_API_KEY and NEON_PROJECT_ID in worker/.env
    python -m scripts.branch_demo --dry-run

Neon API v2 (https://api-docs.neon.tech): list branches, create a branch with a read-write endpoint,
or reset an existing branch to its parent's head (restore), then read the pooled connection URI.
Console alternative: Branches -> "demo" -> Reset from parent (or Create branch from main),
then Connect -> pooled connection string -> DATABASE_URL_DEMO in Vercel and worker/.env.
"""
from __future__ import annotations

import argparse
import os
import sys

import httpx

from worker.config import get_settings  # noqa: F401 - loads worker/.env
from worker.db import connect

API = "https://console.neon.tech/api/v2"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="demo")
    ap.add_argument("--database", default="neondb")
    ap.add_argument("--role", default="neondb_owner")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-fixtures", action="store_true", help="skip the 'no fake rows' guard")
    a = ap.parse_args()
    key, project = os.getenv("NEON_API_KEY", ""), os.getenv("NEON_PROJECT_ID", "")
    if not key or not project:
        print("NEON_API_KEY / NEON_PROJECT_ID are not set in worker/.env.\n"
              "Create a key at console.neon.tech -> Account settings -> API keys, or do it in the console:\n"
              "  Branches -> demo -> Reset from parent (or Create branch from main)\n"
              "  Connect -> pooled connection string -> DATABASE_URL_DEMO")
        return 2

    # guard: the demo branch must not contain fake rows
    conn = connect()
    fixtures = conn.execute("select count(*) n from listings where external_id like 'fixture-%'").fetchone()["n"]
    ready = conn.execute("""select count(*) n from listings l join assets a on a.listing_id = l.id
                            where l.demo_pin and a.status = 'ready' and not a.is_approx_model""").fetchone()["n"]
    conn.close()
    print(f"main has {ready} demo_pin items ready with real models, {fixtures} fixture listings")
    if fixtures and not a.allow_fixtures:
        print("Refusing: run `python -m scripts.drop_fixtures` first (or pass --allow-fixtures for a rehearsal).")
        return 1

    c = httpx.Client(timeout=60, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})

    def call(method: str, path: str, **kw) -> dict:
        r = c.request(method, f"{API}{path}", **kw)
        if r.status_code >= 400:
            raise SystemExit(f"Neon API {method} {path} -> {r.status_code}: {r.text[:300]}")
        return r.json()

    branches = call("GET", f"/projects/{project}/branches")["branches"]
    parent = next((b for b in branches if b.get("default") or b.get("primary") or b["name"] in ("main", "production")), None)
    if not parent:
        raise SystemExit("could not find the default (main) branch")
    demo = next((b for b in branches if b["name"] == a.name), None)
    if a.dry_run:
        print(f"dry run: would {'reset' if demo else 'create'} branch '{a.name}' from '{parent['name']}'")
        return 0
    if demo:
        call("POST", f"/projects/{project}/branches/{demo['id']}/restore", json={"source_branch_id": parent["id"]})
        print(f"branch '{a.name}' reset to the head of '{parent['name']}'")
    else:
        demo = call("POST", f"/projects/{project}/branches",
                    json={"branch": {"name": a.name, "parent_id": parent["id"]},
                          "endpoints": [{"type": "read_write"}]})["branch"]
        print(f"branch '{a.name}' created from '{parent['name']}'")
    uri = call("GET", f"/projects/{project}/connection_uri",
               params={"branch_id": demo["id"], "database_name": a.database, "role_name": a.role, "pooled": "true"})["uri"]
    # the URI contains the password: write it to the env file, never to the terminal
    env = os.path.join(os.path.dirname(__file__), "..", "worker", ".env")
    lines = open(env, encoding="utf-8").read().splitlines() if os.path.exists(env) else []
    lines = [ln for ln in lines if not ln.startswith("DATABASE_URL_DEMO=")] + [f"DATABASE_URL_DEMO={uri}"]
    with open(env, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print("DATABASE_URL_DEMO written to worker/.env. Copy the same value into Vercel (DATABASE_URL_DEMO, DEMO_MODE=1),\n"
          "redeploy, then run `python -m scripts.demo_check`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
