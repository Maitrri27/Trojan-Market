#!/usr/bin/env python3
"""Model inference service.

    python ml/serve/inference_api.py --port 8500

A deliberately small HTTP service (stdlib only) that loads the active or shadow
model from the registry and scores candidate rows. The Node app calls POST
/score with a hard timeout and falls back to heuristic ranking on ANY failure,
so this process going down degrades ranking quality but never availability.

    POST /score  {model_version, feature_version, context, rows: [...]}
    ->           {scores: {listing_id: float}, model_version, latency_ms}
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ml.common import load_config  # noqa: E402
from ml.features.recommendation_features import CATEGORICAL_FEATURES, NUMERIC_FEATURES  # noqa: E402
from ml.registry.registry import list_models  # noqa: E402

STATE: Dict[str, Any] = {"booster": None, "meta": None, "model": None, "loaded_at": None}


def pick_model(cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    models = list_models(cfg, "recommendations")
    for status in ("active", "shadow"):
        matches = [m for m in models if m.get("status") == status]
        if matches:
            return sorted(matches, key=lambda m: m.get("training_timestamp", ""), reverse=True)[0]
    return None


def load_model(cfg: Dict[str, Any]) -> bool:
    import lightgbm as lgb
    model = pick_model(cfg)
    if not model:
        STATE.update({"booster": None, "meta": None, "model": None})
        return False
    art = model["artifact_location"]
    meta_path = os.path.join(os.path.dirname(art), "feature_metadata.json")
    if not (os.path.exists(art) and os.path.exists(meta_path)):
        print("[inference] artifact missing for", model["model_id"])
        return False
    with open(meta_path, "r", encoding="utf-8") as fh:
        meta = json.load(fh)
    STATE.update({
        "booster": lgb.Booster(model_file=art),
        "meta": meta, "model": model, "loaded_at": time.time(),
    })
    print("[inference] loaded", model["model_id"], "status=" + model["status"])
    return True


def vectorise(rows: List[Dict[str, Any]], meta: Dict[str, Any]):
    import numpy as np
    names = meta["feature_names"]
    cat_maps = meta["categorical_maps"]
    X = np.full((len(rows), len(names)), np.nan, dtype=np.float64)
    for i, r in enumerate(rows):
        for j, f in enumerate(NUMERIC_FEATURES):
            v = r.get(f)
            if isinstance(v, (int, float)) and v is not None:
                X[i, j] = float(v)
        for k, f in enumerate(CATEGORICAL_FEATURES):
            X[i, len(NUMERIC_FEATURES) + k] = cat_maps.get(f, {}).get(str(r.get(f)), -1)
    return X


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):   # quiet
        pass

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            m = STATE.get("model")
            return self._send(200, {
                "ok": True,
                "model_loaded": bool(STATE.get("booster")),
                "model_id": m.get("model_id") if m else None,
                "status": m.get("status") if m else None,
                "feature_version": (STATE.get("meta") or {}).get("feature_version"),
            })
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/score":
            return self._send(404, {"error": "not found"})
        t0 = time.time()
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._send(400, {"error": "bad request: " + str(e)})

        booster, meta, model = STATE.get("booster"), STATE.get("meta"), STATE.get("model")
        if booster is None:
            return self._send(503, {"error": "no model loaded", "scores": {}})

        want = payload.get("feature_version")
        if want and meta.get("feature_version") != want:
            return self._send(409, {
                "error": "feature version mismatch",
                "server": meta.get("feature_version"), "client": want, "scores": {},
            })

        rows = payload.get("rows") or []
        if not rows:
            return self._send(200, {"scores": {}, "model_version": model["version"], "latency_ms": 0})

        try:
            X = vectorise(rows, meta)
            preds = booster.predict(X, num_iteration=meta.get("best_iteration"))
            scores = {r.get("listing_id"): float(p) for r, p in zip(rows, preds)}
        except Exception as e:
            return self._send(500, {"error": "inference failed: " + str(e), "scores": {}})

        return self._send(200, {
            "scores": scores,
            "model_version": model["version"],
            "model_status": model["status"],
            "latency_ms": round((time.time() - t0) * 1000, 2),
        })


def main() -> int:
    ap = argparse.ArgumentParser(description="Serve the recommendation ranker")
    ap.add_argument("--port", type=int, default=8500)
    ap.add_argument("--config", default=None)
    args = ap.parse_args()
    cfg = load_config(args.config)

    if not load_model(cfg):
        print("=" * 72)
        print("No active or shadow model in the registry.")
        print("Starting anyway: /score will return 503 and the Node app will")
        print("fall back to heuristic ranking, which is the correct behaviour.")
        print("=" * 72)

    srv = HTTPServer(("0.0.0.0", args.port), Handler)
    print("[inference] listening on http://localhost:" + str(args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
