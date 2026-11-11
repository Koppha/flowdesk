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

## Production

Use a machine with a GPU (or at least 16 GB RAM free) for a 7-8B model such as
`qwen2.5:7b` - answers are much better and faster. Run it the same way; if it's
on another host, bind it to that host's internal address instead of 127.0.0.1,
firewall port 11434 to the FlowDesk backends only, and enter that address in
Settings > AI Assistant.
