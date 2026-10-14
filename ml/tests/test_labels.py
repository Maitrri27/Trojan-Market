"""Label generation + visibility weighting.

    pytest ml/tests -q

These mirror the assertions already executed against the synthetic fixture by
the JavaScript harness; this file is the Python-side equivalent and has NOT been
run in the authoring environment (no Python available there).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ml.data.labels import build_labels, label_for, negative_weight  # noqa: E402

LABEL_MAP = {
    "impression": 0, "click": 1, "detail_view": 1, "dwell_30s": 1,
    "save": 2, "share": 2, "message_sent": 3, "reply_received": 3,
    "offer_sent": 3, "offer_accepted": 4, "transaction_confirmed": 4,
}
VIS = {"above_fold_rank": 6, "seen_weight": 1.0, "below_fold_weight": 0.25, "explicit_skip_weight": 1.5}
LABEL_CFG = dict(LABEL_MAP, visibility=VIS)


def test_unengaged_impression_is_zero():
    assert label_for([], LABEL_MAP) == 0


def test_grades():
    assert label_for(["click"], LABEL_MAP) == 1
    assert label_for(["save"], LABEL_MAP) == 2
    assert label_for(["message_sent"], LABEL_MAP) == 3
    assert label_for(["transaction_confirmed"], LABEL_MAP) == 4


def test_strongest_signal_wins_not_the_sum():
    assert label_for(["click", "save", "message_sent"], LABEL_MAP) == 3


def test_unknown_event_types_ignored():
    assert label_for(["click", "some_future_signal"], LABEL_MAP) == 1


def test_above_fold_miss_is_full_strength_negative():
    assert negative_weight(2, False, VIS) == 1.0


def test_below_fold_miss_is_downweighted():
    assert negative_weight(40, False, VIS) == 0.25


def test_scroll_past_upgrades_a_deep_miss():
    # the user engaged with rank 30, so rank 20 was demonstrably scrolled past
    assert negative_weight(20, False, VIS, max_rank_seen=30) == 1.0


def test_explicit_skip_outweighs_passive_miss():
    assert negative_weight(3, True, VIS) > negative_weight(3, False, VIS)


def test_missing_rank_treated_conservatively():
    assert negative_weight(None, False, VIS) == 0.25


def test_build_labels_annotates_rows():
    rows = [
        {"listing_id": "a", "rank_position": 0, "timestamp": 0},
        {"listing_id": "b", "rank_position": 1, "timestamp": 0},
        {"listing_id": "c", "rank_position": 30, "timestamp": 0},
    ]
    build_labels(rows, {"a": ["click", "save"], "c": ["skip"]}, LABEL_CFG)
    by_id = {r["listing_id"]: r for r in rows}
    assert by_id["a"]["label"] == 2 and by_id["a"]["sample_weight"] == 1.0
    assert by_id["b"]["label"] == 0 and by_id["b"]["sample_weight"] == 1.0
    assert by_id["c"]["label"] == 0 and by_id["c"]["sample_weight"] == 1.5


def test_inverse_propensity_weighting():
    rows = [{"listing_id": "a", "rank_position": 0, "timestamp": 0, "propensity": 0.05}]
    build_labels(rows, {}, LABEL_CFG)
    assert rows[0]["sample_weight"] == 1.0 / 0.05


def test_propensity_of_one_does_not_reweight():
    rows = [{"listing_id": "a", "rank_position": 0, "timestamp": 0, "propensity": 1}]
    build_labels(rows, {}, LABEL_CFG)
    assert rows[0]["sample_weight"] == 1.0
