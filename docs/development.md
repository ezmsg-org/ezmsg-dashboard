# Development Guide

This page collects the maintainer-facing material that does not need to live in the root README.

## Repository Layout

- `src/ezmsg/dashboard/backend/`: FastAPI backend and `GraphContext` integration
- `frontend/`: React + TypeScript dashboard UI
- `tests/backend/`: backend tests
- `frontend/tests/e2e/`: Playwright end-to-end and screenshot tests
- `docs/`: user-facing and maintainer-facing documentation

## Requirements

- Python `>=3.11`
- Node.js with npm if you are developing the frontend or refreshing the packaged frontend bundle
- a local `ezmsg` checkout if you want to use the editable source override already configured in `pyproject.toml`

The repo currently expects:

```toml
[tool.uv.sources]
ezmsg = { path = "../ezmsg", editable = true }
```

If your local `ezmsg` checkout lives somewhere else, update that path or remove the override.

## Setup

Install Python dependencies:

```bash
uv sync --group dev
```

Install frontend dependencies:

```bash
cd frontend
npm install
```

## Running Locally

### End-user runtime

After installing `ezmsg` and `ezmsg-dashboard`, launch the packaged dashboard server directly:

```bash
ezmsg dashboard --graph-address 127.0.0.1:25978
```

or use the fallback console script:

```bash
ezmsg-dashboard --graph-address 127.0.0.1:25978
```

This starts the Python backend and serves the packaged frontend from the same process.

If you want core `ezmsg` to host the graph server and dashboard together:

```bash
ezmsg serve --dashboard
```

### Development mode

Run the backend API:

```bash
uv run uvicorn ezmsg.dashboard.backend.app:app --reload --port 8000
```

Run the frontend dev server in a separate terminal:

```bash
cd frontend
npm run dev
```

In development, Vite serves the frontend and proxies API traffic to the Python backend. In release mode, the Python package serves both.

The backend serves:

- `GET /api/health`
- `GET /api/snapshot`
- `GET /api/settings`
- `POST /api/settings/{component_address}/field`
- `POST /api/profiling/trace-control`
- `WS /ws/events`

## Testing

Backend tests:

```bash
PYTHONPYCACHEPREFIX=/tmp/pycache .venv/bin/pytest tests/backend -q
```

Frontend unit tests:

```bash
cd frontend
npm test
```

Frontend end-to-end tests:

```bash
cd frontend
npm run test:e2e
```

Refresh Playwright screenshot baselines intentionally:

```bash
cd frontend
npm run test:e2e:update-snapshots
```

Verify the vendored frontend bundle matches `frontend/dist`:

```bash
uv run python -m ezmsg.dashboard.build_frontend --check
```

## Frontend Fixture Mode

The frontend includes deterministic fixture scenarios for stress-testing layout and inspector behavior without a live backend.

Examples:

- `/?fixture=long-labels`
- `/?fixture=nested-collections`
- `/?fixture=massive-fanout`
- `/?fixture=dense-unit-layout`
- `/?fixture=cyclic-feedback`
- `/?fixture=profiling-trace-rates`

These fixtures are used by Playwright to validate:

- graph readability
- scope navigation
- long-label behavior
- dense and cyclic graph layout
- publisher/subscriber inspector behavior
- sparse and dense profiling traces
- screenshot-based visual regressions on curated graph states

## Development Notes

- The frontend test strategy is intentionally mixed:
  - unit tests for pure topology and selection helpers
  - Playwright interaction tests for graph and inspector behavior
  - a small set of screenshot baselines for high-value readability checks
- The screenshot suite is intentionally narrow. It is meant to catch meaningful visual regressions, not lock the UI to exact pixel output everywhere.

## Release Workflow

When the frontend changes, refresh the packaged assets before publishing:

```bash
cd frontend
npm ci
npm run build
cd ..
uv run python -m ezmsg.dashboard.build_frontend
```

Then verify the package and tests:

```bash
PYTHONPYCACHEPREFIX=/tmp/pycache .venv/bin/pytest tests/backend -q
uv run python -m build
```

The `_web/` bundle under `src/ezmsg/dashboard/` is part of the Python package and should be updated as part of the release.
