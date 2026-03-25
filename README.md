# ezmsg-dashboard

`ezmsg-dashboard` is a web dashboard for inspecting and operating running `ezmsg` systems.

It combines:
- a Python backend that talks to `GraphContext`
- a React/TypeScript frontend for topology, publishers, settings, and trace visualization
- fixture-backed tests for graph layout, inspector behavior, profiling, and visual regression coverage

This package is published as `ezmsg.dashboard` and follows the namespace packaging style used by other `ezmsg` extensions.

## Features

- Live topology rendering with left-to-right and top-to-bottom layouts
- Scoped collection navigation with breadcrumb and in-graph open/up controls
- Settings inspection and patching
- Publisher and subscriber profiling views
- Profiling trace capture and timing visualization
- Frontend fixture mode for deterministic graph and profiling scenarios
- Unit, Playwright, and screenshot-based regression tests

## Repository Layout

- `src/ezmsg/dashboard/backend/`: FastAPI backend and `GraphContext` integration
- `frontend/`: React + TypeScript dashboard UI
- `tests/backend/`: backend tests
- `frontend/tests/e2e/`: Playwright end-to-end and screenshot tests

## Requirements

- Python `>=3.11`
- Node.js with npm
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

Run the backend:

```bash
uv run uvicorn ezmsg.dashboard.backend.app:app --reload --port 8000
```

Run the frontend in a separate terminal:

```bash
cd frontend
npm run dev
```

By default the frontend is served by Vite and the backend serves:

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

## License

MIT. See [LICENSE.txt](/Users/milsagw1/repos/ezmsg-dashboard/LICENSE.txt).
