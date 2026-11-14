"""Corner-set layout rules (worker/arrange.py)."""
from __future__ import annotations

import pytest

from worker.arrange import Item, arrange


def boxes(lay, items):
    """Axis-aligned (x0, x1, z0, z1, y0, y1) per item, yaw 0/180 only."""
    out = {}
    for it, p in zip(items, lay.placements):
        out[it.listing_id] = (p.x - it.w / 2, p.x + it.w / 2, p.z - it.d / 2, p.z + it.d / 2, p.y, p.y + it.h)
    return out


def overlap(a, b):
    return a[0] < b[1] and b[0] < a[1] and a[2] < b[3] and b[2] < a[3] and a[4] < b[5] and b[4] < a[5]


def test_lamp_goes_on_the_side_table_and_chair_beside():
    items = [Item(1, "side_table", 20, 18, 22), Item(2, "desk_lamp", 8, 8, 18), Item(3, "accent_chair", 28, 30, 33)]
    lay = arrange(items)
    table, lamp, chair = lay.placements
    assert lamp.on == 1 and lamp.y == 22                       # standing on the table top
    assert table.x - 10 <= lamp.x - 4 and lamp.x + 4 <= table.x + 10   # within the top
    assert chair.yaw in (20.0, -20.0) and chair.on is None     # angled toward the middle
    assert lay.h == 40.0                                       # 22 table + 18 lamp


def test_desk_anchor_gets_the_chair_in_front_facing_it():
    items = [Item(1, "dining_chair", 18, 20, 36), Item(2, "desk", 48, 24, 30), Item(3, "desk_lamp", 8, 8, 18)]
    lay = arrange(items)
    chair, desk, lamp = lay.placements
    assert desk.x == 0 and desk.z == 12                         # back on the wall (z = 0)
    assert chair.yaw == 180 and chair.z - 10 > 24               # clear of the desk front (z = 24)
    assert lamp.on == 2 and lamp.y == 30


def test_floor_items_never_overlap_and_backs_touch_the_wall():
    items = [Item(1, "bookshelf", 30, 12, 65), Item(2, "nightstand", 20, 16, 24), Item(3, "floor_lamp", 12, 12, 60),
             Item(4, "dresser", 50, 18, 34)]
    lay = arrange(items)
    b = boxes(lay, items)
    ids = list(b)
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            assert not overlap(b[ids[i]], b[ids[j]]), (ids[i], ids[j])
    for it, p in zip(items, lay.placements):
        assert abs(p.z - it.d / 2) < 1e-6                       # back edge on the wall line z = 0
    assert lay.placements[3].x == 0                              # the dresser (biggest footprint) is the anchor


def test_lamp_too_big_for_any_table_stands_on_the_floor():
    items = [Item(1, "side_table", 12, 12, 22), Item(2, "desk_lamp", 14, 14, 20)]
    lamp = arrange(items).placements[1]
    assert lamp.on is None and lamp.y == 0


def test_limits():
    with pytest.raises(ValueError):
        arrange([])
    with pytest.raises(ValueError):
        arrange([Item(i, "stool", 14, 14, 22) for i in range(5)])
