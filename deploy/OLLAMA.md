# Ollama (AI Assistant on our own server)

FlowDesk's AI Assistant can use a model running on our own server through
Ollama - nothing leaves the network and there are no per-question costs.
Settings > AI Assistant > Add a service > "Ollama (own server)", address
`http://127.0.0.1:11434/v1`, no key.

## How it runs (UAT, 10.3.10.59)

In Docker (the `developer` account is in the docker group - no root needed),
reachable only from the server itself, with memory and CPU capped so it can't
starve the backend:

```sh
docker run -d --name ollama --restart unless-stopped \
  -p 127.0.0.1:11434:11434 --memory 4g --memory-swap 4g --cpus 6 \
  -e OLLAMA_KEEP_ALIVE=15m -e OLLAMA_NUM_PARALLEL=1 -e OLLAMA_MAX_LOADED_MODELS=1 \
  -e OLLAMA_CONTEXT_LENGTH=8192 \
  -v ollama:/root/.ollama ollama/ollama:0.40.16
docker exec ollama ollama pull qwen2.5:3b
```

- `qwen2.5:3b` (~2 GB) supports tool calling, which the assistant needs for
  its FlowDesk lookups. On CPU only, the first answer after an idle spell takes
  ~15 s (loading the model); later ones a few seconds.
- 8k context: FlowDesk's instructions plus lookup results don't fit Ollama's
  default.
- Stop / remove: `docker stop ollama`, `docker rm ollama`, `docker volume rm ollama`.

## Production (on the PROD app servers)

Run `deploy/ollama-prod.sh` on **each** PROD node (PROD1 and PROD2). The AI
settings are shared in the database, so the address FlowDesk is given -
`http://127.0.0.1:11434/v1` - has to answer on every node that serves the
assistant.

```sh
bash deploy/ollama-prod.sh             # picks the model from free memory
bash deploy/ollama-prod.sh qwen2.5:7b  # or name it
```

The script needs Docker, keeps Ollama on 127.0.0.1 only, caps its memory and
leaves 2 CPUs to FlowDesk, downloads the model, and checks the model can call
FlowDesk's lookups. Model by free memory (FlowDesk keeps at least 4 GB):

| Free memory | Model | Container memory |
|---|---|---|
| 18 GB+ | `qwen2.5:14b` - best answers | 14 GB |
| 10-18 GB | `qwen2.5:7b` - good, recommended minimum for PROD | 8 GB |
| less | refused - add RAM or use a separate AI host | - |

On CPU only, expect a 7B model to take ~10-30 s per answer (longer the first
time after an idle half hour, while it loads) and a 14B model about twice
that; one question is answered at a time per node. A GPU host makes both a
few seconds - then run the same container with `--gpus all` there, bind it to
that host's internal address instead of 127.0.0.1, firewall port 11434 to the
FlowDesk backends only, and enter that address in Settings > AI Assistant.

Then in FlowDesk PROD: Settings > AI Assistant > Add a service > "Ollama (own
server)", address `http://127.0.0.1:11434/v1`, no key, the model name. Put it
first to use it by default, or keep the cloud models first and let people pick
it ("Let people pick their model").
