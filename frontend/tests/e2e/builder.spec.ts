import { test, expect } from "@playwright/test";

test("build and monitor share a canvas, with persistent textured drafts", async ({ page }) => {
  const component = { id: "filter", name: "sigproc.ButterworthFilter", value: "ezmsg.sigproc.butterworthfilter:ButterworthFilter", distribution: "ezmsg-sigproc", version: "test" };
  await page.route("**/api/components", route => route.fulfill({ json: { interpreter: "/test/python", components: [component] } }));
  await page.route("**/api/components/filter", route => route.fulfill({ json: { ...component, available: true, description: "Filter incoming samples", settings_fields: [{ name: "order", required: false, default: 4 }], ports: [
    { name: "INPUT_SIGNAL", direction: "input", message_type: "AxisArray", type_resolved: true, settings: false },
    { name: "OUTPUT_SIGNAL", direction: "output", message_type: "AxisArray", type_resolved: true, settings: false },
  ] } }));
  await page.goto("/?fixture=long-labels");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: /sigproc.ButterworthFilter/ }).click();
  await page.getByRole("button", { name: "Add to draft" }).click();
  const node = page.locator(".managed-node");
  await expect(node.first()).toHaveClass(/is-editing/);
  await expect(page.locator(".react-flow")).toHaveCount(1);
  const firstCard = page.locator(".react-flow__node-managed").first();
  const beforeDrag = await firstCard.boundingBox();
  if (!beforeDrag) throw new Error("Missing draft node");
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + 8);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2 + 55, beforeDrag.y + 48, { steps: 8 });
  // Assert movement before mouseup, not merely persistence after releasing.
  await expect.poll(async () => (await firstCard.boundingBox())!.x - beforeDrag.x).toBeGreaterThan(30);
  await page.mouse.up();
  await expect(node.first().locator(".topology-stream-type").first()).toHaveText("[AxisArray]");
  const inputPill = await node.first().locator(".managed-topic.is-input").boundingBox();
  const outputPill = await node.first().locator(".managed-topic.is-output").boundingBox();
  expect(outputPill!.x).toBeGreaterThan(inputPill!.x);

  await page.getByText("Advanced settings JSON", { exact: true }).click();
  await page.getByLabel("Draft settings").fill('{"order": 6}');
  await page.getByRole("button", { name: "Update draft settings" }).click();
  await page.getByRole("tab", { name: "Components", exact: true }).click();
  await page.getByRole("button", { name: "Add to draft" }).click();
  const handles = page.locator('.managed-node .react-flow__handle');
  await expect(handles).toHaveCount(4);
  const source = page.locator('.react-flow__node-managed').nth(0).locator('[data-handleid="OUTPUT_SIGNAL"]');
  const target = page.locator('.react-flow__node-managed').nth(1).locator('[data-handleid="INPUT_SIGNAL"]');
  await expect.poll(async () => {
    const canvas = (await page.locator(".react-flow").boundingBox())!;
    const a = (await source.boundingBox())!, b = (await target.boundingBox())!;
    return a.x >= canvas.x && b.x + b.width < canvas.x + canvas.width;
  }).toBe(true);
  await source.dragTo(target);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("ezmsg-draft-v1")!).edges.length)).toBe(1);
  const liveOutput = page.locator(".builder-live-output .react-flow__handle.source").first();
  await expect(liveOutput).toBeVisible();
  await liveOutput.dragTo(target);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("ezmsg-draft-v1")!).external_inputs?.length ?? 0)).toBe(1);
  await expect(page.locator(".react-flow__node-external")).toHaveCount(0);
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await expect(page.getByLabel("Component name")).toHaveValue("ButterworthFilter_2");
  await page.getByLabel("Component name").fill("ButterworthFilter");
  await expect(page.getByRole("button", { name: "Rename component" })).toBeDisabled();
  await expect(page.getByText("That name is already used in this graph.")).toBeVisible();
  await page.getByLabel("Component name").fill("Lowpass");
  await page.getByRole("button", { name: "Rename component" }).click();
  await expect(node.nth(1)).toContainText("Lowpass");


  await page.getByRole("button", { name: "Monitor", exact: true }).click();
  await expect(node.first()).not.toHaveClass(/is-editing/);
  await expect(node.first()).toContainText("not running");
  await page.reload();
  await expect(node).toHaveCount(2);
  await page.getByRole("button", { name: "Build", exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("ezmsg-draft-v1")!));
  expect(saved.nodes[0].settings).toEqual({ order: 6 });
  expect(saved.nodes[1].name).toBe("Lowpass");
  expect(saved.edges).toHaveLength(1);
  expect(saved.external_inputs).toHaveLength(1);
  const edge = page.locator(`.react-flow__edge[data-id="${saved.edges[0].id}"] .react-flow__edge-path`);
  const point = await edge.evaluate(element => {
    const path = element as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const transformed = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
    return { x: transformed.x, y: transformed.y };
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press("Delete");
  await expect.poll(() => page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("ezmsg-draft-v1")!);
    return d.edges.length + (d.external_inputs?.length ?? 0);
  })).toBe(1);
  await node.nth(1).click();
  await page.getByLabel("Component name").focus();
  await page.keyboard.press("Backspace");
  await expect(node).toHaveCount(2);
  await node.nth(1).click();
  await page.keyboard.press("Delete");
  await expect(node).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("ezmsg-draft-v1")!);
    return d.edges.length + (d.external_inputs?.length ?? 0);
  })).toBe(0);

  await page.getByRole("button", { name: "Monitor", exact: true }).click();
  await node.first().click();
  await page.keyboard.press("Delete");
  await expect(node).toHaveCount(1);
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.locator(".builder-live-output").first().click();
  await page.keyboard.press("Delete");
  await expect(node).toHaveCount(1);
  await page.screenshot({ path: "test-results/builder-workspace.png", fullPage: true });
});

