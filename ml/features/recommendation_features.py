"""Feature engineering for the recommendation ranker.

THE CENTRAL RULE OF THIS FILE: every feature is computed from information
available strictly BEFORE the impression it describes. Popularity counts, user
affinities and price statistics are all accumulated by replaying events in
timestamp order, so a row can never see its own future.

This mirrors server/recommendations/preferences.js and ranker.js#featureRow.
The two must agree — 'feature_version' is the contract, and the parity test in
ml/tests/test_feature_parity.py enforces it.
"""
from __future__ import annotations

import math
from collections import defaultdict, deque
from typing import Any, Dict, List, Optional

FEATURE_VERSION = "rec_features_v1"

# Interaction weights for the time-decayed affinity profile.
EVENT_WEIGHT = {
    "impression": 0.05,
    "click": 1.0,
    "detail_view": 1.0,
    "dwell_30s": 1.5,
    "save": 3.0,
    "message_sent": 4.0,
    "offer_sent": 4.0,
    "transaction_confirmed": 6.0,
    "skip": -1.5,
}

NUMERIC_FEATURES = [
    # listing
    "price", "is_free", "listing_age_days", "photo_count", "description_length",
    "has_condition", "commute_minutes", "bedrooms", "bathrooms", "furnished",
    "historical_view_count", "historical_impression_count", "historical_click_rate",
    "historical_save_rate", "historical_message_rate", "seller_listing_count",
    "seller_reply_rate", "seller_report_count",
    # user
    "user_interaction_count", "user_tenure_days", "user_median_viewed_price",
    "user_median_saved_price", "user_distinct_categories", "user_session_count",
    # cross
    "category_affinity", "category_match", "price_diff_from_user_median",
    "price_ratio_to_user_median", "price_within_user_range", "neighborhood_match",
    "neighborhood_affinity", "commute_within_preference", "budget_headroom",
    # context
    "has_query", "filter_count", "hour_of_day", "day_of_week", "is_weekend",
    "impression_index_in_session",
    # heuristic score is a legitimate input, not a leak: it is computed online
    # from the same pre-impression state.
    "heuristic_score",
]

CATEGORICAL_FEATURES = ["category", "neighborhood", "surface", "device_type"]

# ---------------------------------------------------------------------------
# Three tiers, because "forbidden" means different things in the dataset and in
# the model matrix.
#
#   PROTECTED_ATTRIBUTES  never appear ANYWHERE — not in the dataset, not in the
#                         matrix. Fair Housing (see docs/FAIR_HOUSING.md).
#   LEAKY_COLUMNS         may exist in the dataset as label provenance, but must
#                         never be model inputs (they encode the outcome).
#   BIAS_ONLY_FEATURES    recorded for IPW / evaluation, never model inputs.
# ---------------------------------------------------------------------------

PROTECTED_ATTRIBUTES = {
    "gender", "gender_preference", "age", "religion", "ethnicity", "national_origin",
    "familial_status", "disability", "food_preference", "dietary_preference",
    "name", "email", "zip_code",
}

LEAKY_COLUMNS = {
    "final_label", "engagement_types", "transaction_amount", "sold", "days_to_sale",
    "future_view_count", "total_lifetime_saves",
}

# rank_position is captured but EXCLUDED from the model's inputs: it is used for
# bias correction and evaluation only. Including it teaches the model that
# whatever was ranked highly is relevant — a self-fulfilling loop.
BIAS_ONLY_FEATURES = ["rank_position", "original_rank", "propensity"]

# Union used for the model-matrix check.
FORBIDDEN_FEATURES = PROTECTED_ATTRIBUTES | LEAKY_COLUMNS


def assert_dataset_safe(columns: List[str]) -> None:
    """Dataset-level guard: no protected attribute may be persisted at all."""
    bad = sorted(set(c.lower() for c in columns) & PROTECTED_ATTRIBUTES)
    if bad:
        raise ValueError(
            "Protected attributes present in the training dataset: " + ", ".join(bad)
            + ". These must never be collected into ML data — see docs/FAIR_HOUSING.md."
        )


def assert_no_forbidden(columns: List[str]) -> None:
    """Model-matrix guard: no protected, leaky or bias-only column may be an input."""
    bad = sorted(set(c.lower() for c in columns) & FORBIDDEN_FEATURES)
    if bad:
        raise ValueError(
            "Forbidden features present in training matrix: " + ", ".join(bad)
            + ". Protected attributes and outcome-derived columns must never be learned."
        )
    leaked = sorted(set(columns) & set(BIAS_ONLY_FEATURES))
    if leaked:
        raise ValueError(
            "Bias-correction columns leaked into the model inputs: " + ", ".join(leaked)
        )


