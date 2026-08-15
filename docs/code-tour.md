# Code Tour

This is a maintainer-oriented walkthrough of `ezmsg-dashboard`.

The goal is not to describe every line. The goal is to give one human a reliable path through the codebase so they can answer:

- What runs at startup?
- Where does graph data come from?
- How does the frontend turn that data into the UI?
- Which files are safe to change in isolation?
- Which files are the real complexity hotspots?

## High-Level Shape

`ezmsg-dashboard` is two applications shipped as one package:

1. A Python backend that opens an `ezmsg` `GraphContext`, exposes HTTP/WebSocket routes, and serves a built frontend bundle.
2. A React/TypeScript frontend that renders topology, settings, profiling snapshots, and trace timing views.

At runtime the data flow is:

1. `ezmsg dashboard` starts [`server.py`](../src/ezmsg/dashboard/server.py).
2. The server builds a FastAPI app from [`backend/app.py`](../src/ezmsg/dashboard/backend/app.py).
3. The app starts [`GraphContextLifecycleService`](../src/ezmsg/dashboard/backend/services/graph_context_service.py), which owns the live `GraphContext`.
4. The frontend loads an initial snapshot over HTTP.
5. The frontend keeps itself fresh with snapshot polling plus a WebSocket event stream.
6. UI actions send narrow POST requests for settings patches or profiling trace control.

## Code Size

Approximate authored surface area, excluding `node_modules`, `.venv`, and the minified packaged frontend assets:

- About **16.4k lines** total in maintained source, tests, docs, and config.
- About **14.2k lines** of application code in `src/` plus `frontend/src/`.
- About **1.4k lines** of backend Python in `src/`.
- About **12.8k lines** of frontend source in `frontend/src/`.
- About **1.4k lines** of tests split between backend pytest and frontend Playwright/Vitest.

Largest files:

- [`frontend/src/styles.css`](../frontend/src/styles.css): visual system and layout styling.
- [`frontend/src/components/topologyFlowData.tsx`](../frontend/src/components/topologyFlowData.tsx): topology-to-React-Flow transformation.
- [`frontend/src/fixtures/dashboardFixtures.ts`](../frontend/src/fixtures/dashboardFixtures.ts): deterministic scenarios used for development and visual tests.
- [`frontend/src/components/TraceTimingPanel.tsx`](../frontend/src/components/TraceTimingPanel.tsx): canvas trace renderer.
- [`frontend/src/components/ProfilingPanel.tsx`](../frontend/src/components/ProfilingPanel.tsx): profiling explorer and trace control UI.
- [`frontend/src/App.tsx`](../frontend/src/App.tsx): top-level coordination and shell state.
- [`src/ezmsg/dashboard/backend/services/graph_context_service.py`](../src/ezmsg/dashboard/backend/services/graph_context_service.py): backend lifecycle and event orchestration.

Interpretation:

- The backend is comparatively small and easy to survey.
- Most complexity is in frontend layout/state logic, not in request handling.
- The topology view is the hardest part to modify safely.

## Repository Map

- [`src/ezmsg/dashboard/server.py`](../src/ezmsg/dashboard/server.py): CLI entrypoint and embeddable server helpers.
- [`src/ezmsg/dashboard/backend/app.py`](../src/ezmsg/dashboard/backend/app.py): FastAPI app factory, routes, WebSocket, static frontend mount.
- [`src/ezmsg/dashboard/backend/services/`](../src/ezmsg/dashboard/backend/services): `GraphContext` lifecycle, protocol, and payload adapters.
- [`frontend/src/App.tsx`](../frontend/src/App.tsx): app shell and inspector/topology coordination.
- [`frontend/src/hooks/useDashboardData.ts`](../frontend/src/hooks/useDashboardData.ts): HTTP/WebSocket client state.
- [`frontend/src/components/`](../frontend/src/components): topology, settings, profiling, and trace UI.
- [`frontend/src/fixtures/dashboardFixtures.ts`](../frontend/src/fixtures/dashboardFixtures.ts): fixture mode for deterministic UI/test scenarios.
- [`tests/backend/`](../tests/backend): backend API and service tests.
- [`frontend/tests/e2e/dashboard.spec.ts`](../frontend/tests/e2e/dashboard.spec.ts): interaction and screenshot-level frontend tests.

## Read This First

If you only have 30 minutes, read in this order:

1. [`README.md`](../README.md)
2. [`src/ezmsg/dashboard/server.py`](../src/ezmsg/dashboard/server.py)
3. [`src/ezmsg/dashboard/backend/app.py`](../src/ezmsg/dashboard/backend/app.py)
4. [`src/ezmsg/dashboard/backend/services/graph_context_service.py`](../src/ezmsg/dashboard/backend/services/graph_context_service.py)
5. [`frontend/src/hooks/useDashboardData.ts`](../frontend/src/hooks/useDashboardData.ts)
6. [`frontend/src/App.tsx`](../frontend/src/App.tsx)
7. [`frontend/src/components/TopologyPanel.tsx`](../frontend/src/components/TopologyPanel.tsx)
8. [`frontend/src/components/topologyGraph.ts`](../frontend/src/components/topologyGraph.ts)
9. [`frontend/src/components/topologyFlowData.tsx`](../frontend/src/components/topologyFlowData.tsx)
10. [`frontend/src/components/SettingsPanel.tsx`](../frontend/src/components/SettingsPanel.tsx)
11. [`frontend/src/components/ProfilingPanel.tsx`](../frontend/src/components/ProfilingPanel.tsx)

That path tells the story from process startup to backend protocol to client state to visual rendering.

## Backend Tour

### 1. Server entrypoint

[`src/ezmsg/dashboard/server.py`](../src/ezmsg/dashboard/server.py) is intentionally thin.

What it does:

- normalizes the graph server address
- creates the dashboard FastAPI app
- optionally starts uvicorn on a background thread
- exposes the command-line interface

Important design point:

- The CLI layer does not know `GraphContext` details. It delegates runtime behavior to the app factory and service layer.

### 2. FastAPI app factory

[`src/ezmsg/dashboard/backend/app.py`](../src/ezmsg/dashboard/backend/app.py) is the backend composition root.

What lives here:

- lifespan startup/shutdown hooks
- route registration
- Pydantic request models
- WebSocket event bridge
- static frontend mounting and SPA fallback

The route surface is intentionally small:

- `GET /api/health`
- `GET /api/snapshot`
- `GET /api/settings`
- `POST /api/settings/{component_address}/field`
- `POST /api/profiling/trace-control`
- `WS /ws/events`

The SPA fallback logic is also here. Unknown browser paths fall back to `index.html`, but `/api/*` and `/ws/*` do not, which prevents static serving from masking backend mistakes.

### 3. Graph service lifecycle

[`src/ezmsg/dashboard/backend/services/graph_context_service.py`](../src/ezmsg/dashboard/backend/services/graph_context_service.py) is the real backend.

Responsibilities:

- own the `GraphContext` lifetime
- fetch snapshots
- mark settings as patchable or read-only
- send dynamic settings patches
- send profiling trace control commands
- multiplex topology/settings/profiling subscriptions into one event stream

This file is the best place to understand backend behavior because it contains almost all policy decisions.

Key ideas:

- `snapshot_payload()` fetches graph, settings, and profiling in parallel and returns one normalized payload.
- `_settings_with_patchability()` enriches raw settings with UI-oriented metadata like `patchable`, `patch_error`, `component_type`, and `component_name`.
- `set_profiling_trace_control()` is more than a thin pass-through. It can fan subscriber-side trace controls out to additional processes if subscriber timing metrics are requested.
- `event_envelopes()` starts three async workers and merges them into one queue feeding the WebSocket client.

### 4. Adapters and event models

Two smaller files matter:

- [`src/ezmsg/dashboard/backend/services/adapters.py`](../src/ezmsg/dashboard/backend/services/adapters.py)
- [`src/ezmsg/dashboard/backend/models/events.py`](../src/ezmsg/dashboard/backend/models/events.py)
- [`src/ezmsg/dashboard/backend/json_encoding.py`](../src/ezmsg/dashboard/backend/json_encoding.py)

These files define the browser protocol boundary.

`adapters.py` converts `ezmsg` dataclasses, enums, UUIDs, and snapshots into JSON-safe dictionaries. `events.py` defines the event envelope shapes shared by the backend WebSocket path and the frontend TypeScript types. `json_encoding.py` covers the values JSON has no literal for: non-finite floats travel as the tokens `"Infinity"`, `"-Infinity"`, and `"NaN"`, and settings patches carrying those tokens are decoded back to floats.

This separation is good practice: the backend can evolve internal types while keeping the browser contract explicit.

## Frontend Tour

### 1. App shell

[`frontend/src/App.tsx`](../frontend/src/App.tsx) is the shell, not the business logic engine.

It manages:

- which inspector pane is open
- which entity is selected
- global persisted UI settings
- topology focus requests
- trace dock visibility
- light/dark and layout mode toggles

