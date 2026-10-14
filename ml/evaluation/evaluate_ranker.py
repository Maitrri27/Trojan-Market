#!/usr/bin/env python3
"""Ranking evaluation: NDCG@K, MRR, Precision@K, Recall@K, MAP@K.

Also compares the model against the heuristic baseline on the SAME held-out
groups, because "training finished" is not evidence of anything. A model that
does not beat the heuristic has no business serving traffic.

    python ml/evaluation/evaluate_ranker.py --model ml/artifacts/<version>/model.txt
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import defaultdict
from typing import Any, Callable, Dict, List

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))


def dcg(relevances: List[float], k: int) -> float:
    return sum((2 ** rel - 1) / math.log2(i + 2) for i, rel in enumerate(relevances[:k]))


def ndcg_at_k(relevances: List[float], k: int) -> float:
    ideal = dcg(sorted(relevances, reverse=True), k)
    return (dcg(relevances, k) / ideal) if ideal > 0 else 0.0


def mrr(relevances: List[float]) -> float:
    for i, rel in enumerate(relevances):
        if rel > 0:
            return 1.0 / (i + 1)
    return 0.0


def precision_at_k(relevances: List[float], k: int) -> float:
    top = relevances[:k]
    return (sum(1 for r in top if r > 0) / len(top)) if top else 0.0


def recall_at_k(relevances: List[float], k: int) -> float:
    total = sum(1 for r in relevances if r > 0)
    if not total:
        return 0.0
    return sum(1 for r in relevances[:k] if r > 0) / total


def average_precision(relevances: List[float], k: int) -> float:
    hits, total, score = 0, sum(1 for r in relevances if r > 0), 0.0
    if not total:
        return 0.0
    for i, rel in enumerate(relevances[:k]):
        if rel > 0:
            hits += 1
            score += hits / (i + 1)
    return score / min(total, k)


def business_metrics(rows: List[Dict[str, Any]], top_k: int) -> Dict[str, float]:
    """Product-level outcomes among the items the model would have surfaced."""
    groups = defaultdict(list)
    for r in rows:
        groups[r["group_key"]].append(r)
    shown = clicks = saves = messages = tx = 0
    for grows in groups.values():
        ordered = sorted(grows, key=lambda r: r.get("_pred", 0.0), reverse=True)[:top_k]
        for r in ordered:
            shown += 1
            types = set((r.get("engagement_types") or "").split(","))
            if types & {"click", "detail_view", "dwell_30s"}:
                clicks += 1
            if "save" in types:
                saves += 1
            if "message_sent" in types:
                messages += 1
            if types & {"transaction_confirmed", "offer_accepted", "marked_sold", "marked_rented"}:
                tx += 1
    d = float(shown) or 1.0
    return {
        "ctr": round(clicks / d, 5),
        "save_rate": round(saves / d, 5),
        "message_rate": round(messages / d, 5),
        "transaction_rate": round(tx / d, 5),
        "impressions_evaluated": shown,
    }


def evaluate_split(booster, rows: List[Dict[str, Any]], cat_maps: Dict[str, Dict[str, int]],
                   to_matrix: Callable, ks: List[int] = (5, 10)) -> Dict[str, Any]:
    """Score held-out rows and compute every ranking metric."""
    X, y, _w, _names = to_matrix(rows, cat_maps)
    preds = booster.predict(X, num_iteration=booster.best_iteration)
    for r, p in zip(rows, preds):
        r["_pred"] = float(p)

    groups = defaultdict(list)
    for r in rows:
        groups[r["group_key"]].append(r)

    acc: Dict[str, List[float]] = defaultdict(list)
    for grows in groups.values():
        if len(grows) < 2:
            continue
        ordered = sorted(grows, key=lambda r: r["_pred"], reverse=True)
        rels = [float(r["label"]) for r in ordered]
        for k in ks:
            acc["ndcg@" + str(k)].append(ndcg_at_k(rels, k))
            acc["precision@" + str(k)].append(precision_at_k(rels, k))
            acc["recall@" + str(k)].append(recall_at_k(rels, k))
            acc["map@" + str(k)].append(average_precision(rels, k))
        acc["mrr"].append(mrr(rels))

    out: Dict[str, Any] = {k: round(sum(v) / len(v), 5) for k, v in acc.items() if v}
    out["groups_evaluated"] = len([g for g in groups.values() if len(g) >= 2])
    out.update({"business_" + k: v for k, v in business_metrics(rows, max(ks)).items()})
    return out


def main() -> int:
    from ml.common import load_config
    from ml.training.train_ranker import build_cat_maps, heuristic_baseline, load_dataset, to_matrix

    ap = argparse.ArgumentParser(description="Evaluate a trained ranker against the heuristic baseline")
    ap.add_argument("--model", required=True)
    ap.add_argument("--config", default=None)
    ap.add_argument("--split", default="test", choices=["train", "valid", "test"])
    args = ap.parse_args()

    import lightgbm as lgb
    cfg = load_config(args.config)
    ds = os.path.join(cfg["paths"]["datasets"], cfg["dataset"]["version"], "dataset.jsonl")
    rows = load_dataset(ds)
    booster = lgb.Booster(model_file=args.model)

    cat_maps = build_cat_maps(rows)
    subset = [r for r in rows if r["split"] == args.split]
    metrics = evaluate_split(booster, subset, cat_maps, to_matrix, ks=cfg["training"]["eval_at"])
    baseline = heuristic_baseline(subset, k=10)
    metrics["heuristic_baseline_ndcg@10"] = round(baseline, 5)
    metrics["ndcg_lift_over_baseline"] = round(metrics.get("ndcg@10", 0.0) - baseline, 5)

    print(json.dumps(metrics, indent=2))
    verdict = "BEATS" if metrics["ndcg_lift_over_baseline"] >= cfg["gates"]["minimum_improvement_over_baseline"] else "DOES NOT BEAT"
    print()
    print("Verdict: model " + verdict + " the heuristic baseline by the required margin.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
