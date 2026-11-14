"""Worker configuration: everything comes from worker/.env (never committed)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = Path(__file__).resolve().parent
load_dotenv(WORKER_DIR / ".env")
load_dotenv(ROOT / ".env")


def _csv(name: str) -> list[str]:
    return [x.strip() for x in os.getenv(name, "").split(",") if x.strip()]


def _f(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        return default


CATEGORY_ALLOWLIST = [
    "side_table", "nightstand", "coffee_table", "desk_lamp", "floor_lamp", "stool",
    "ottoman", "accent_chair", "dining_chair", "dresser", "bookshelf", "desk",
]

SEARCH_KEYWORDS = [
    "side table", "nightstand", "desk lamp", "floor lamp", "stool", "accent chair",
    "dresser", "bookshelf", "ottoman", "coffee table",
]


@dataclass
class Settings:
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL_DIRECT") or os.getenv("DATABASE_URL", ""))
    database_url_demo: str = field(default_factory=lambda: os.getenv("DATABASE_URL_DEMO", ""))
    bd_token: str = field(default_factory=lambda: os.getenv("BRIGHTDATA_API_TOKEN", ""))
    bd_fb: str = field(default_factory=lambda: os.getenv("BD_DATASET_FB_MARKETPLACE", ""))
    bd_ebay: str = field(default_factory=lambda: os.getenv("BD_DATASET_EBAY", ""))
    bd_zone: str = field(default_factory=lambda: os.getenv("BD_UNLOCKER_ZONE", ""))
    gemini_keys: list[str] = field(default_factory=lambda: _csv("GEMINI_API_KEYS"))
    gemini_vision: str = field(default_factory=lambda: os.getenv("GEMINI_MODEL_VISION", "gemini-3.6-flash,gemini-3.5-flash,gemini-3.8-flash,gemini-3.5-flash-lite"))
    gemini_embed: str = field(default_factory=lambda: os.getenv("GEMINI_EMBED_MODEL", "gemini-embedding-001"))
    embed_dim: int = field(default_factory=lambda: int(os.getenv("EMBED_DIM", "768")))
    tripo_keys: list[str] = field(default_factory=lambda: _csv("TRIPO_API_KEYS"))
    meshy_keys: list[str] = field(default_factory=lambda: _csv("MESHY_API_KEYS"))
    hf_tokens: list[str] = field(default_factory=lambda: _csv("HF_TOKENS"))
    hf_space: str = field(default_factory=lambda: os.getenv("HF_SPACE_IMAGE_TO_3D", ""))
    blob_token: str = field(default_factory=lambda: os.getenv("BLOB_READ_WRITE_TOKEN", ""))
    elevenlabs_key: str = field(default_factory=lambda: os.getenv("ELEVENLABS_API_KEY", ""))
    site_url: str = field(default_factory=lambda: os.getenv("SITE_URL") or os.getenv("NEXT_PUBLIC_SITE_URL", ""))
    origin_lat: float = field(default_factory=lambda: _f("ORIGIN_LAT", 32.8801))
    origin_lng: float = field(default_factory=lambda: _f("ORIGIN_LNG", -117.2376))
    # caps (spec section 5; tune after checking each provider's dashboard)
    gemini_vision_rpm: int = field(default_factory=lambda: int(_f("GEMINI_VISION_RPM", 8)))
    gemini_vision_rpd: int = field(default_factory=lambda: int(_f("GEMINI_VISION_RPD", 400)))
    gemini_embed_rpm: int = field(default_factory=lambda: int(_f("GEMINI_EMBED_RPM", 60)))
    gemini_embed_rpd: int = field(default_factory=lambda: int(_f("GEMINI_EMBED_RPD", 900)))
    hf_per_day: int = 3
    scrape_cap_per_source: int = field(default_factory=lambda: int(_f("SCRAPE_CAP", 150)))
    scrape_min_interval_min: int = 30
    max_attempts: int = 3
    lock_minutes: int = 10
    max_file_mb: float = 15.0


def get_settings() -> Settings:
    return Settings()
