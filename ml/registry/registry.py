#!/usr/bin/env python3
"""Model registry — written by the trainer, read by the Node service.

Lifecycle:  candidate -> shadow -> active -> archived
                      \-> rejected (failed a confidence gate)

Only one model per use case may be 'active'. Promotion to 'active' re-checks
the gates, so a model can never be activated by editing a status by hand.

    python ml/registry/registry.py --list
    python ml/registry/registry.py --promote <model_id> --status shadow
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ml.common import check_gates, ensure_dir, load_config, utc_now_iso  # noqa: E402

STATUSES = ["candidate", "shadow", "active", "archived", "rejected"]


def _read(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {"registry_version": 1, "models": [], "updated_at": None}
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write(path: str, reg: Dict[str, Any]) -> None:
    reg["updated_at"] = utc_now_iso()
    ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(reg, fh, indent=2)


def register_model(cfg: Dict[str, Any], record: Dict[str, Any]) -> Dict[str, Any]:
    path = cfg["paths"]["registry"]
    reg = _read(path)
    record = dict(record)
    record.setdefault("model_id", record["version"])
    record.setdefault("created_at", utc_now_iso())
    reg["models"] = [m for m in reg.get("models", []) if m.get("model_id") != record["model_id"]]
    reg["models"].append(record)
    _write(path, reg)
    return record


def list_models(cfg: Dict[str, Any], use_case: Optional[str] = None) -> List[Dict[str, Any]]:
    models = _read(cfg["paths"]["registry"]).get("models", [])
    return [m for m in models if not use_case or m.get("use_case") == use_case]


def promote(cfg: Dict[str, Any], model_id: str, status: str) -> Dict[str, Any]:
    if status not in STATUSES:
        raise ValueError("Unknown status: " + status)
    path = cfg["paths"]["registry"]
    reg = _read(path)
    target = next((m for m in reg.get("models", []) if m.get("model_id") == model_id), None)
    if target is None:
        raise KeyError("No such model: " + model_id)

    if status == "active":
        gate = check_gates(cfg["gates"], target.get("dataset_stats", {}), target.get("metrics", {}))
        if not gate.passed:
            raise PermissionError(
                "Refusing to activate " + model_id + " — confidence gates not satisfied:\n  "
                + "\n  ".join(gate.reasons)
            )
        for m in reg["models"]:
            if m.get("use_case") == target.get("use_case") and m.get("status") == "active":
                m["status"] = "archived"
                m["status_changed_at"] = utc_now_iso()

    target["status"] = status
    target["status_changed_at"] = utc_now_iso()
    _write(path, reg)
    return target


def main() -> int:
    ap = argparse.ArgumentParser(description="Inspect or promote registered models")
    ap.add_argument("--config", default=None)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--promote")
    ap.add_argument("--status", choices=STATUSES)
    args = ap.parse_args()
    cfg = load_config(args.config)

    if args.promote:
        if not args.status:
            print("--status is required with --promote")
            return 1
        try:
            m = promote(cfg, args.promote, args.status)
        except (KeyError, PermissionError, ValueError) as e:
            print(str(e))
            return 1
        print(m["model_id"], "->", m["status"])
        return 0

    models = list_models(cfg)
    if not models:
        print("No models registered. The service is running on heuristic ranking.")
        return 0
    for m in models:
        met = m.get("metrics", {})
        print("{:<44} {:<10} ndcg@10={:<8} lift={:<8} {}".format(
            m.get("model_id", "?"), m.get("status", "?"),
            met.get("ndcg@10", "-"), met.get("ndcg_lift_over_baseline", "-"),
            m.get("algorithm", ""),
        ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