def _median(values: List[float]) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2.0


class RunningState:
    """Accumulates pre-impression state as events are replayed in time order.

    Every getter returns the state AS OF the moment it is called, which the
    dataset builder guarantees is before the impression being featurised.
    """

    def __init__(self, half_life_days: float = 14.0):
        self.half_life_days = half_life_days
        # per-user
        self.user_cat = defaultdict(lambda: defaultdict(float))
        self.user_hood = defaultdict(lambda: defaultdict(float))
        self.user_viewed_prices = defaultdict(lambda: deque(maxlen=50))
        self.user_saved_prices = defaultdict(lambda: deque(maxlen=50))
        self.user_interactions = defaultdict(int)
        self.user_first_seen = {}
        self.user_sessions = defaultdict(set)
        # per-listing
        self.listing_impressions = defaultdict(int)
        self.listing_clicks = defaultdict(int)
        self.listing_saves = defaultdict(int)
        self.listing_messages = defaultdict(int)
        self.listing_views = defaultdict(int)
        # per-seller
        self.seller_listings = defaultdict(int)
        self.seller_replies = defaultdict(int)
        self.seller_threads = defaultdict(int)
        self.seller_reports = defaultdict(int)

    def decay(self, event_ms: int, now_ms: int) -> float:
        days = max(0.0, (now_ms - event_ms) / 86_400_000.0)
        return 0.5 ** (days / self.half_life_days)

    def observe(self, ev: Dict[str, Any], listing: Optional[Dict[str, Any]]) -> None:
        uid = ev.get("user_id")
        lid = ev.get("listing_id")
        et = ev.get("event_type")
        ts = ev.get("timestamp", 0)

        if uid:
            self.user_first_seen.setdefault(uid, ts)
            if ev.get("session_id"):
                self.user_sessions[uid].add(ev["session_id"])

        if lid:
            if et == "impression":
                self.listing_impressions[lid] += 1
            elif et in ("click", "detail_view"):
                self.listing_clicks[lid] += 1
                self.listing_views[lid] += 1
            elif et == "save":
                self.listing_saves[lid] += 1
            elif et in ("message_sent", "message_started"):
                self.listing_messages[lid] += 1

        w = EVENT_WEIGHT.get(et)
        if uid and lid and listing and w is not None:
            self.user_cat[uid][listing.get("category", "other")] += w
            hood = (listing.get("_house") or {}).get("hood")
            if hood:
                self.user_hood[uid][hood] += w
            if w > 0:
                self.user_interactions[uid] += 1
            price = float(listing.get("price") or 0)
            if et in ("click", "detail_view", "dwell_30s"):
                self.user_viewed_prices[uid].append(price)
            if et == "save":
                self.user_saved_prices[uid].append(price)

    # ---------------------------------------------------------------- getters

    def user_features(self, uid: Optional[str], now_ms: int) -> Dict[str, Any]:
        if not uid:
            return {
                "user_interaction_count": 0, "user_tenure_days": 0,
                "user_median_viewed_price": None, "user_median_saved_price": None,
                "user_distinct_categories": 0, "user_session_count": 0,
            }
        first = self.user_first_seen.get(uid, now_ms)
        cats = self.user_cat.get(uid, {})
        return {
            "user_interaction_count": self.user_interactions.get(uid, 0),
            "user_tenure_days": int((now_ms - first) / 86_400_000),
            "user_median_viewed_price": _median(list(self.user_viewed_prices.get(uid, []))),
            "user_median_saved_price": _median(list(self.user_saved_prices.get(uid, []))),
            "user_distinct_categories": sum(1 for v in cats.values() if v > 0),
            "user_session_count": len(self.user_sessions.get(uid, ())),
        }

    def category_affinity(self, uid: Optional[str], category: str) -> float:
        if not uid:
            return 0.0
        cats = self.user_cat.get(uid, {})
        total = sum(max(0.0, v) for v in cats.values())
        if total <= 0:
            return 0.0
        return max(0.0, cats.get(category, 0.0)) / total

    def neighborhood_affinity(self, uid: Optional[str], hood: Optional[str]) -> float:
        if not uid or not hood:
            return 0.0
        hoods = self.user_hood.get(uid, {})
        total = sum(max(0.0, v) for v in hoods.values())
        if total <= 0:
            return 0.0
        return max(0.0, hoods.get(hood, 0.0)) / total

    def listing_features(self, lid: str) -> Dict[str, Any]:
        imps = self.listing_impressions.get(lid, 0)
        denom = float(imps) if imps else 1.0
        return {
            "historical_impression_count": imps,
            "historical_view_count": self.listing_views.get(lid, 0),
            "historical_click_rate": self.listing_clicks.get(lid, 0) / denom,
            "historical_save_rate": self.listing_saves.get(lid, 0) / denom,
            "historical_message_rate": self.listing_messages.get(lid, 0) / denom,
        }

    def seller_features(self, seller_key: Optional[str]) -> Dict[str, Any]:
        if not seller_key:
            return {"seller_listing_count": 0, "seller_reply_rate": 0.0, "seller_report_count": 0}
        threads = self.seller_threads.get(seller_key, 0)
        return {
            "seller_listing_count": self.seller_listings.get(seller_key, 0),
            "seller_reply_rate": (self.seller_replies.get(seller_key, 0) / threads) if threads else 0.0,
            "seller_report_count": self.seller_reports.get(seller_key, 0),
        }


