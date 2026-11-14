"""Shared handles for one worker process. Everything is lazy so `--stages tag` never launches Chromium."""
from __future__ import annotations

import threading
from dataclasses import dataclass, field

from .brightdata import BrightData
from .config import Settings, get_settings
from .db import DB
from .limits import Limits, PgStore
from .storage import Storage


@dataclass
class Ctx:
    settings: Settings = field(default_factory=get_settings)
    db: DB = None  # type: ignore[assignment]
    limits: Limits = None  # type: ignore[assignment]
    storage: Storage = None  # type: ignore[assignment]
    bd: BrightData = None  # type: ignore[assignment]
    stop: threading.Event = field(default_factory=threading.Event)
    _gemini: object = None
    _exporter: object = None
    _providers: list | None = None
    _rembg: object = None

    def __post_init__(self) -> None:
        if self.db is None:
            self.db = DB(self.settings.database_url)
        if self.limits is None:
            self.limits = Limits(PgStore(self.db))
        if self.storage is None:
            self.storage = Storage(self.settings.blob_token)
        if self.bd is None:
            self.bd = BrightData(self.settings.bd_token)

    @property
    def gemini(self):
        if self._gemini is None:
            from .tagging import Gemini
            self._gemini = Gemini(self.limits, self.settings)
        return self._gemini

    @property
    def exporter(self):
        if self._exporter is None:
            from .exporter_driver import Exporter
            self._exporter = Exporter()
            self._exporter.start()
        return self._exporter

    @property
    def providers(self) -> list:
        if self._providers is None:
            from .providers import build_chain
            self._providers = build_chain(self.settings)
        return self._providers

    def close(self) -> None:
        if self._exporter is not None:
            self._exporter.close()
            self._exporter = None
        self.db.close()
