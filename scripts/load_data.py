"""Load the team's data files into Neon (spec section 13).

    python -m scripts.load_data            # data/cars.csv -> cars

data/geo_sd.json is read from disk by both the worker and the web app, so it needs no loading.
"""
from __future__ import annotations

import csv

from worker.config import ROOT
from worker.db import DB


def load_cars(db: DB, path=None) -> int:
    path = path or ROOT / "data" / "cars.csv"
    n = 0
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            key = row["make_model"].strip().lower()
            if not key or not row.get("source_url", "").startswith("http"):
                raise SystemExit(f"cars.csv: row '{key}' needs a source_url")
            db.x("""insert into cars (make_model, cargo_w_in, cargo_h_in, cargo_d_in, seats_folded_d_in, source_url)
                    values (%s,%s,%s,%s,%s,%s)
                    on conflict (make_model) do update set cargo_w_in = excluded.cargo_w_in, cargo_h_in = excluded.cargo_h_in,
                      cargo_d_in = excluded.cargo_d_in, seats_folded_d_in = excluded.seats_folded_d_in,
                      source_url = excluded.source_url""",
                 (key, float(row["cargo_w_in"]), float(row["cargo_h_in"]), float(row["cargo_d_in"]),
                  float(row["seats_folded_d_in"]), row["source_url"].strip()))
            n += 1
    return n


if __name__ == "__main__":
    d = DB()
    try:
        print(f"cars: {load_cars(d)} rows")
    finally:
        d.close()
