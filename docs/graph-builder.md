# Graph builder implementation plan

## Direction

Bring graph authoring into ezmsg-dashboard, reusing suitable document,
serialization, collection and runtime-construction code from ezmsg-flow.
The destination should not depend on ezmsg-flow or its Qt/GPU UI dependencies.
Retire ezmsg-flow after the required authoring workflows have moved across.

Use a shared React Flow canvas with Build and Monitor workspace presets.
Build shows the component library and settings editor; Monitor shows runtime
inspectors, profiling and plots. Preserve selection, collection scope, positions
and viewport when switching presets. Share node/port rendering and navigation;
allow monitoring detail to expand beyond the authoring representation.

Workspace layout and execution state are separate concerns. Switching to Build
must not mutate a running graph. Maintain a versioned authoring document and a
separate runtime snapshot, with a mapping from document node IDs to runtime
component addresses. Show unapplied changes explicitly. Attached external graphs
remain inspectable without implying that their source document can be recovered.

## First milestone

1. Migrate the existing monitoring canvas to React Flow 12. Preserve current
   behavior and pass unit, browser interaction and existing screenshot tests.
2. Add a Python component catalog using the proposed `ezmsg.components` entry
   point group. Enumerate registrations in the execution interpreter; return
   stable IDs, distribution/version provenance and availability diagnostics.
   Load component metadata separately from enumeration, without instantiating
   Units or connecting hardware. Handle inherited streams and required settings.
   Keep broken registrations visible. Adapt legacy `__ez_flow__` declarations
   explicitly during migration rather than importing every installed module.
3. Introduce a versioned graph document independent of React Flow state. Reuse
   ezmsg-flow's document/serialization/runtime concepts after checking their
   dependencies and compatibility. Store component references, settings and
   connections separately from canvas layout. Preserve unavailable components
   on load/save so opening a document in another environment does not lose data.
4. Add component insertion, connection editing, settings forms, validation and
   save/load. Use the same node identities and navigation across workspace presets.
5. Run a saved document through ezmsg and inspect it with the existing dashboard.
   Initially use explicit validate/run/stop; defer live topology changes until
   their apply/restart behavior is defined. Nested collection live editing is
   not supported by the current ezmsg-flow engine.

Acceptance: discover registered components from representative extensions,
configure a source → processor → sink graph, save/reload it, execute it, and
inspect its messages and settings. Missing components and invalid settings must
produce useful diagnostics without preventing document recovery.

## Settings compatibility

The core `feature/json-schema-settings` branch adds an optional `ezmsg[schema]`
extra (`pydantic>=2.7`), lazy TypeAdapter loading, optional `json_schema` metadata,
and validation/coercion of dynamic field updates in the owning process. It leaves
Settings as dataclasses. This is a suitable integration point without making
Pydantic a mandatory core dependency.

The branch is not part of the current prerelease used here. Detect schema
capabilities and retain the existing field metadata fallback. Installing
Pydantic alone does not add the unmerged metadata/control implementation to core.
Unsupported settings types may still return no schema; make this visible rather
than promising complete form coverage. Field coercion is not strict validation
of an entire settings object or cross-field constraints: validate the complete
settings object before graph execution too.

Use JSON Schema for value structure and constraints, with separate presentation
metadata/custom widgets for paths, channels and devices. Keep Python validation
authoritative and define round-trip encodings for scientific values explicitly.

## React Flow 12 foundation

The migration uses `@xyflow/react`, its named ReactFlow export and stylesheet,
and `parentId` for nested nodes. The current layout supplies explicit dimensions
through node styles; it does not consume the old measured `node.width/height`
fields. Future code reading measured dimensions must use `node.measured`.

This step retains the monitoring interaction model. Component registration,
authoring presets and document execution are subsequent work, not features
enabled by the library migration itself.

## Current implementation

Build and Monitor share the existing topology canvas. Build replaces the right
inspector with Components, Configure and Connections tabs. Components is the
starting point: add any registered Unit or Collection, including acquisition Units
such as `lsl.LSLInletUnit`. Configure edits the selected component's settings.
Connections pairs any draft component output with another component's input,
using either canvas handles or selectors. Draft nodes follow the pointer during
dragging and save their positions on release. Ports use pill styling with the
payload type below the name, input labels at the left and output labels at the
right, matching the live topology. No pre-existing data source or running
pipeline is required. GraphService itself still needs to be running for execution.
Managed draft nodes have a diagonal texture in Build. Their labels distinguish
unstarted drafts from definitions with an applied version running. Runtime Units
owned by this dashboard are also textured in Build, including Units removed from
the draft that will stop on Apply. Other runtime nodes remain external. Drafts
form one managed processing group.