Mental model:

- `App.tsx` decides **what the user is looking at**
- child components decide **how to render that data**

### 2. Data hook

[`frontend/src/hooks/useDashboardData.ts`](../frontend/src/hooks/useDashboardData.ts) is the client-side state coordinator.

It combines four behaviors:

- initial health and snapshot fetches
- steady snapshot polling
- WebSocket connection, reconnects, and event handling
- fixture mode that replaces the backend entirely for tests and demos

Important detail:

- topology changes trigger a debounced snapshot refresh instead of trying to fully reconstruct graph state from incremental events
- settings change events are applied optimistically into local state
- profiling trace events are streamed separately and stored as the latest batch

This is a pragmatic design. The backend provides authoritative snapshots; the frontend only performs limited incremental updates where that is cheap and safe.

### 3. Topology domain helpers

The topology view is split into several files on purpose:

- [`frontend/src/components/topologyGraph.ts`](../frontend/src/components/topologyGraph.ts): parse raw graph snapshot metadata into units, collections, streams, and tasks.
- [`frontend/src/components/topologyFlowData.tsx`](../frontend/src/components/topologyFlowData.tsx): transform classified topology into React Flow nodes and edges with coordinates and styling.
- [`frontend/src/components/topologyTrace.ts`](../frontend/src/components/topologyTrace.ts): highlight active publisher paths through the graph.
- [`frontend/src/components/topologySelection.ts`](../frontend/src/components/topologySelection.ts): map stream selection back to units/components.
- [`frontend/src/components/useTopologyFocus.ts`](../frontend/src/components/useTopologyFocus.ts): auto-focus and scope navigation behavior.
- [`frontend/src/components/TopologyPanel.tsx`](../frontend/src/components/TopologyPanel.tsx): compose helpers into the actual viewport.

This is the most important subsystem to understand before making layout changes.

Recommended reading order inside topology:

1. `topologyGraph.ts`
2. `topologySelection.ts`
3. `topologyTrace.ts`
4. `topologyFlowData.tsx`
5. `TopologyPanel.tsx`

Why:

- `topologyGraph.ts` explains the data model.
- `topologyFlowData.tsx` explains how that model becomes visible geometry.
- `TopologyPanel.tsx` mostly orchestrates scope, selection, and React Flow wiring on top of those helpers.

### 4. Settings panel

[`frontend/src/components/SettingsPanel.tsx`](../frontend/src/components/SettingsPanel.tsx) renders a searchable component list and a per-field editor.

How it works:

- if the backend provides a settings schema, the panel uses schema-driven editors
- otherwise it flattens the structured value into leaf paths and falls back to inferred editors
- patches are sent one field at a time

This file is fairly self-contained and one of the easier places to extend safely.

### 5. Profiling and trace panels

Two files own the profiling UX:

- [`frontend/src/components/ProfilingPanel.tsx`](../frontend/src/components/ProfilingPanel.tsx)
- [`frontend/src/components/TraceTimingPanel.tsx`](../frontend/src/components/TraceTimingPanel.tsx)

`ProfilingPanel.tsx`:

- derives publisher rows from process profiling snapshots
- groups likely subscribers under publishers by topic scope
- issues profiling trace start/stop requests
- routes live trace samples to the selected publisher row
- mounts the trace dock via a portal

`TraceTimingPanel.tsx`:

- is a custom canvas renderer, not a charting-library wrapper
- buckets trace samples into ring-buffer-like columns
- draws publish delta, lease time, and user span with manual control over density, overflows, and selected subscriber emphasis

This is the second-biggest complexity hotspot after topology layout.

## Fixture Mode

[`frontend/src/fixtures/dashboardFixtures.ts`](../frontend/src/fixtures/dashboardFixtures.ts) is a major development asset.

It provides deterministic synthetic graphs for:

- layout stress
- nested collection navigation
- long labels
- orphan streams
- dense fanout and cyclic graphs
- profiling trace density differences

Why it matters:

- the frontend can be developed without a live `ezmsg` graph server
- screenshot tests become repeatable
- topology/layout regressions can be isolated from backend availability

This file is long, but conceptually simple: it is synthetic data, not runtime logic.

## Tests And What They Protect

### Backend tests

[`tests/backend/test_api_routes.py`](../tests/backend/test_api_routes.py) verifies:

- API routes return the expected payload shape
- cache-control behavior
- the WebSocket endpoint emits event envelopes
- static frontend fallback does not hide unknown API routes

[`tests/backend/test_graph_context_service.py`](../tests/backend/test_graph_context_service.py) verifies:

- health payload address resolution
- settings patchability enforcement
- settings patch calls
- profiling trace control routing across processes

### Frontend unit tests

The small Vitest files next to the helpers mainly protect pure logic:

- stream address parsing
- topology helper classification
- topology flow validation and overlap constraints
- selection mapping
- active trace highlighting
- focus helper logic

These tests are especially valuable because the topology code is algorithmic and easy to regress subtly.

### Frontend end-to-end tests

[`frontend/tests/e2e/dashboard.spec.ts`](../frontend/tests/e2e/dashboard.spec.ts) is broader than a typical smoke suite.

It checks:

- scope navigation and breadcrumbs
- topology-to-inspector focus behavior
- long-label containment
- dense layout readability
- profiling trace dock behavior
- visual snapshots for curated high-value states

The E2E suite is doing real product protection, not just checking that the page loads.

## Complexity Hotspots

If you are triaging future work, these are the files that deserve extra caution:

### 1. `topologyFlowData.tsx`

Why it is hard:

- it resolves stream ownership across units, collections, hidden parents, scope proxies, and orphan nodes
- it computes layout geometry directly
- visual bugs often show up only in unusual fixtures

Change strategy:

- edit with fixtures open
- run unit tests and Playwright after changes

### 2. `TraceTimingPanel.tsx`

Why it is hard:

- it implements a custom time-series renderer with buffer management
- performance and readability tradeoffs are embedded in rendering code

Change strategy:

- avoid mixing rendering changes with data-shape changes in one patch

### 3. `ProfilingPanel.tsx`

Why it is hard:

- it blends snapshot-derived state, trace-stream state, focus behavior, and dock lifecycle

Change strategy:

- keep row derivation helpers pure where possible
- keep trace-control side effects localized

### 4. `graph_context_service.py`

Why it is hard:

- backend policy lives here
- subtle breakage affects both HTTP payloads and WebSocket streams

Change strategy:

- treat this file like the backend protocol layer, not just a convenience wrapper

## Safe Extension Points

These areas are relatively easy to modify:

- new API health/status fields in the backend payload layer
- settings editor improvements in `SettingsPanel.tsx`
- new fixture scenarios in `dashboardFixtures.ts`
- documentation and metrics explanations
- isolated visual changes in `styles.css` if they do not alter topology geometry assumptions

## A Good First Human Walkthrough

If a human wants to understand the code in one sitting, this is the shortest path I would recommend:

1. Read [`README.md`](../README.md) for packaging and runtime expectations.
2. Read [`src/ezmsg/dashboard/server.py`](../src/ezmsg/dashboard/server.py) and [`src/ezmsg/dashboard/backend/app.py`](../src/ezmsg/dashboard/backend/app.py) to see the full backend surface.
3. Read [`src/ezmsg/dashboard/backend/services/graph_context_service.py`](../src/ezmsg/dashboard/backend/services/graph_context_service.py) carefully. This is the backend brain.
4. Read [`frontend/src/hooks/useDashboardData.ts`](../frontend/src/hooks/useDashboardData.ts) to understand the client data model.
5. Read [`frontend/src/App.tsx`](../frontend/src/App.tsx) to see how inspector state, topology focus, and trace dock state are wired together.
6. Read [`frontend/src/components/topologyGraph.ts`](../frontend/src/components/topologyGraph.ts) and [`frontend/src/components/topologyFlowData.tsx`](../frontend/src/components/topologyFlowData.tsx) to understand the hardest rendering path.
7. Read [`frontend/src/components/SettingsPanel.tsx`](../frontend/src/components/SettingsPanel.tsx) and [`frontend/src/components/ProfilingPanel.tsx`](../frontend/src/components/ProfilingPanel.tsx) for the two inspector panes.
8. Finish with [`frontend/tests/e2e/dashboard.spec.ts`](../frontend/tests/e2e/dashboard.spec.ts) and [`frontend/src/components/topologyFlowData.test.tsx`](../frontend/src/components/topologyFlowData.test.tsx) to learn what behavior the repo considers essential.

## Bottom Line

Despite being AI-authored, the codebase is not structurally chaotic.

The architecture is coherent:

- a thin Python server
- one concentrated backend service layer
- one frontend data hook
- panel-oriented UI composition
- helper-heavy topology rendering
- strong fixture and test support around the hardest visual logic

The main risk is not random disorder. The main risk is **complexity concentration** in a few large frontend files where layout, selection, and live data handling meet. Those files are understandable, but they deserve deliberate, test-backed changes.
