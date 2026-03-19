# ezmsg-dashboard

Web dashboard for monitoring and controlling running `ezmsg` systems.

This repository is a namespace package extension (`ezmsg.dashboard`) and follows the same packaging style as sibling projects like `ezmsg-sigproc` and `ezmsg-panel`.

## Current Direction

- Frontend-first architecture: React + TypeScript
- Python bridge service: FastAPI + `GraphContext` integration
- Initial dashboard scope: topology, profiling, process visibility, settings control

## Local Development

```bash
cd /Users/milsagw1/repos/ezmsg-dashboard
uv sync --group dev
```

`pyproject.toml` is currently configured to use local editable `ezmsg` source:

```toml
[tool.uv.sources]
ezmsg = { path = "../ezmsg", editable = true }
```

## Running Dashboard

In two separate terminals:
```bash
uv run uvicorn ezmsg.dashboard.backend.app:app --reload --port 8000
```
```bash
cd frontend && npm run dev
```

