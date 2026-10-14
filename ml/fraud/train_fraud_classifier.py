#!/usr/bin/env python3
"""Scam/spam classifier for MODERATION ASSISTANCE ONLY.

The output is a triage score that orders the human review queue. It never bans,
hides or blocks anything on its own — a false positive on a real student's
listing is far more costly than a slow review.

Labels come from human moderator decisions recorded at
POST /api/moderation/decide  (0 = safe, 1 = confirmed scam/spam/violation).

    python ml/fraud/train_fraud_classifier.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ml.common import ensure_dir, load_config, read_db, utc_now_iso  # noqa: E402

FEATURES = [
    "price", "description_length", "has_photo", "rules_risk_score",
    "rules_fired_count", "is_housing", "price_percentile_in_category",
]


def build_rows(decisions: List[Dict[str, Any]]) -> tuple:
    X, y = [], []
    prices_by_cat: Dict[str, List[float]] = {}
    for d in decisions:
        snap = d.get("listing_snapshot") or {}
        cat = snap.get("category", "other")
        prices_by_cat.setdefault(cat, []).append(float(snap.get("price") or 0))

    for d in decisions:
        snap = d.get("listing_snapshot")
        if not snap:
            continue
        rules = d.get("rules_at_decision") or {}
        cat = snap.get("category", "other")
        prices = sorted(prices_by_cat.get(cat, [0.0]))
        price = float(snap.get("price") or 0)
        pct = (sum(1 for p in prices if p <= price) / len(prices)) if prices else 0.5
        X.append([
            price,
            float(snap.get("description_length") or 0),
            1.0 if snap.get("has_photo") else 0.0,
            float(rules.get("risk_score") or 0),
            float(len(rules.get("rules_fired") or [])),
            1.0 if cat == "housing" else 0.0,
            pct,
        ])
        y.append(int(d.get("label", 0)))
    return X, y


def main() -> int:
    ap = argparse.ArgumentParser(description="Train the moderation triage classifier")
    ap.add_argument("--config", default=None)
    args = ap.parse_args()
    cfg = load_config(args.config)
    fcfg = cfg["fraud"]

    db = read_db(cfg["paths"]["db"])
    decisions = db.get("moderation_decisions", [])
    positives = sum(1 for d in decisions if d.get("label") == 1)

    if len(decisions) < fcfg["minimum_labels"] or positives < fcfg["minimum_positives"]:
        print("=" * 72)
        print("NOT TRAINING — insufficient moderation labels")
        print("=" * 72)
        print("  labels    " + str(len(decisions)) + "/" + str(fcfg["minimum_labels"]))
        print("  positives " + str(positives) + "/" + str(fcfg["minimum_positives"]))
        print()
        print("Moderation continues on transparent rules + human review, which is")
        print("the correct posture: a classifier trained on a handful of decisions")
        print("would mostly reproduce the rules that generated them.")
        return 2

    try:
        import lightgbm as lgb
        import numpy as np
        from sklearn.metrics import average_precision_score, roc_auc_score
        from sklearn.model_selection import train_test_split
    except ImportError:
        print("pip install -r ml/requirements.txt")
        return 1

    X, y = build_rows(decisions)
    Xa, ya = np.array(X), np.array(y)
    # chronological holdout — moderation patterns drift with scam tactics
    cut = int(len(Xa) * 0.8)
    Xtr, Xte, ytr, yte = Xa[:cut], Xa[cut:], ya[:cut], ya[cut:]

    clf = lgb.LGBMClassifier(
        objective="binary", n_estimators=300, learning_rate=0.05,
        num_leaves=15, min_child_samples=20, is_unbalance=True, random_state=42, verbosity=-1,
    )
    # NOTE: feature_name belongs on lgb.Dataset / lgb.train, not on the sklearn
    # wrapper's fit() — passing it here raises TypeError.
    clf.fit(Xtr, ytr)
    proba = clf.predict_proba(Xte)[:, 1]

    metrics = {
        "roc_auc": round(float(roc_auc_score(yte, proba)), 4),
        "average_precision": round(float(average_precision_score(yte, proba)), 4),
        "n_train": int(len(ytr)), "n_test": int(len(yte)),
        "positive_rate": round(float(ya.mean()), 4),
    }

    art = ensure_dir(os.path.join(cfg["paths"]["artifacts"], "fraud"))
    clf.booster_.save_model(os.path.join(art, "model.txt"))
    with open(os.path.join(art, "metadata.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "model": "lightgbm_binary_moderation_triage",
            "fitted_at": utc_now_iso(),
            "features": FEATURES,
            "metrics": metrics,
            "usage": "QUEUE ORDERING ONLY. Never auto-removes or bans. Human decision required.",
            "status": "candidate",
        }, fh, indent=2)

    print(json.dumps(metrics, indent=2))
    print()
    print("Saved to", art, "- status 'candidate'. Assists triage only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
