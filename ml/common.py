"""Shared plumbing for the Trojan Market ML pipeline."""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = REPO_ROOT / "ml" / "config.yaml"


def load_config(path: Optional[str] = None) -> Dict[str, Any]:
    p = Path(path) if path else DEFAULT_CONFIG
    if yaml is None:
        raise RuntimeError("pyyaml is required: pip install -r ml/requirements.txt")
    with open(p, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    for k, v in cfg.get("paths", {}).items():
        cfg["paths"][k] = v if os.path.isabs(v) else str(REPO_ROOT / v)
    return cfg


def read_events(path: str, since_ms: Optional[int] = None) -> Iterator[Dict[str, Any]]:
    """Stream the append-only event log. Never loads it fully into memory."""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if since_ms and ev.get("timestamp", 0) < since_ms:
                continue
            yield ev


def read_db(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def content_hash(obj: Any) -> str:
    """Stable hash used for dataset + config provenance."""
    blob = json.dumps(obj, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:16]


def ensure_dir(path: str) -> str:
    Path(path).mkdir(parents=True, exist_ok=True)
    return path


@dataclass
class GateResult:
    passed: bool
    reasons: List[str] = field(default_factory=list)
    checked: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {"passed": self.passed, "reasons": self.reasons, "checked": self.checked}


def check_gates(gates: Dict[str, Any], stats: Dict[str, Any], metrics: Dict[str, Any]) -> GateResult:
    """The single place that decides whether a model may ever serve traffic."""
    reasons: List[str] = []
    checked: Dict[str, Any] = {}

    def need(name: str, actual, required):
        checked[name] = {"actual": actual, "required": required}
        if actual is None:
            reasons.append(name + ": not measured")
        elif actual < required:
            reasons.append(name + ": " + str(actual) + " < required " + str(required))

    need("training_examples", stats.get("n_examples"), gates["minimum_training_examples"])
    need("unique_users", stats.get("n_users"), gates["minimum_unique_users"])
    need("unique_sessions", stats.get("n_sessions"), gates["minimum_unique_sessions"])
    need("positive_events", stats.get("n_positives"), gates["minimum_positive_events"])
    need("test_ndcg@10", metrics.get("ndcg@10"), gates["minimum_test_score"])
    need("improvement_over_baseline", metrics.get("ndcg_lift_over_baseline"),
         gates["minimum_improvement_over_baseline"])

    return GateResult(passed=not reasons, reasons=reasons, checked=checked)


class InsufficientData(RuntimeError):
    """Raised when there is not enough real data to train honestly."""
