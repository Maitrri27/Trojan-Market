#!/usr/bin/env python3
"""Train the LightGBM LambdaRank recommendation ranker.

    python ml/training/train_ranker.py [--config ml/config.yaml] [--allow-small]

The first production ranker is gradient-boosted trees with a learning-to-rank
objective — not a neural network. With marketplace-scale data and mostly
tabular features, LambdaRank is both stronger and far easier to debug.

Groups are (user, session, surface): the model learns to order listings that
competed for the same pair of eyes, rather than to classify each in isolation.

The script REFUSES to mark a model active unless it clears every confidence
gate, including beating the heuristic baseline.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ml.common import InsufficientData, check_gates, content_hash, ensure_dir, load_config, utc_now_iso  # noqa: E402
from ml.features.recommendation_features import (BIAS_ONLY_FEATURES, CATEGORICAL_FEATURES,  # noqa: E402
                                                 FEATURE_VERSION, NUMERIC_FEATURES,
                                                 assert_no_forbidden)
from ml.evaluation.evaluate_ranker import evaluate_split, ndcg_at_k  # noqa: E402
from ml.registry.registry import register_model  # noqa: E402


def load_dataset(path: str) -> List[Dict[str, Any]]:
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def to_matrix(rows: List[Dict[str, Any]], cat_maps: Dict[str, Dict[str, int]]):
    import numpy as np
    feature_names = NUMERIC_FEATURES + CATEGORICAL_FEATURES
    assert_no_forbidden(feature_names)
    X = np.full((len(rows), len(feature_names)), np.nan, dtype=np.float64)
    for i, r in enumerate(rows):
        for j, f in enumerate(NUMERIC_FEATURES):
            v = r.get(f)
            if v is not None:
                X[i, j] = float(v)
        for k, f in enumerate(CATEGORICAL_FEATURES):
            j = len(NUMERIC_FEATURES) + k
            X[i, j] = cat_maps[f].get(str(r.get(f)), -1)
    y = np.array([r["label"] for r in rows], dtype=np.int32)
    w = np.array([r.get("sample_weight", 1.0) for r in rows], dtype=np.float64)
    return X, y, w, feature_names


def group_sizes(rows: List[Dict[str, Any]]) -> List[int]:
    sizes, current, key = [], 0, None
    for r in rows:
        if r["group_key"] != key:
            if current:
                sizes.append(current)
            key, current = r["group_key"], 1
        else:
            current += 1
    if current:
        sizes.append(current)
    return sizes


def build_cat_maps(rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, int]]:
    maps = {}
    for f in CATEGORICAL_FEATURES:
        vals = sorted({str(r.get(f)) for r in rows})
        maps[f] = {v: i for i, v in enumerate(vals)}
    return maps


def heuristic_baseline(rows: List[Dict[str, Any]], k: int = 10) -> float:
    """NDCG of the ranking the heuristic already produces — the bar to beat."""
    from collections import defaultdict
    groups = defaultdict(list)
    for r in rows:
        groups[r["group_key"]].append(r)
    scores = []
    for grows in groups.values():
        if len(grows) < 2:
            continue
        # heuristic_score may be absent on very old rows; fall back to served order
        ordered = sorted(
            grows,
            key=lambda r: (r.get("heuristic_score") if r.get("heuristic_score") is not None
                           else -(r.get("rank_position") or 0)),
            reverse=True,
        )
        scores.append(ndcg_at_k([r["label"] for r in ordered], k))
    return float(sum(scores) / len(scores)) if scores else 0.0


def train(cfg: Dict[str, Any], allow_small: bool = False) -> Dict[str, Any]:
    try:
        import lightgbm as lgb
        import numpy as np
    except ImportError:
        raise RuntimeError("pip install -r ml/requirements.txt")

    paths, tcfg = cfg["paths"], cfg["training"]
    ds_dir = os.path.join(paths["datasets"], cfg["dataset"]["version"])
    ds_file = os.path.join(ds_dir, "dataset.jsonl")
    if not os.path.exists(ds_file):
        raise InsufficientData(
            "No dataset at " + ds_file + ".\n"
            "Run: python ml/data/build_recommendation_dataset.py"
        )
    with open(os.path.join(ds_dir, "manifest.json"), "r", encoding="utf-8") as fh:
        manifest = json.load(fh)

    rows = load_dataset(ds_file)
    stats = manifest["stats"]

    gates = cfg["gates"]
    below = stats["n_examples"] < gates["minimum_training_examples"]
    if below and not allow_small:
        raise InsufficientData(
            "Dataset has " + str(stats["n_examples"]) + " rows; the gate requires "
            + str(gates["minimum_training_examples"]) + ".\n"
            "Re-run with --allow-small to validate the pipeline end to end. The\n"
            "resulting model is registered as 'rejected' and cannot serve traffic."
        )

    train_rows = [r for r in rows if r["split"] == "train"]
    valid_rows = [r for r in rows if r["split"] == "valid"]
    test_rows = [r for r in rows if r["split"] == "test"]
    if not train_rows or not valid_rows or not test_rows:
        raise InsufficientData("Chronological split produced an empty partition — not enough history yet.")

    cat_maps = build_cat_maps(rows)
    Xtr, ytr, wtr, feature_names = to_matrix(train_rows, cat_maps)
    Xva, yva, wva, _ = to_matrix(valid_rows, cat_maps)

    cat_idx = [feature_names.index(f) for f in CATEGORICAL_FEATURES]
    dtrain = lgb.Dataset(Xtr, label=ytr, weight=wtr, group=group_sizes(train_rows),
                         feature_name=feature_names, categorical_feature=cat_idx, free_raw_data=False)
    dvalid = lgb.Dataset(Xva, label=yva, weight=wva, group=group_sizes(valid_rows),
                         feature_name=feature_names, categorical_feature=cat_idx, reference=dtrain)

    params = {
        "objective": tcfg["objective"],
        "metric": tcfg["metric"],
        "ndcg_eval_at": tcfg["eval_at"],
        "num_leaves": tcfg["num_leaves"],
        "learning_rate": tcfg["learning_rate"],
        "min_data_in_leaf": tcfg["min_data_in_leaf"],
        "feature_fraction": tcfg["feature_fraction"],
        "bagging_fraction": tcfg["bagging_fraction"],
        "bagging_freq": tcfg["bagging_freq"],
        "lambdarank_truncation_level": tcfg["lambdarank_truncation_level"],
        "label_gain": [0, 1, 3, 7, 15],   # matches the 0-4 graded labels
        "seed": tcfg["seed"],
        "deterministic": True,
        "verbosity": -1,
    }

    booster = lgb.train(
        params, dtrain,
        num_boost_round=tcfg["num_boost_round"],
        valid_sets=[dvalid], valid_names=["valid"],
        callbacks=[lgb.early_stopping(tcfg["early_stopping_rounds"], verbose=False),
                   lgb.log_evaluation(period=50)],
    )

    # ---- evaluation on the untouched, newest slice ----
    metrics = evaluate_split(booster, test_rows, cat_maps, to_matrix, ks=tcfg["eval_at"])
    baseline = heuristic_baseline(test_rows, k=10)
    metrics["heuristic_baseline_ndcg@10"] = round(baseline, 5)
    metrics["ndcg_lift_over_baseline"] = round(metrics.get("ndcg@10", 0.0) - baseline, 5)

    gate = check_gates(gates, stats, metrics)

    version = "lgbm_ranker_" + cfg["dataset"]["version"] + "_" + utc_now_iso()[:10].replace("-", "")
    art_dir = ensure_dir(os.path.join(paths["artifacts"], version))
    model_path = os.path.join(art_dir, "model.txt")
    booster.save_model(model_path, num_iteration=booster.best_iteration)

    importance = dict(zip(feature_names, [int(v) for v in booster.feature_importance("gain")]))
    with open(os.path.join(art_dir, "feature_metadata.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "feature_version": FEATURE_VERSION,
            "feature_names": feature_names,
            "numeric_features": NUMERIC_FEATURES,
            "categorical_features": CATEGORICAL_FEATURES,
            "categorical_maps": cat_maps,
            "excluded_bias_only_features": BIAS_ONLY_FEATURES,
            "importance_gain": dict(sorted(importance.items(), key=lambda kv: -kv[1])),
            "best_iteration": booster.best_iteration,
        }, fh, indent=2)

    record = register_model(cfg, {
        "model_name": "recommendation_ranker",
        "use_case": "recommendations",
        "version": version,
        "algorithm": "lightgbm_lambdarank",
        "training_dataset_version": cfg["dataset"]["version"],
        "dataset_manifest_hash": manifest["config_hash"],
        "feature_version": FEATURE_VERSION,
        "training_timestamp": utc_now_iso(),
        "metrics": metrics,
        "dataset_stats": stats,
        "params": params,
        "artifact_location": model_path,
        "gate_check": gate.to_dict(),
        "status": "candidate" if gate.passed else "rejected",
        "config_hash": content_hash(cfg),
    })

    return {"record": record, "metrics": metrics, "gate": gate.to_dict(), "baseline": baseline}


def main() -> int:
    ap = argparse.ArgumentParser(description="Train the LightGBM LambdaRank ranker")
    ap.add_argument("--config", default=None)
    ap.add_argument("--allow-small", action="store_true",
                    help="train on a below-gate dataset to validate the pipeline; result cannot serve")
    args = ap.parse_args()
    cfg = load_config(args.config)

    try:
        out = train(cfg, allow_small=args.allow_small)
    except InsufficientData as e:
        print("=" * 72)
        print("TRAINING SKIPPED — insufficient real data")
        print("=" * 72)
        print(str(e))
        print()
        print("Heuristic ranking remains active. No model was registered.")
        return 2

    m, g = out["metrics"], out["gate"]
    print()
    print("Model:", out["record"]["version"], "-> status:", out["record"]["status"])
    print("  NDCG@5 / @10   ", m.get("ndcg@5"), "/", m.get("ndcg@10"))
    print("  MRR / MAP@10   ", m.get("mrr"), "/", m.get("map@10"))
    print("  heuristic @10  ", m.get("heuristic_baseline_ndcg@10"))
    print("  lift           ", m.get("ndcg_lift_over_baseline"))
    if g["passed"]:
        print()
        print("All confidence gates PASSED. Promote to shadow mode next:")
        print("  curl -XPOST localhost:4000/api/ml/models/promote \\")
        print("    -H 'Authorization: Bearer <admin token>' -H 'Content-Type: application/json' \\")
        print("    -d '{\"model_id\":\"" + out["record"]["model_id"] + "\",\"status\":\"shadow\"}'")
    else:
        print()
        print("Confidence gates FAILED -> registered as 'rejected', will not serve:")
        for r in g["reasons"]:
            print("   -", r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
