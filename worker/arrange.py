"""Corner-set layout (spec 11.1): place 2-4 real items as a believable corner, in inches.

Coordinates match the exporter page: x to the right, y up, z toward the viewer. Each item's model is
centred on its own footprint with its base at y = 0, so a placement is (x, y, z, yaw) for that centre.
The wall runs along z = 0: every floor item stands with its back against it (centre z = depth / 2).

Rules, in order:
  1. a desk lamp goes ON a surface: the lowest table that is wide and deep enough, at the back-left of its
     top, y = the surface height (with no such table it stands on the floor like anything else)
  2. the anchor (largest footprint among the non-seats) stands at x = 0, back to the wall
  3. if the anchor is a desk, the first seat is pulled out in front of it and turned to face it;
     other seats stand beside, angled 20 degrees toward the middle
  4. everything else lines up left and right of the anchor, alternating, with a 4 inch gap
Pure function: unit-tested without a browser.
"""
from __future__ import annotations

from dataclasses import dataclass, field

GAP_IN = 4.0
TABLETOP = {"desk_lamp"}
SURFACES = {"side_table", "nightstand", "desk", "coffee_table", "dresser", "dining_table", "console_table", "bookshelf"}
WORK_SURFACES = {"desk", "dining_table"}
SEATS = {"accent_chair", "dining_chair", "office_chair", "stool", "ottoman", "armchair", "chair"}


@dataclass
class Item:
    listing_id: int
    category: str
    w: float               # inches, as exported (final_w_in / final_d_in / final_h_in)
    d: float
    h: float


@dataclass
class Placement:
    listing_id: int
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    yaw: float = 0.0
    on: int | None = None          # listing_id of the surface it stands on
    note: str = ""


@dataclass
class Layout:
    placements: list[Placement] = field(default_factory=list)
    w: float = 0.0                 # footprint of the whole arrangement
    d: float = 0.0
    h: float = 0.0


def _footprint(it: Item, yaw: float) -> tuple[float, float]:
    """Axis-aligned W x D of an item turned by yaw (only 0/90/180/270 change the box; small angles ~ unchanged)."""
    return (it.d, it.w) if round(yaw) % 180 == 90 else (it.w, it.d)


def arrange(items: list[Item]) -> Layout:
    if not items:
        raise ValueError("a corner set needs at least one item")
    if len(items) > 4:
        raise ValueError("a corner set has at most 4 items (Quick Look stays fast and the corner stays readable)")
    left = list(items)
    place: dict[int, Placement] = {it.listing_id: Placement(it.listing_id) for it in items}

    # 1. table-top items onto a surface
    surfaces = sorted([it for it in left if it.category in SURFACES and it.h <= 48], key=lambda s: s.h)
    tops = [it for it in left if it.category in TABLETOP]
    on_surface: dict[int, list[Item]] = {}
    for top in tops:
        host = next((s for s in surfaces if s.w >= top.w + 2 and s.d >= top.d + 2
                     and sum(t.w for t in on_surface.get(s.listing_id, [])) + top.w + 2 <= s.w), None)
        if host is None:
            continue                                   # no table to stand on: it goes on the floor like anything else
        on_surface.setdefault(host.listing_id, []).append(top)
        left.remove(top)

    # 2. anchor = biggest footprint on the floor (seats only if nothing else)
    floor = sorted(left, key=lambda it: (it.category not in SEATS, it.w * it.d), reverse=True)
    anchor = floor[0]
    rest = floor[1:]
    pa = place[anchor.listing_id]
    pa.x, pa.z, pa.note = 0.0, anchor.d / 2, "anchor, back to the wall"
    x_right, x_left = anchor.w / 2, -anchor.w / 2

    # 3. the first seat goes in front of a desk anchor, turned to face it. The desk's back is on the wall
    #    (z = 0), so its front edge is z = d; the seat stands a little clear of it.
    if anchor.category in WORK_SURFACES:
        seat = next((it for it in rest if it.category in SEATS), None)
        if seat is not None:
            ps = place[seat.listing_id]
            ps.x, ps.yaw = 0.0, 180.0
            ps.z = anchor.d + GAP_IN * 2 + seat.d / 2
            ps.note = "pulled out in front of the table, facing it"
            rest.remove(seat)

    # 4. line up the others, alternating right / left, backs to the wall
    right_turn = True
    for it in rest:
        p = place[it.listing_id]
        seat = it.category in SEATS
        p.yaw = (-20.0 if right_turn else 20.0) if seat else 0.0
        fw, fd = _footprint(it, p.yaw)
        if right_turn:
            p.x = x_right + GAP_IN + fw / 2
            x_right = p.x + fw / 2
        else:
            p.x = x_left - GAP_IN - fw / 2
            x_left = p.x - fw / 2
        p.z = fd / 2 + (2.0 if seat else 0.0)         # seats sit a little off the wall
        p.note = "beside, angled toward the middle" if seat else "beside, back to the wall"
        right_turn = not right_turn

    # table-top items: back-left of the surface top, side by side
    for host_id, its in on_surface.items():
        host = place[host_id]
        hs = next(i for i in items if i.listing_id == host_id)
        x = host.x - hs.w / 2 + 1.0
        for top in its:
            p = place[top.listing_id]
            p.x = x + top.w / 2
            p.z = host.z - hs.d / 2 + top.d / 2 + 1.0
            p.y = hs.h
            p.on = host_id
            p.note = f"on top of item {host_id}"
            x += top.w + 1.0

    lay = Layout(placements=[place[it.listing_id] for it in items])
    xs, zs = [], []
    for it, p in zip(items, lay.placements):
        fw, fd = _footprint(it, p.yaw)
        xs += [p.x - fw / 2, p.x + fw / 2]
        zs += [p.z - fd / 2, p.z + fd / 2]
    lay.w = round(max(xs) - min(xs), 1)
    lay.d = round(max(zs) - min(zs), 1)
    lay.h = round(max(p.y + it.h for it, p in zip(items, lay.placements)), 1)
    return lay
