#!/usr/bin/env bash
# Full retraining workflow. Nothing here promotes a model automatically.
#
#   collect events -> build dataset -> train -> evaluate -> compare
#   -> register as candidate -> [manual] shadow -> [manual] active
#
# Usage:  bash ml/retrain.sh [--allow-small]
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/5 exporting static housing attributes"
node ml/export_house_detail.js

echo "==> 2/5 building training dataset from the raw event log"
python ml/data/build_recommendation_dataset.py || {
  echo "Dataset not built. Heuristic ranking stays active. Stopping."
  exit 0
}

echo "==> 3/5 training LightGBM LambdaRank"
python ml/training/train_ranker.py "$@" || {
  echo "Training skipped or failed. Heuristic ranking stays active. Stopping."
  exit 0
}

echo "==> 4/5 registry state"
python ml/registry/registry.py --list

echo "==> 5/5 next steps"
cat <<'EOF'

A model was registered as a CANDIDATE (or rejected if it failed a gate).
It is NOT serving traffic. To roll it out safely:

  1. Shadow it (computed, logged, never shown):
       python ml/registry/registry.py --promote <model_id> --status shadow
       python ml/serve/inference_api.py --port 8500
       TM_ML_ENABLED=true TM_ML_URL=http://localhost:8500 npm start

     Watch  GET /api/admin/overview  ->  ml.shadow_comparison
     for a week or more of real traffic.

  2. A/B test it:
       POST /api/ml/experiments
         {"name":"ml_ranker_v1","control_variant":"heuristic",
          "treatment_variant":"ml_blend","traffic_split":0.5,
          "primary_metric":"save_rate"}

     Read out:  GET /api/admin/experiments/<id>/results
     Judge on save / message / transaction rate — NOT clicks alone.

  3. Promote and ramp the blend weight gradually:
       python ml/registry/registry.py --promote <model_id> --status active
       TM_ML_WEIGHT=0.2 npm start     # then 0.4, 0.6, ...

  The heuristic ranker never goes away: it remains the fallback for every
  inference failure, timeout, and cold-start user.
EOF
