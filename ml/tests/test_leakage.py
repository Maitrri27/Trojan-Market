"""Leakage and fair-housing guards.

    pytest ml/tests -q

NOT executed in the authoring environment (no Python available there).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ml.features.recommendation_features import (BIAS_ONLY_FEATURES, CATEGORICAL_FEATURES,  # noqa: E402
                                                 LEAKY_COLUMNS, NUMERIC_FEATURES,
                                                 PROTECTED_ATTRIBUTES, RunningState,
                                                 assert_dataset_safe, assert_no_forbidden, build_row)


def test_model_matrix_rejects_protected_attributes():
    with pytest.raises(ValueError, match="Forbidden features"):
        assert_no_forbidden(["price", "gender"])


def test_model_matrix_rejects_outcome_columns():
    with pytest.raises(ValueError, match="Forbidden features"):
        assert_no_forbidden(["price", "sold"])


def test_model_matrix_rejects_bias_only_columns():
    with pytest.raises(ValueError, match="Bias-correction"):
        assert_no_forbidden(["price", "rank_position"])


def test_declared_feature_list_is_clean():
    assert_no_forbidden(NUMERIC_FEATURES + CATEGORICAL_FEATURES)


def test_dataset_allows_bias_and_provenance_columns():
    # these legitimately live in the dataset; only the matrix excludes them
    assert_dataset_safe(["price", "rank_position", "propensity", "engagement_types"])


def test_dataset_rejects_protected_attributes():
    with pytest.raises(ValueError, match="Protected attributes"):
        assert_dataset_safe(["price", "food_preference"])


def test_protected_and_leaky_sets_are_disjoint():
    assert not (PROTECTED_ATTRIBUTES & LEAKY_COLUMNS)


def test_bias_only_columns_are_not_declared_features():
    assert not (set(BIAS_ONLY_FEATURES) & set(NUMERIC_FEATURES + CATEGORICAL_FEATURES))


def test_running_state_never_sees_the_future():
    """Popularity must reflect only events observed BEFORE the impression."""
    state = RunningState(half_life_days=14)
    listing = {"id": "L1", "category": "housing", "price": 1000, "description": "x",
               "condition": "Good", "days": 1, "_house": None, "_seller_key": "s1",
               "_stated_profile": None}

    imp = {"event_id": "e1", "event_type": "impression", "listing_id": "L1",
           "user_id": "u1", "session_id": "s1", "timestamp": 1_000, "rank_position": 0}
    row_before = build_row(imp, listing, state, 0)
    assert row_before["historical_click_rate"] == 0.0

    # a click AFTER the impression must not retroactively change that row
    state.observe({"event_type": "impression", "listing_id": "L1", "user_id": "u1",
                   "session_id": "s1", "timestamp": 1_000}, listing)
    state.observe({"event_type": "click", "listing_id": "L1", "user_id": "u1",
                   "session_id": "s1", "timestamp": 2_000}, listing)
    assert row_before["historical_click_rate"] == 0.0

    later = dict(imp, event_id="e2", timestamp=3_000)
    row_after = build_row(later, listing, state, 1)
    assert row_after["historical_click_rate"] > 0.0


def test_user_features_only_use_prior_interactions():
    state = RunningState(half_life_days=14)
    listing = {"id": "L1", "category": "electronics", "price": 500, "description": "x",
               "condition": "Good", "days": 1, "_house": None, "_seller_key": "s1",
               "_stated_profile": None}
    imp = {"event_id": "e1", "event_type": "impression", "listing_id": "L1",
           "user_id": "u1", "session_id": "s1", "timestamp": 1_000, "rank_position": 0}
    first = build_row(imp, listing, state, 0)
    assert first["category_affinity"] == 0.0
    assert first["user_interaction_count"] == 0

    state.observe({"event_type": "save", "listing_id": "L1", "user_id": "u1",
                   "session_id": "s1", "timestamp": 2_000}, listing)
    second = build_row(dict(imp, event_id="e2", timestamp=3_000), listing, state, 1)
    assert second["category_affinity"] > 0.0
    assert second["user_interaction_count"] == 1


def test_time_decay_favours_recent_behaviour():
    state = RunningState(half_life_days=14)
    now = 100 * 86_400_000
    assert state.decay(now - 1000, now) > state.decay(now - 30 * 86_400_000, now)


def test_build_row_exposes_no_protected_attribute():
    state = RunningState()
    listing = {"id": "housing-1", "category": "housing", "price": 1450, "description": "x",
               "condition": "Furnished", "days": 1, "_seller_key": "s1", "_stated_profile": {},
               "_house": {"hood": "USC Village", "commute": 8, "beds": 1, "baths": 1,
                          "furnished": True, "rent": 1450, "gender": "Female", "food": "Vegan"}}
    imp = {"event_id": "e1", "event_type": "impression", "listing_id": "housing-1",
           "user_id": "u1", "session_id": "s1", "timestamp": 1_000, "rank_position": 0}
    row = build_row(imp, listing, state, 0)
    # gender/food exist on the housing record but must never reach the row
    for bad in ("gender", "food", "food_preference", "sold", "engagement_types"):
        assert bad not in row, bad
