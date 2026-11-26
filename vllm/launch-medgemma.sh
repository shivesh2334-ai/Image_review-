#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-4b}"

case "$PROFILE" in
  4b|medgemma-1.5-4b)
    CONFIG_FILE="$SCRIPT_DIR/medgemma-1.5-4b.yaml"
    ;;
  1.5|medgemma-1.5)
    CONFIG_FILE="$SCRIPT_DIR/medgemma-1.5.yaml"
    ;;
  *)
    echo "Usage: $0 [4b|1.5]" >&2
    exit 1
    ;;
esac

if [[ -z "${HF_TOKEN:-}" && -z "${HUGGING_FACE_HUB_TOKEN:-}" ]]; then
  echo "Warning: HF_TOKEN is not set. google/medgemma-1.5-4b-it is a gated Hugging Face model." >&2
  echo "Accept the license at https://huggingface.co/google/medgemma-1.5-4b-it and export HF_TOKEN before launching." >&2
fi

EXTRA_ARGS=()
if [[ -n "${VLLM_API_KEY:-}" ]]; then
  EXTRA_ARGS+=(--api-key "$VLLM_API_KEY")
fi

exec vllm serve --config "$CONFIG_FILE" "${EXTRA_ARGS[@]}"