test("unavailable registrations stay visible and cannot be added", async ({ page }) => {
  const component = { id: "broken", name: "example.Broken", distribution: "example", version: "1", value: "missing:Unit" };
  await page.route("**/api/components", route => route.fulfill({ json: { interpreter: "/test/python", components: [component] } }));
  await page.route("**/api/components/broken", route => route.fulfill({ json: { ...component, available: false, error: "Missing dependency" } }));
  await page.goto("/?fixture=long-labels");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: /example.Broken/ }).click();
  await expect(page.getByRole("alert")).toContainText("Missing dependency");
  await expect(page.getByRole("button", { name: "Add to draft" })).toHaveCount(0);
});

test("execution controls preview restarts and preserve applied status", async ({ page }) => {
  const component = { id: "source", name: "test.Source", value: "test:Source", distribution: "test", version: "1" };
  const doc = { version: 1, nodes: [{ id: "draft:source", component, ports: [], position: { x: 0, y: 0 }, settings: { value: 7 } }], edges: [] };
  let state = { state: "stopped", error: null, revision: 0, root_name: "dashboard_test", document: null as typeof doc | null, runtime_addresses: {} as Record<string, string> };
  await page.addInitScript(value => localStorage.setItem("ezmsg-draft-v1", JSON.stringify(value)), doc);
  await page.route("**/api/components", route => route.fulfill({ json: { interpreter: "/test/python", components: [] } }));
  await page.route("**/api/execution", route => route.fulfill({ json: state }));
  await page.route("**/api/execution/*", async route => {
    const action = route.request().url().split("/").pop();
    if (action === "sources") { await route.fulfill({ json: { sources: [] } }); return; }
    const body = route.request().postDataJSON();
    expect(body.expected_revision).toBe(state.revision);
    state = { ...state, state: action === "stop" ? "stopped" : "running", revision: state.revision + 1,
      document: body.document ?? state.document, runtime_addresses: { "draft:source": "dashboard_test/node_source" } };
    await route.fulfill({ json: state });
  });
  await page.route("**/api/health*", route => route.fulfill({ json: { status: "ok", graph_session_active: false, graph_address: "127.0.0.1:25978" } }));
  await page.route("**/api/snapshot*", route => route.fulfill({ json: { snapshot: { graph: {}, edge_owners: [], sessions: {}, processes: {} }, settings: {}, profiling: {} } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator(".managed-node")).toContainText("running applied version");
  await page.locator(".managed-node").click();
  await page.getByText("Advanced settings JSON", { exact: true }).click();
  await page.getByLabel("Draft settings").fill('{"value": 9}');
  await page.getByRole("button", { name: "Update draft settings" }).click();
  await expect(page.getByRole("status")).toContainText("Buffers and filter state reset");
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeDisabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".managed-node")).toContainText("not running");
});


