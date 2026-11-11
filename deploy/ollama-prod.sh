#!/usr/bin/env bash
# FlowDesk AI Assistant - Ollama on a PROD app server (CPU), next to FlowDesk.
#
# Run on EACH PROD node (PROD1 and PROD2): the AI settings are shared in the
# database, so the address FlowDesk uses (http://127.0.0.1:11434/v1) must
# answer on every node. See deploy/OLLAMA.md.
#
#   bash deploy/ollama-prod.sh            # picks the model from free memory
#   bash deploy/ollama-prod.sh qwen2.5:7b # or name it
#
# Needs Docker (the user in the docker group, or run with sudo). Ollama is
# published on 127.0.0.1 only and capped in memory and CPU so it can't starve
# FlowDesk. Safe to re-run: it replaces the container, keeps downloaded models.
set -euo pipefail

IMAGE="ollama/ollama:0.40.16"
NAME="ollama"
PORT=11434

command -v docker >/dev/null || { echo "Docker is not installed - install it first (or use a separate AI host, see OLLAMA.md)."; exit 1; }
docker info >/dev/null 2>&1 || { echo "Can't talk to Docker - add this user to the docker group or run with sudo."; exit 1; }

avail_gb=$(awk '/MemAvailable/ {printf "%d", $2/1024/1024}' /proc/meminfo)
cpus=$(nproc)
echo "Memory available: ${avail_gb} GB, CPUs: ${cpus}"

MODEL="${1:-}"
if [ -z "$MODEL" ]; then
  # Leave FlowDesk at least 4 GB. 7B needs ~6 GB loaded, 14B ~11 GB (8k context).
  if   [ "$avail_gb" -ge 18 ]; then MODEL="qwen2.5:14b"
  elif [ "$avail_gb" -ge 10 ]; then MODEL="qwen2.5:7b"
  else
    echo "Only ${avail_gb} GB free: too little for a 7B model next to FlowDesk."
    echo "Free memory, add RAM, use a separate AI host, or pass a small model (e.g. qwen2.5:3b)."
    exit 1
  fi
fi
case "$MODEL" in
  *14b*) MEM="14g" ;;
  *7b*|*8b*) MEM="8g" ;;
  *) MEM="4g" ;;
esac
# Use most cores but always leave 2 for FlowDesk.
USE_CPUS=$(( cpus > 4 ? cpus - 2 : 2 ))
echo "Model: ${MODEL}  (container memory ${MEM}, ${USE_CPUS} CPUs)"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p 127.0.0.1:${PORT}:11434 --memory "$MEM" --memory-swap "$MEM" --cpus "$USE_CPUS" \
  -e OLLAMA_KEEP_ALIVE=30m -e OLLAMA_NUM_PARALLEL=1 -e OLLAMA_MAX_LOADED_MODELS=1 \
  -e OLLAMA_CONTEXT_LENGTH=8192 \
  -v ollama:/root/.ollama "$IMAGE" >/dev/null

for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${PORT}/api/version" >/dev/null && break; sleep 1; done
echo "Ollama $(curl -s http://127.0.0.1:${PORT}/api/version)"

echo "Downloading ${MODEL} (several GB, once)..."
docker exec "$NAME" ollama pull "$MODEL"

echo "Checking it can call FlowDesk's lookups (tool calling)..."
start=$(date +%s)
answer=$(curl -s "http://127.0.0.1:${PORT}/v1/chat/completions" -H "Content-Type: application/json" -d "{
  \"model\": \"${MODEL}\",
  \"messages\": [{\"role\": \"user\", \"content\": \"How many advances do I have?\"}],
  \"tools\": [{\"type\": \"function\", \"function\": {\"name\": \"list_my_advances\", \"description\": \"The person's advances\", \"parameters\": {\"type\": \"object\", \"properties\": {}}}}]
}")
took=$(( $(date +%s) - start ))
if echo "$answer" | grep -q '"list_my_advances"'; then
  echo "OK - the model called the lookup (${took}s, includes loading the model)."
else
  echo "The model did not call the lookup - answer was:"; echo "$answer" | head -c 600; echo
  exit 1
fi

cat <<EOF

Done on $(hostname). Next:
 1. Run this on the other PROD node too.
 2. In FlowDesk PROD: Settings > AI Assistant > Add a service > "Ollama (own server)",
    address http://127.0.0.1:${PORT}/v1, no key, model ${MODEL}.
    Put it first in the order to use it by default, or leave the cloud models first
    and let people pick it (Settings > "Let people pick their model").
EOF