`GET /api/components` enumerates entry-point metadata in the dashboard server's
Python environment without importing extensions. `GET /api/components/{id}`
loads and inspects one registration in a disposable Python process with a
30-second timeout. It returns availability/error, inherited ports, settings
fields and optional Pydantic JSON Schema. Inspection never constructs Units or
settings, and does not call default factories. Duplicate names from different
packages remain distinct. No GraphService connection is needed for these routes.
The server environment is the only supported catalog environment for now.

Draft documents use version 1 JSON with component registration/provenance,
settings, ports, positions and connections. They persist in browser local storage
and can be saved/loaded as files. Missing installed packages do not erase nodes
when loading a document. Use the node handles to connect managed draft nodes;
self-links, duplicate edges and cycles are rejected. Build reuses Monitor’s settings widgets, populated from the catalog’s Pydantic
JSON Schema with field metadata as a fallback. Save each field to the draft;
Run/Apply validates the complete settings object in Python before execution.
Nullable fields have an explicit None checkbox. Arrays, objects and complex
unions use JSON editors; the full settings JSON remains available under Advanced
settings JSON. Widget edits never issue live settings patches. A draft connection is structurally valid, not proof of
message-type or scientific-data compatibility.

Not implemented yet: device/path-specific settings widgets, undo/redo, editing Collection
internals/custom process layout controls, and import of an
arbitrary live graph as executable definitions. Draft documents do not currently
include the external graph being inspected.


## Managed execution

Build exposes Run, Stop and Apply changes. The backend supervises one group of
registered Units and Collections in its own Python environment and attaches it to the same
GraphService the dashboard inspects (`auto_start=False`). GraphService must
already be running. Units share a backend process by default; Collections retain their declared
`process_components()` layout. The supervisor worker is separate. Collection
boundaries expose directional topics, relays or legacy streams. Generic
undirected topics/relays cannot be wired in the editor yet. Main-thread Units,
including those nested inside Collections, require a future execution policy.

Run and Apply first validate the document in a disposable process. Validation
resolves installed entry points, checks saved package versions, validates complete
settings through Pydantic, rejects unknown setting fields, checks real inherited
stream definitions/directions and declared message types, and rejects cycles.
Preflight also constructs the components and runs Collection configuration and
network setup without starting their processing tasks. Collection authors should
keep hardware acquisition in Unit initialization. Saved port metadata is never authoritative. This does not validate scientific
properties such as AxisArray shape, channel labels or sampling rate.

If preflight fails, the existing group keeps running. Apply then stops the old
group and starts its replacement; it is not an atomic or lossless handover.
State/buffers reset and samples may be lost. Startup failure leaves the group
stopped with a failed status and bounded diagnostic logs. There is no automatic
rollback or state transfer. The last successfully applied document remains
available through Restore last applied graph. Layout-only changes do not require
Apply. Managed settings are edited through Build/Apply for now; their monitoring
inspector is read-only so live patches cannot silently diverge from the saved
definition. External settings controls remain available. A revision token rejects concurrent stale execution commands.

Component names are edited in Build → Configure → Component name. New components
receive unique defaults (`ButterworthFilter`, `ButterworthFilter_2`, …). Names
are case-sensitive, 1–64 ASCII letters/digits/underscores, beginning with a letter
or underscore. They must be unique among top-level components in the managed
graph; Collection children retain their own scope. Python preflight enforces
uniqueness as well, including collisions with legacy generated names.

Connections reference immutable document IDs, so renaming preserves wiring.
Names are used in runtime addresses under the dashboard's unique root. Renaming
a running component requires Apply and restarts the managed group. External
clients referencing its old runtime topic must update their binding. Older
unnamed documents keep their generated runtime names until explicitly renamed.
Runtime addresses map document node IDs to live component addresses. The Build canvas shows draft definitions beside
the live topology; the live topology retains its existing monitoring inspectors.
Stop and server shutdown target only the supervisor's owned process group, never
the GraphService or unrelated pipelines. Closing a browser tab does not stop a
run. A dashboard server restart creates a new execution session; it does not
automatically relaunch the browser's saved draft. Run a single backend server
worker; multi-worker deployment requires a shared supervisor service first.

API: `GET /api/execution` returns state, revision, last applied document, runtime
addresses and recent logs. `POST /api/execution/run` and `/apply` accept
`document` and `expected_revision`; `/stop` accepts `expected_revision`.

Real-process regression tests publish messages through a source/sink graph,
replace it, reject invalid edits without stopping it, test startup failure and
verify that another attached graph and GraphService survive managed Stop.


