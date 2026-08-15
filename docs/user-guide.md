# User Guide

`ezmsg-dashboard` is a live operations view for an `ezmsg` graph. It gives you three main workflows:

- understand structure in the topology view
- inspect and patch settings
- inspect publisher/subscriber health and timing traces

## Main Layout

The dashboard has three major areas:

- **Topology**: the large graph view
- **Publishers**: profiling and subscriber health
- **Settings**: component settings and patch controls

## Topology

![Annotated topology overview](./screenshots/topology-overview.png)

1. **Scope controls**: `Root`, breadcrumb chips, and scope context let you move between collection levels.
2. **Active collection frame**: the dashed scope card shows the currently opened collection.
3. **Unit card**: each unit shows its name, type, address, tasks, and streams.
4. **Stream/topic node**: stream endpoints, topics, and relays are rendered as pills connected by edges.

### What To Do Here

- Click a unit to focus it in **Settings**, and to expand the topics it publishes in **Publishers**.
- Click a publisher or subscriber stream to focus it in **Publishers** and fit the topology view.
- Use the floating viewport shortcuts to toggle layout direction, theme, or open global settings.
- Drag the divider between the topology and the inspector to change how much width each gets. Double-click it to return to the default, or focus it and use the arrow keys (`Home`/`End` jump to the widest/narrowest inspector). The width is remembered, and also appears as `Inspector Width` in global settings.
- Use `Open` on a collection to descend into that scope.
- Use `Up` or breadcrumbs to move back out.

### Reading The Graph

- **Collections** are dashed frames.
- **Units** are solid cards.
- **Inputs** and **outputs** are color-coded pill nodes inside units.
- **Topics** and **relays** appear as standalone pill nodes when they are collection-owned or orphaned.
- The legend in the lower-left of the topology can be toggled on if needed.

## Settings

![Annotated settings panel](./screenshots/settings-panel.png)

1. **Search**: filter components by address, name, or type.
2. **Component row**: select the component you want to inspect or edit.
3. **Field editor**: settings fields are rendered with a widget appropriate for their type when possible.
4. **Apply button**: submits a patch for that field only.

### Settings Behavior

- Only components with patchable settings can be edited.
- Patchable components are marked `PATCHABLE`.
- Read-only components are marked `READ ONLY`.
- The dashboard patches one field at a time.
- Successful patches show a short applied status inline.
- Failed patches show an inline error.

### Supported Field Styles

- **Boolean**: checkbox
- **Number**: numeric input with bounds when available
- **Choice**: select menu
- **Text**: single-line text input
- **JSON / structured fallback**: text area or serialized value editor

Float fields may hold values JSON cannot represent. These are displayed as
`Infinity`, `-Infinity`, and `NaN`, and a float field accepts any of those
spellings (`inf`, `-inf`, `nan` work too). Integer fields require a finite
value.

## Publishers

![Annotated publishers panel](./screenshots/publishers-panel.png)

The Publishers pane currently centers on four things:

1. **Search**: filter publisher rows by topic, endpoint, or process id.
2. **Publisher row**: surfaces always-on snapshot metrics for a publisher topic.
3. **Trace control**: starts or stops profiling trace capture for the selected publisher endpoint.
4. **Subscriber row**: shows the subscriber topic, channel kind, and snapshot message count. Expanding one shows host, pid, process id, and endpoint id.

### What Is Listed Here

Only data publishers. A unit that exposes dynamic settings also gets a
control-plane publisher on `<unit>/INPUT_SETTINGS`, created the first time one
of its settings is patched. It publishes only when a setting changes, so it sits
at `0.0 Hz` and a profiling trace on it can never produce a sample. These are
hidden by default; enable `Show settings channels in Publishers (debug)` in
global settings to see them.

### Typical Workflow

1. Search for a topic or endpoint.
2. Expand a publisher row.
3. Inspect its rate, message count, inflight state, and host.
4. Review the subscriber list.
5. Start a profiling trace if the publisher needs timing-oriented investigation.

## Trace Dock

![Annotated trace dock](./screenshots/trace-dock.png)

The trace dock exposes five main controls and readouts:

1. **Window**: controls how many seconds of trace history are visible.
2. **Lease Time toggle**: shows per-subscriber lease timing traces.
3. **User Span toggle**: shows per-subscriber user-code span traces.
4. **Y max / Auto-Fixed**: sets a manual ceiling or lets the trace dock auto-scale the vertical axis.
5. **Trace canvas**: plots publish delta, lease time, and user span series over time.

### Trace Workflow

1. Start profiling trace from a publisher row.
2. Wait for the trace dock to populate.
3. Adjust the time window if the graph is too sparse or too dense.
4. Switch between `Lease Time` and `User Span` as needed.
5. Switch `Y max` from `Auto` to `Fixed` if the auto scale is making comparisons hard.

## Theme And Layout Controls

The top-right dock in the topology viewport contains:

- **Layout toggle**: left-to-right vs top-to-bottom
- **Theme toggle**: light vs dark
- **Global settings**: snapshot poll frequency, theme, default layout, edge connector type, default trace metrics, inspector width, legend/minimap visibility, auto-fit/auto-focus behaviors, and whether the Publishers pane shows settings channels

## Good Troubleshooting Patterns

- If the graph is visually dense, switch layout direction.
- If the inspector feels cramped, increase inspector width in global settings.
- If the publisher list is noisy, use the publisher search box to narrow by topic, endpoint, or process.
- If a trace looks flat or over-compressed, adjust `Window (s)` or switch `Y max` from `Auto` to `Fixed`.
- If a component is not editable, check whether it is marked `PATCHABLE` in Settings.

## Current Limits

- Screenshot examples in this guide come from deterministic fixtures, not a live graph.
- The Publishers pane depends on profiling snapshot data. A stream can exist in topology while Publishers remains empty if profiling data is not available for it.
- The dashboard emphasizes readability and navigation over exhaustive raw protocol inspection.