def build_row(impression: Dict[str, Any], listing: Dict[str, Any], state: RunningState,
              session_index: int) -> Dict[str, Any]:
    """Assemble one training row. Uses ONLY pre-impression state."""
    ts = impression.get("timestamp", 0)
    uid = impression.get("user_id")
    house = listing.get("_house") or {}
    price = float(listing.get("price") or 0)

    uf = state.user_features(uid, ts)
    lf = state.listing_features(listing["id"])
    sf = state.seller_features(listing.get("_seller_key"))

    med_view = uf["user_median_viewed_price"]
    stated = listing.get("_stated_profile") or {}
    budget_max = stated.get("budgetMax")

    from datetime import datetime, timezone
    dt = datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc)

    row: Dict[str, Any] = {
        # keys (not features)
        "impression_id": impression.get("event_id"),
        "user_id": uid,
        "session_id": impression.get("session_id"),
        "listing_id": listing["id"],
        "timestamp": ts,
        "group_key": "|".join([str(uid), str(impression.get("session_id")), str(impression.get("surface"))]),
        # bias-only, excluded from X
        "rank_position": impression.get("rank_position"),
        "original_rank": impression.get("original_rank"),
        "propensity": impression.get("propensity"),
        # listing
        "price": price,
        "is_free": 1 if listing.get("free") else 0,
        "category": listing.get("category", "other"),
        "listing_age_days": float(listing.get("days") or 0),
        "photo_count": 1 if (listing.get("photo") or listing.get("kw")) else 0,
        "description_length": len(str(listing.get("description") or "")),
        "has_condition": 1 if listing.get("condition") not in (None, "", "—") else 0,
        "neighborhood": house.get("hood"),
        "commute_minutes": house.get("commute"),
        "bedrooms": house.get("beds"),
        "bathrooms": house.get("baths"),
        "furnished": (1 if house.get("furnished") else 0) if house else None,
        # context
        "surface": impression.get("surface"),
        "device_type": impression.get("device_type") or "unknown",
        "has_query": 1 if impression.get("query_text") else 0,
        "filter_count": len(impression.get("filters_active") or {}),
        "hour_of_day": dt.hour,
        "day_of_week": dt.weekday(),
        "is_weekend": 1 if dt.weekday() >= 5 else 0,
        "impression_index_in_session": session_index,
        "heuristic_score": impression.get("heuristic_score"),
    }
    row.update(uf)
    row.update(lf)
    row.update(sf)

    # cross features
    aff = state.category_affinity(uid, row["category"])
    row["category_affinity"] = aff
    row["category_match"] = 1 if aff > 0.15 else 0
    row["neighborhood_affinity"] = state.neighborhood_affinity(uid, house.get("hood"))
    row["price_diff_from_user_median"] = (price - med_view) if med_view is not None else None
    row["price_ratio_to_user_median"] = (price / med_view) if med_view else None
    row["price_within_user_range"] = (
        1 if (budget_max is not None and price <= budget_max) else (0 if budget_max is not None else None)
    )
    row["neighborhood_match"] = (
        (1 if house.get("hood") == stated.get("hood") else 0) if (house and stated.get("hood")) else None
    )
    row["commute_within_preference"] = (
        (1 if house.get("commute", 999) <= stated.get("commuteMax", 999) else 0) if house and stated else None
    )
    row["budget_headroom"] = (
        (budget_max - (house.get("rent") or price)) if (budget_max is not None) else None
    )
    return row
