#!/usr/bin/env python3
"""Bradley-Terry preference model for House Match.

Why this and not learning-to-rank on clicks: clicks measure *interest*, and
"which apartment fits me better" is a different question. Asking directly gives
a real utility label, and at USC scale (a few hundred students x ~30 pairs) the
data is genuinely collectible in weeks rather than years.

Model
-----
Each housing criterion c has a weight w_c. An apartment's utility for a user is
    u = sum_c  w_c * match_c(user_profile, apartment)
and the probability the user prefers A over B is the logistic of (u_A - u_B).
Fitting w by regularised maximum likelihood on observed pairwise choices gives
weights that reflect what students actually trade off — replacing the
hand-picked 30/15/15/10/10/10/10 in server/modules/housing.js.

Until the minimum sample is met this script refuses to fit and the transparent
heuristic weights stay in force.

    python ml/housing/train_pairwise.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ml.common import InsufficientData, ensure_dir, load_config, read_db, utc_now_iso  # noqa: E402

CRITERIA = ["budget", "commute", "neighborhood", "pets", "furnished", "lease", "bedrooms"]


def criterion_values(profile: Dict[str, Any], house: Dict[str, Any]) -> List[float]:
    """Per-criterion match in [0,1] — identical definition to the Node scorer."""
    budget_max = profile.get("budgetMax", 1500)
    over = house["rent"] - budget_max
    commute_max = profile.get("commuteMax", 15)
    return [
        1.0 if over <= 0 else max(0.0, 1 - over / 600),
        1.0 if house["commute"] <= commute_max else max(0.0, 1 - (house["commute"] - commute_max) / 20),
        1.0 if house["hood"] == profile.get("hood") else 0.35,
        1.0 if (not profile.get("pets") or house.get("pets")) else 0.0,
        1.0 if (not profile.get("furnished") or house.get("furnished")) else 0.2,
        1.0 if abs(house["lease"] - profile.get("lease", 12)) <= 2 else 0.4,
        1.0 if house["beds"] >= profile.get("beds", 1) else 0.5,
    ]


def build_design(pairs: List[Dict[str, Any]], profiles: Dict[str, Any],
                 house: Dict[str, Any]) -> Tuple[List[List[float]], List[int]]:
    """X row = criterion-value difference (A - B); y = 1 if A was chosen."""
    X, y = [], []
    for p in pairs:
        if p.get("selected_option") not in ("a", "b"):
            continue
        ha, hb = house.get(p["option_a"]), house.get(p["option_b"])
        if not ha or not hb:
            continue
        prof = profiles.get(p.get("user_id")) or {}
        va = criterion_values(prof, ha)
        vb = criterion_values(prof, hb)
        X.append([a - b for a, b in zip(va, vb)])
        y.append(1 if p["selected_option"] == "a" else 0)
    return X, y


def fit(X: List[List[float]], y: List[int], l2: float) -> Dict[str, Any]:
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import cross_val_score

    Xa, ya = np.array(X), np.array(y)
    # No intercept: preference must come from the criteria, not a global bias.
    clf = LogisticRegression(C=1.0 / max(l2, 1e-6), fit_intercept=False, max_iter=2000)
    acc = cross_val_score(clf, Xa, ya, cv=min(5, max(2, len(set(ya.tolist())) + 1)), scoring="accuracy")
    clf.fit(Xa, ya)
    raw = clf.coef_[0]
    # Rescale to sum to 100 so the output is a drop-in replacement for the
    # existing weight table. Negative coefficients are clipped: a criterion
    # cannot make a home worse by matching better.
    pos = [max(0.0, float(c)) for c in raw]
    total = sum(pos) or 1.0
    weights = {c: round(100.0 * v / total, 2) for c, v in zip(CRITERIA, pos)}
    return {
        "weights": weights,
        "raw_coefficients": {c: round(float(v), 5) for c, v in zip(CRITERIA, raw)},
        "cv_accuracy_mean": round(float(acc.mean()), 4),
        "cv_accuracy_std": round(float(acc.std()), 4),
        "n_pairs": len(y),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Fit the Bradley-Terry House Match weights")
    ap.add_argument("--config", default=None)
    ap.add_argument("--force", action="store_true", help="fit below the minimum sample (result stays inactive)")
    args = ap.parse_args()
    cfg = load_config(args.config)
    hcfg = cfg["housing_pairwise"]

    db = read_db(cfg["paths"]["db"])
    pairs = db.get("housing_preference_pairs", [])
    decisive = [p for p in pairs if p.get("selected_option") in ("a", "b")]
    users = {p.get("user_id") for p in decisive if p.get("user_id")}

    house_path = os.path.join(cfg["paths"]["artifacts"], "house_detail.json")
    if not os.path.exists(house_path):
        print("Missing " + house_path + " — run: node ml/export_house_detail.js")
        return 1
    with open(house_path, "r", encoding="utf-8") as fh:
        house = json.load(fh)

    short = []
    if len(decisive) < hcfg["minimum_decisive_pairs"]:
        short.append("decisive pairs " + str(len(decisive)) + "/" + str(hcfg["minimum_decisive_pairs"]))
    if len(users) < hcfg["minimum_users"]:
        short.append("users " + str(len(users)) + "/" + str(hcfg["minimum_users"]))

    if short and not args.force:
        print("=" * 72)
        print("NOT FITTING — insufficient pairwise preference data")
        print("=" * 72)
        print("  " + "; ".join(short))
        print()
        print("House Match continues to use the transparent heuristic weights.")
        print("Collect preferences via GET /api/housing/pairwise/next and")
        print("POST /api/housing/pairwise. Progress: /api/housing/pairwise/stats")
        return 2

    X, y = build_design(decisive, db.get("profiles", {}), house)
    if len(X) < 20:
        print("Only " + str(len(X)) + " usable rows after joining profiles — cannot fit.")
        return 2

    result = fit(X, y, hcfg["l2_regularisation"])
    out = {
        "model": "bradley_terry_logistic",
        "version": "housing_bt_" + utc_now_iso()[:10].replace("-", ""),
        "fitted_at": utc_now_iso(),
        "criteria": CRITERIA,
        # 'inactive' until an admin promotes it; the Node service only reads
        # weights when status == 'active'.
        "status": "inactive" if short else "candidate",
        "gates": {"decisive_pairs": len(decisive), "users": len(users), "shortfalls": short},
        **result,
    }
    path = os.path.join(ensure_dir(cfg["paths"]["artifacts"]), "housing_weights.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)

    print("Fitted weights ->", path)
    print(json.dumps(result, indent=2))
    print()
    print("Status:", out["status"], "— set to 'active' in that file to serve it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