## Optional connections to existing pipelines

In Build, drag from the visible handle on an existing Unit's output pill to a
new component's input handle. When the existing topic is visible, the new edge
attaches directly to that topic; reference cards are used when it is outside the
current view. Run/Apply validates that the referenced output is live and typed.
Collection output topics and output relays are supported when reachable from a live publisher; discovery follows directed topic wiring.

Alternatively, in Connections, opt into “Include components running elsewhere” to select an
output from any stage of an existing pipeline, including a downstream transform.
This is optional; discovery is not requested for a new, self-contained graph.
A source has no special editor role: it is another component with output ports.

New source and processing Units run together by default. Existing processes
retain ownership of their components; attaching to them crosses a process
boundary and does not move them into the managed process. The connection picker
and dashed canvas edges identify this boundary. Reference cards show the existing
component address and output port with a “Running elsewhere” ownership label. References are
saved as optional `external_inputs` in version 1 documents; older documents remain
compatible. Offline publishers stay in saved documents and are marked unavailable.
Removing a target node also removes its bindings.

`GET /api/execution/sources` discovers active publisher endpoints with declared
output-stream metadata. It excludes this dashboard's managed root. Run/Apply
recheck live sources in preflight and again at startup. Remote type names are
never imported or evaluated: external bindings require an exact declared type
name, or a target accepting `Any`/`object`. Subclass/union compatibility across
external metadata, untyped publishers are not yet supported. Collection aliases retain their declared payload type.

The runner creates external-to-managed edges through its own GraphContext session.
Apply/Stop remove that session's edges and preserve the external pipeline and its
other connections. Applying changes can lose incoming samples during the gap; a
publisher disappearing after preflight can still cause startup to fail. Normal
ezmsg backpressure rules apply while connected. Bindings from managed outputs to
external consumers are not exposed yet.

Integration coverage includes an external publisher feeding a two-process
Collection, Apply with new sink settings, rejected missing-source/configuration
edits, and ownership cleanup while the external publisher continues running.


## Keyboard editing and generic stream metadata

In Build, Delete/Backspace removes the selected draft node or draft connection.
Removing a node also removes its incident draft/external bindings. This edits the
document; a running group changes only after Apply. Keyboard deletion is disabled
in Monitor and cannot remove externally owned components or connections. Name,
settings and other text inputs retain their normal keyboard behavior.

Core 3.10.0b3 advertised inherited TypeVars literally (`~MessageInType`,
`~MessageOutType`), even for concrete generic subclasses such as AsArray and
Flatten. The core fix on `fix/resolve-generic-stream-metadata` resolves explicit
generic base arguments before emitting stream/settings metadata, without mutating
shared stream declarations. Unspecialized variables remain unresolved.

The local fix lives in the sibling `ezmsg-stream-types` worktree, based on
v3.10.0b3, and is installed editable into the dashboard and INTENT pipeline venvs.
Restart a pipeline to publish corrected metadata. When testing through `uv run`,
use `--no-sync` to retain this local installation rather than restoring the locked
release. The INTENT project source and lockfile were not changed.


Applied drafts use the actual runtime nodes in Monitor, including activity
animation and inspector selection. Build shows the editable cards and hides the
corresponding runtime copies. Draft cards share live Unit sizing and topic-pill
geometry; striping identifies managed ownership. Invert has no configurable
settings; Scale exposes its numeric scale field.


## Review and release prerequisites

The Build execution path requires ezmsg 3.10 APIs; ezmsg 3.9 fails when starting
GraphRunner. The package minimum is now 3.10.0b3. Correct inherited generic stream
metadata additionally requires core PR #270. PR #271 integrates that fix with the
optional JSON Schema settings feature. Dashboard CI temporarily installs the
combined core commit `8442e35bd1b9cb703f1b4506b4563821cae28d2c` and runs tests with
`uv run --no-sync` to preserve it.

For local review after syncing the dashboard environment:

```bash
uv pip install "ezmsg @ git+https://github.com/ezmsg-org/ezmsg.git@8442e35bd1b9cb703f1b4506b4563821cae28d2c"
uv pip install -e ../ezmsg-lsl -e ../ezmsg-sigproc
uv run --no-sync ezmsg dashboard --graph-address 127.0.0.1:25978
```

The extension checkouts need their `ezmsg.components` entry-point changes; the
catalog does not discover arbitrary unregistered classes. Before publishing the
dashboard, publish a core beta containing the PR stack, raise this package's core
minimum to that beta, and remove the temporary CI Git pin. Publish the extension
registrations as well for package-only component discovery. No core release is
required just to review this PR.
