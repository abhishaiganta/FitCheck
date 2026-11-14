"""GLB fixtures built in code (no binary files in the repo)."""
from __future__ import annotations

import io

from PIL import Image, ImageDraw

from worker.glbtools import Part, box, build_glb, part


def checker_png(size: int = 256) -> bytes:
    img = Image.new("RGB", (size, size), (196, 148, 96))
    d = ImageDraw.Draw(img)
    step = size // 8
    for y in range(8):
        for x in range(8):
            if (x + y) % 2:
                d.rectangle([x * step, y * step, (x + 1) * step, (y + 1) * step], fill=(150, 104, 62))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def messy_table_glb() -> bytes:
    """A 20 W x 16 D x 24 H inch nightstand, made deliberately awkward (spec section 9):
    - wrong units: built in centimetre-ish numbers x10 (240 units tall instead of 0.61 m)
    - lying sideways: its height runs along X
    - off-centre: pivot ~1000 units away from the mesh
    - textured, with the metallic factor omitted (glTF default = 1.0)
    """
    body = part(box(240, 200, 160, center=(900, 350, -700)), color=(1, 1, 1), metallic=None, roughness=0.2,
                texture_png=checker_png(), name="body")
    return build_glb([body])


def upright_lamp_glb() -> bytes:
    """Already upright, tiny (metres), untextured: 8 x 8 x 18 in desk lamp proportions."""
    return build_glb([Part(*box(0.2, 0.45, 0.2, center=(0.1, 0.5, 0.3)), color=(0.9, 0.85, 0.7),
                           metallic=1.0, roughness=0.1, name="lamp")])
