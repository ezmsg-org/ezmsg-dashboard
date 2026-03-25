import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendRoot, "..");
const outputDir = path.resolve(repoRoot, "docs", "screenshots");
const baseUrl = process.env.DASHBOARD_DOCS_BASE_URL ?? "http://127.0.0.1:5173";

function globalSettings(overrides = {}) {
  return {
    snapshotPollSeconds: 2,
    themeMode: "dark",
    topologyDefaultLayout: "lr",
    edgeConnectorStyle: "curved",
    showLegend: false,
    showMiniMap: false,
    traceMetricsPreset: "publish+lease+backpressure",
    autoFitOnLayoutScopeChange: true,
    autoFocusOnInspectorSelection: true,
    inspectorWidthPx: 560,
    ...overrides,
  };
}

async function primePage(page, overrides = {}) {
  await page.addInitScript((settings) => {
    window.localStorage.setItem(
      "ezmsg-dashboard-global-settings",
      JSON.stringify(settings)
    );
  }, globalSettings(overrides));
}

async function waitForDashboard(page, fixture) {
  await page.goto(`${baseUrl}/?fixture=${fixture}`);
  await page.locator(".dashboard-layout").waitFor();
  await page.waitForTimeout(180);
}

async function clearCallouts(page) {
  await page.evaluate(() => {
    document.querySelectorAll("[data-doc-callout]").forEach((node) => node.remove());
  });
}

function anchorPoint(box, anchor) {
  switch (anchor) {
    case "top-right":
      return { x: box.x + box.width - 12, y: box.y + 12 };
    case "bottom-left":
      return { x: box.x + 12, y: box.y + box.height - 12 };
    case "bottom-right":
      return { x: box.x + box.width - 12, y: box.y + box.height - 12 };
    case "center":
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    case "top-left":
    default:
      return { x: box.x + 12, y: box.y + 12 };
  }
}

async function addCallout(page, locator, number, options = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`Could not resolve bounding box for callout ${number}`);
  }
  const { anchor = "top-left", dx = 0, dy = 0 } = options;
  const point = anchorPoint(box, anchor);
  const left = Math.round(point.x + dx);
  const top = Math.round(point.y + dy);
  await page.evaluate(({ left: x, top: y, label }) => {
    const badge = document.createElement("div");
    badge.setAttribute("data-doc-callout", "true");
    Object.assign(badge.style, {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      width: "28px",
      height: "28px",
      borderRadius: "999px",
      background: "#2563eb",
      color: "#ffffff",
      border: "2px solid rgba(255,255,255,0.92)",
      boxShadow: "0 6px 18px rgba(15, 23, 42, 0.35)",
      fontFamily: '"Avenir Next", system-ui, sans-serif',
      fontSize: "15px",
      fontWeight: "700",
      lineHeight: "24px",
      textAlign: "center",
      zIndex: "2147483647",
      pointerEvents: "none",
    });
    badge.textContent = label;
    document.body.appendChild(badge);
  }, { left, top, label: String(number) });
}

async function saveScreenshot(locator, filename) {
  await locator.screenshot({
    path: path.join(outputDir, filename),
    animations: "disabled",
  });
}

async function captureTopologyOverview(page) {
  await page.setViewportSize({ width: 1580, height: 980 });
  await primePage(page, { topologyDefaultLayout: "tb", inspectorWidthPx: 520 });
  await waitForDashboard(page, "root-scope-navigation");
  await page.locator('button[aria-label="Open SYSTEM scope"]').click();
  await page.waitForTimeout(180);
  await clearCallouts(page);
  await addCallout(page, page.locator(".topology-flow-toolbar"), 1, { anchor: "top-left" });
  await addCallout(page, page.getByTestId("rf__node-scope:SYSTEM"), 2, {
    anchor: "top-left",
    dx: 10,
    dy: 10,
  });
  await addCallout(page, page.getByTestId("rf__node-unit:SYSTEM/PING"), 3, {
    anchor: "top-left",
    dx: 16,
    dy: 8,
  });
  await addCallout(
    page,
    page.getByTestId("rf__node-stream:SYSTEM/PING_TOPIC:ping-output-endpoint"),
    4,
    { anchor: "top-right", dx: -20, dy: -10 }
  );
  await saveScreenshot(page.locator(".topology-flow-shell"), "topology-overview.png");
}

