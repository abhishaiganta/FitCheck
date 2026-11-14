"""Shrink a heavy GLB with glTF-Transform + meshoptimizer (worker/meshtools/shrink.mjs).

One-time setup: `npm install --prefix worker/meshtools`.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent / "meshtools"


class ShrinkError(Exception):
    pass


def shrink_glb(data: bytes, max_tris: int = 150_000, max_tex: int = 2048, timeout: float = 300) -> tuple[bytes, dict]:
    if not (HERE / "node_modules" / "@gltf-transform" / "core").exists():
        raise ShrinkError("glTF-Transform is not installed: run `npm install --prefix worker/meshtools`")
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.glb", Path(tmp) / "out.glb"
        src.write_bytes(data)
        p = subprocess.run(["node", str(HERE / "shrink.mjs"), str(src), str(dst), "--max-tris", str(max_tris),
                            "--max-tex", str(max_tex)], capture_output=True, text=True, timeout=timeout)
        if p.returncode != 0 or not dst.exists():
            raise ShrinkError((p.stderr or p.stdout).strip()[-600:] or f"shrink exited {p.returncode}")
        stats = json.loads(p.stdout.strip().splitlines()[-1])
        return dst.read_bytes(), stats