test("optionally connects a processing output from another pipeline and preserves it offline", async ({ page }) => {
  const component = { id: "sink", name: "test.Sink", value: "test:Sink", distribution: "test", version: "1" };
  const doc = { version: 1, nodes: [{ id: "draft:sink", component, ports: [{ name: "INPUT", direction: "input", message_type: "builtins.int", type_resolved: true, settings: false }], position: { x: 0, y: 0 }, settings: {} }], edges: [] };
  await page.addInitScript(value => { if (!localStorage.getItem("ezmsg-draft-v1")) localStorage.setItem("ezmsg-draft-v1", JSON.stringify(value)); }, doc);
  await page.route("**/api/components", route => route.fulfill({ json: { components: [], interpreter: "/test/python" } }));
  await page.route("**/api/execution", route => route.fulfill({ json: { state: "stopped", revision: 0, root_name: "managed", document: null, runtime_addresses: {} } }));
  let online = true;
  await page.route("**/api/execution/sources", route => route.fulfill({ json: { sources: online ? [{ topic: "pipeline/Downsample/OUTPUT", message_type: "builtins.int" }] : [] } }));
  await page.route("**/api/health*", route => route.fulfill({ json: { status: "ok", graph_session_active: false, graph_address: "127.0.0.1:25978" } }));
  await page.route("**/api/snapshot*", route => route.fulfill({ json: { snapshot: { graph: {}, edge_owners: [], sessions: {}, processes: {} }, settings: {}, profiling: {} } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.locator(".managed-node").click();
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await page.getByLabel("Include components running elsewhere").check();
  await expect(page.getByLabel("Component output").locator("option")).toHaveCount(2);
  await page.getByLabel("Component output").selectOption(JSON.stringify(["existing", "pipeline/Downsample/OUTPUT"]));
  await page.getByLabel("Component input").selectOption(JSON.stringify(["draft:sink", "INPUT"]));
  await page.getByRole("button", { name: "Connect ports", exact: true }).click();
  await expect(page.locator('.react-flow__node-external')).toContainText("Running elsewhere · not restarted by Apply");
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Connect ports", exact: true })).toBeDisabled();
  await page.screenshot({ path: "test-results/external-binding.png", fullPage: true });
  online = false;
  await page.reload();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await expect(page.locator(".builder-connection")).toContainText("output unavailable");
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await page.getByRole("button", { name: "Remove external connection" }).click();
  await expect(page.locator('.react-flow__node-external')).toHaveCount(0);
});


test("builds a complete graph with its own acquisition component without existing outputs", async ({ page }) => {
  let discoveryRequests = 0;
  const components = ["lsl.LSLInletUnit", "sigproc.ButterworthFilter", "test.Sink"].map((name, i) => ({ id: String(i), name, value: `test:Component${i}`, distribution: "test", version: "1" }));
  const port = (name: string, direction: string) => ({ name, direction, message_type: "AxisArray", type_resolved: true, settings: false });
  await page.route("**/api/components", route => route.fulfill({ json: { components, interpreter: "/test/python" } }));
  await page.route("**/api/components/*", route => {
    const i = Number(route.request().url().split("/").pop());
    return route.fulfill({ json: { ...components[i], available: true, settings_fields: [], ports: i === 0 ? [port("OUTPUT", "output")] : i === 1 ? [port("INPUT", "input"), port("OUTPUT", "output")] : [port("INPUT", "input")] } });
  });
  await page.route("**/api/execution/sources", route => { discoveryRequests++; return route.fulfill({ status: 503, json: {} }); });
  await page.route("**/api/execution", route => route.fulfill({ json: { state: "stopped", revision: 0, root_name: "managed", document: null, runtime_addresses: {} } }));
  await page.route("**/api/execution/run", async route => {
    const document = route.request().postDataJSON().document;
    expect(document.nodes.map((n: { component: { name: string } }) => n.component.name)).toEqual(components.map(c => c.name));
    expect(document.edges).toHaveLength(2);
    expect(document.external_inputs ?? []).toEqual([]);
    await route.fulfill({ json: { state: "running", revision: 1, root_name: "managed", document, runtime_addresses: Object.fromEntries(document.nodes.map((n: { id: string }) => [n.id, `managed/${n.id}`])) } });
  });
  await page.route("**/api/health*", route => route.fulfill({ json: { status: "ok", graph_session_active: false, graph_address: "127.0.0.1:25978" } }));
  await page.route("**/api/snapshot*", route => route.fulfill({ json: { snapshot: { graph: {}, edge_owners: [], sessions: {}, processes: {} }, settings: {}, profiling: {} } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await expect(page.getByText("Start your graph", { exact: true })).toBeVisible();
  for (const component of components) {
    await page.getByRole("tab", { name: "Components", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(component.name) }).click();
    await page.getByRole("button", { name: "Add to draft" }).click();
    await expect(page.getByRole("tab", { name: "Configure", exact: true })).toHaveAttribute("aria-selected", "true");
  }
  const doc = await page.evaluate(() => JSON.parse(localStorage.getItem("ezmsg-draft-v1")!));
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await expect(page.getByLabel("Include components running elsewhere")).not.toBeChecked();
  for (let i = 0; i < 2; i++) {
    await page.getByLabel("Component output").selectOption(JSON.stringify([doc.nodes[i].id, "OUTPUT"]));
    await page.getByLabel("Component input").selectOption(JSON.stringify([doc.nodes[i + 1].id, "INPUT"]));
    await page.getByRole("button", { name: "Connect ports", exact: true }).click();
  }
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator(".managed-node").first()).toContainText("running applied version");
  expect(discoveryRequests).toBe(0);
  await page.screenshot({ path: "test-results/component-build.png", fullPage: true });
});

test("Build shares settings widgets, saves nullable fields locally and reloads schemas", async ({ page }) => {
  const component = { id: "decimate", name: "sigproc.Decimate", value: "ezmsg.sigproc.decimate:Decimate", distribution: "ezmsg-sigproc", version: "test" };
  let livePatches = 0;
  await page.route("**/api/settings/**", route => { livePatches++; return route.abort(); });
  await page.route("**/api/components", route => route.fulfill({ json: { components: [component] } }));
  await page.route("**/api/components/decimate", route => route.fulfill({ json: { ...component, available: true, ports: [],
    settings_fields: [{ name: "factor", type: "int | None", required: false, default: null }],
    json_schema: { properties: { factor: { anyOf: [{ type: "integer" }, { type: "null" }], default: null } } },
  } }));
  await page.goto("/?fixture=long-labels");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: /sigproc.Decimate/ }).click();
  await page.getByRole("button", { name: "Add to draft" }).click();
  await expect(page.getByLabel("factor", { exact: true })).toBeDisabled();
  await page.getByLabel("factor: use null").uncheck();
  await page.getByLabel("factor", { exact: true }).fill("2.5");
  await page.getByRole("button", { name: "Save to draft", exact: true }).click();
  await expect(page.getByText("Value must be an integer.", { exact: true })).toBeVisible();
  await page.getByLabel("factor", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save to draft", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("ezmsg-draft-v1")!).nodes[0].settings.factor)).toBe(2);
  await page.reload();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.locator(".managed-node").click();
  await expect(page.getByLabel("factor", { exact: true })).toHaveValue("2");
  await page.getByLabel("factor: use null").check();
  await page.getByRole("button", { name: "Save to draft", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("ezmsg-draft-v1")!).nodes[0].settings.factor)).toBeNull();
  expect(livePatches).toBe(0);
});

test("running drafts use runtime monitoring and Collection outputs can be wired", async ({ page }) => {
  const component = { id: "scale", name: "Scale", value: "test:Scale", distribution: "test", version: "1" };
  const ports = [
    { name: "INPUT", direction: "input", message_type: "builtins.int", type_resolved: true, settings: false },
    { name: "OUTPUT", direction: "output", message_type: "builtins.int", type_resolved: true, settings: false },
  ];
  const draft = { version: 1, nodes: [{ id: "draft:scale", name: "Scale", component, ports, position: { x: 0, y: 0 }, settings: { scale: 2 } }], edges: [],
    external_inputs: [{ id: "binding", topic: "Pipeline/OUTPUT", target: "draft:scale", targetHandle: "INPUT" }] };
  const unit = (address: string, streams: Record<string, unknown>) => ({ address, name: address.split("/").pop(), component_type: "test.Scale", streams, tasks: [{ name: "process", subscribes: address + "/INPUT", publishes: [address + "/OUTPUT"] }] });
  const output = (address: string) => ({ address, name: "OUTPUT", msg_type: "builtins.int", num_buffers: 8 });
  const source = output("Pipeline/Source/OUTPUT");
  const target = { address: "dashboard_test/Scale/INPUT", name: "INPUT", msg_type: "builtins.int", leaky: false };
  let ticks = 0;
  await page.addInitScript(value => {
    localStorage.setItem("ezmsg-draft-v1", JSON.stringify(value));
    localStorage.setItem("ezmsg-dashboard-global-settings", JSON.stringify({ snapshotPollSeconds: 1, topologyDefaultLayout: "lr" }));
  }, draft);
  await page.route("**/api/components", route => route.fulfill({ json: { components: [component] } }));
  await page.route("**/api/components/scale", route => route.fulfill({ json: { ...component, available: true, settings_fields: [{ name: "scale", type: "float", default: 1 }], json_schema: { properties: { scale: { type: "number" } } } } }));
  await page.route("**/api/execution", route => route.fulfill({ json: { state: "running", revision: 1, root_name: "dashboard_test", document: draft, runtime_addresses: { "draft:scale": "dashboard_test/Scale" } } }));
  await page.route("**/api/health*", route => route.fulfill({ json: { status: "ok", graph_session_active: true } }));
  await page.route("**/api/snapshot*", route => route.fulfill({ json: {
    snapshot: { graph: { "Pipeline/Source/OUTPUT": ["Pipeline/OUTPUT"], "Pipeline/OUTPUT": [target.address] },
      edge_owners: [], processes: {}, sessions: { test: { edges: [], metadata: { components: {
        Pipeline: { address: "Pipeline", name: "Pipeline", component_type: "test.Collection", topics: { OUTPUT: { address: "Pipeline/OUTPUT", name: "OUTPUT", msg_type: "builtins.int" } }, children: ["Pipeline/Source"] },
        "Pipeline/Source": unit("Pipeline/Source", { OUTPUT: source }),
        "dashboard_test/Scale": unit("dashboard_test/Scale", { INPUT: target, OUTPUT: output("dashboard_test/Scale/OUTPUT") }),
      } } } } },
    settings: { "dashboard_test/Scale": { component_name: "Scale", component_type: "test.Scale", structured_value: { scale: 2 }, repr_value: { scale: 2 }, serialized_present: true, patchable: false } },
    profiling: { p: { process_id: "p", pid: 1, host: "test", window_seconds: 1, timestamp: ticks,
      publishers: { pub: { endpoint_id: "pub", topic: source.address, messages_published_total: ++ticks, messages_published_window: 1, publish_rate_hz_window: 1 } }, subscribers: {} } },
  } }));
  await page.goto("/");
  await expect(page.locator(".managed-node")).toHaveCount(0);
  const runtime = page.getByTestId("rf__node-unit:dashboard_test/Scale");
  await expect(runtime).toBeVisible();
  const runtimeWidth = await runtime.evaluate(node => (node as HTMLElement).offsetWidth);
  await runtime.locator(".topology-title-row").dblclick();
  await expect(page.locator(".settings-component-row.is-expanded")).toContainText("Scale");
  await expect(page.locator(".react-flow__edge.animated").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("rf__node-stream:dashboard_test/Scale/INPUT")).toHaveCount(1);
  await expect(page.locator(".react-flow__node-external")).toHaveCount(0);
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await expect(runtime).toHaveCount(0);
  await expect(page.locator(".managed-node")).toHaveCount(1);
  await page.locator(".managed-node").click();
  await expect(page.getByLabel("scale", { exact: true })).toHaveValue("2");
  expect(await page.locator(".managed-node").evaluate(node => (node as HTMLElement).offsetWidth)).toBe(runtimeWidth);
  await expect(page.locator(".react-flow__edge.animated")).toHaveCount(1);
  // Remove and recreate the binding by dragging from the Collection boundary.
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "Remove external connection", exact: true }).click();
  const handle = page.getByTestId("rf__node-stream:Pipeline/OUTPUT").locator(".react-flow__handle.source");
  await expect(handle).toBeVisible();
  await handle.dragTo(page.locator('.managed-node [data-handleid="INPUT"]'));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("ezmsg-draft-v1")!).external_inputs[0]?.topic)).toBe("Pipeline/OUTPUT");
});