async function captureSettingsPanel(page) {
  await page.setViewportSize({ width: 1520, height: 980 });
  await primePage(page, { topologyDefaultLayout: "lr", inspectorWidthPx: 560 });
  await waitForDashboard(page, "root-scope-navigation");
  await page.locator('button[aria-label="Open SYSTEM scope"]').click();
  await page.getByTestId("rf__node-unit:SYSTEM/PING").click({ position: { x: 26, y: 18 } });
  await page.waitForTimeout(180);
  await clearCallouts(page);
  const settingsSection = page.locator(".inspector-section", {
    has: page.locator(".inspector-section__header", { hasText: "Settings" }),
  });
  await addCallout(page, settingsSection.locator('input[type="search"]'), 1);
  await addCallout(
    page,
    settingsSection.locator(".settings-component-row", {
      has: page.locator('.settings-component-address[title="SYSTEM/PING"]'),
    }),
    2,
    { anchor: "top-left", dx: 10, dy: 10 }
  );
  await addCallout(
    page,
    settingsSection.locator(".settings-field-row", {
      has: page.locator("label", { hasText: "rate_hz" }),
    }),
    3,
    { anchor: "top-left", dx: 10, dy: 10 }
  );
  await addCallout(
    page,
    settingsSection.locator(".settings-field-row", {
      has: page.locator("label", { hasText: "rate_hz" }),
    }).getByRole("button", { name: "Apply" }),
    4,
    { anchor: "top-left", dx: 4, dy: 4 }
  );
  await saveScreenshot(settingsSection, "settings-panel.png");
}

async function capturePublishersPanel(page) {
  await page.setViewportSize({ width: 1520, height: 1080 });
  await primePage(page, { inspectorWidthPx: 560 });
  await waitForDashboard(page, "profiling-trace-rates");
  const publishersSection = page.locator(".inspector-section", {
    has: page.locator(".inspector-section__header", { hasText: "Publishers" }),
  });
  const denseRow = page.locator(".publisher-row", {
    has: page.locator('.publisher-topic[title="TRACE_LAB/DENSE_TOPIC"]'),
  });
  await denseRow.locator(".publisher-row__toggle").click();
  await page.waitForTimeout(180);
  await clearCallouts(page);
  await addCallout(page, denseRow, 1, { anchor: "top-left", dx: 8, dy: 8 });
  await addCallout(page, denseRow.getByRole("button", { name: /Start Profiling Trace/ }), 2, {
    anchor: "top-left",
    dx: 10,
    dy: 6,
  });
  await addCallout(page, denseRow.getByRole("button", { name: /Hide Zero Backpressure/ }), 3, {
    anchor: "top-right",
    dx: -20,
    dy: 4,
  });
  await addCallout(page, denseRow.locator(".subscriber-item").first(), 4, {
    anchor: "top-left",
    dx: 8,
    dy: 8,
  });
  await saveScreenshot(publishersSection, "publishers-panel.png");
}

async function captureTraceDock(page) {
  await page.setViewportSize({ width: 1560, height: 1080 });
  await primePage(page, { inspectorWidthPx: 560 });
  await waitForDashboard(page, "profiling-trace-rates");
  const denseRow = page.locator(".publisher-row", {
    has: page.locator('.publisher-topic[title="TRACE_LAB/DENSE_TOPIC"]'),
  });
  await denseRow.locator(".publisher-row__toggle").click();
  await denseRow.getByRole("button", { name: /Start Profiling Trace/ }).click();
  await page.waitForTimeout(650);
  const traceDock = page.locator(".trace-dock");
  await clearCallouts(page);
  await addCallout(page, traceDock.locator('.timing-trace__axis-input input').first(), 1, {
    anchor: "top-left",
    dx: 4,
    dy: 4,
  });
  await addCallout(page, traceDock.getByRole("button", { name: "Backpressure (all subs)" }), 2, {
    anchor: "top-left",
    dx: 8,
    dy: 4,
  });
  await addCallout(page, traceDock.getByRole("button", { name: "Subscribers" }), 3, {
    anchor: "top-left",
    dx: 8,
    dy: 4,
  });
  await addCallout(page, traceDock.locator('.timing-trace__axis-input--ymax input'), 4, {
    anchor: "top-left",
    dx: 4,
    dy: 4,
  });
  await addCallout(page, traceDock.locator(".timing-trace__canvas"), 5, {
    anchor: "top-left",
    dx: 10,
    dy: 10,
  });
  await saveScreenshot(traceDock, "trace-dock.png");
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  try {
    await captureTopologyOverview(page);
    await captureSettingsPanel(page);
    await capturePublishersPanel(page);
    await captureTraceDock(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
