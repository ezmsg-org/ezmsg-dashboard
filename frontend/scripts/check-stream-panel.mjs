/**
 * Drive the stream viewer in a real browser against a live graph.
 *
 * Exists because the parts most likely to be wrong -- shader compilation, the
 * vertex layout, whether anything is actually drawn -- cannot fail in a jsdom
 * unit test. This opens the dashboard, watches each demo publisher, and checks
 * that the plot really has ink on it.
 *
 * Rendering is judged from a *screenshot*, not from `readPixels`. The canvas is
 * created with `preserveDrawingBuffer: false`, so reading it back after the
 * frame is composited returns nothing; forcing that flag on from the harness
 * perturbs compositing badly enough to blank the canvas outright, which reads
 * exactly like the bug it was supposed to detect. The screenshot is what the
 * user sees, needs no cooperation from the app, and cannot lie about it.
 *
 * Requires a graph and a dashboard already running:
 *
 *   ezmsg serve & python examples/stream_demo_graph.py & ezmsg dashboard --port 8077
 *   node scripts/check-stream-panel.mjs http://127.0.0.1:8077
 */

import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:8077";
const outputDir = new URL("../test-results/stream/", import.meta.url).pathname;
mkdirSync(outputDir, { recursive: true });

/** Demo publishers, and the view each is expected to resolve to. */
const CASES = [
  // Carries electrode positions, so it must open as a sweep and also offer
  // the map -- the common (time, ch) case.
  { unit: "SIGNAL", topic: "SIGNAL/OUTPUT", expectMode: "sweep", expectViews: ["sweep", "channel map"] },
  { unit: "SPECTRUM", topic: "SPECTRUM/OUTPUT", expectMode: "spectrum" },
  { unit: "MAP", topic: "MAP/OUTPUT", expectMode: "scatter" },
  // No plot for this one; the check is that the inspector takes over and
  // says why, rather than the panel showing an empty plot.
  // Publishes a dataclass defined in the demo script's __main__, which the
  // dashboard process cannot import, so ezmsg drops it before the tap sees
  // it. The check is that the panel says so instead of looking idle.
  { unit: "EVENTS", topic: "EVENTS/OUTPUT", expectMode: null, expectNotice: "cannot decode|no messages are arriving" },
];

/**
 * Distinct colours in a PNG, decoded by the browser rather than in Node.
 *
 * Round-tripping the screenshot back through an `Image` and a 2D canvas avoids
 * pulling in a PNG decoder for one assertion, and keeps the measurement on the
 * composited pixels.
 */
async function countScreenshotColors(page, pngBuffer) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = `data:image/png;base64,${base64}`;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set();
    for (let index = 0; index < data.length; index += 4) {
      seen.add((data[index] << 16) | (data[index + 1] << 8) | data[index + 2]);
      if (seen.size > 64) break;
    }
    return { colors: seen.size, width: canvas.width, height: canvas.height };
  }, pngBuffer.toString("base64"));
}

// Headless Chromium has no GPU and therefore no WebGL2 unless SwiftShader is
// asked for explicitly. Without these the plot stays blank and the check
// reports a failure that says nothing about the code under test.
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

await page.goto(baseUrl, { waitUntil: "networkidle" });

const results = [];
for (const testCase of CASES) {
  const row = page.locator(".publisher-row__toggle", { hasText: testCase.unit }).first();
  await row.click();
  const viewButton = page.getByRole("button", { name: /View Data/ }).first();
  await viewButton.waitFor({ state: "visible", timeout: 10_000 });
  await viewButton.click();

  const dock = page.locator(".stream-dock");
  await dock.waitFor({ state: "visible", timeout: 10_000 });
  // Long enough for the description to arrive and a good many frames to land,
  // and past the grace period before a silent tap is called undecodable.
  await page.waitForTimeout(6000);

  const meta = (await page.locator(".stream-dock__meta").innerText()).replace(/\s+/g, " ").trim();
  const viewControl = page.locator(".stream-control", { hasText: /^View/ });
  const views = (await viewControl.count()) > 0 ? await viewControl.locator("option").allInnerTexts() : [];
  const status = await page.locator(".stream-dock__actions .trace-status").innerText();
  let ink = { colors: 0 };
  let inspectorText = null;
  if (testCase.expectMode === null) {
    inspectorText = (await page.locator(".stream-panel__notice").innerText())
      .replace(/\s+/g, " ")
      .trim();
  } else {
    const plot = await page.locator(".stream-plot__host").screenshot();
    ink = await countScreenshotColors(page, plot);
  }

  await dock.screenshot({ path: `${outputDir}${testCase.unit.toLowerCase()}.png` });

  results.push({
    topic: testCase.topic,
    meta,
    status: status.trim(),
    modeOk: testCase.expectMode === null || meta.includes(testCase.expectMode),
    inspectorText,
    views,
    viewsOk:
      testCase.expectViews === undefined
      || JSON.stringify(views) === JSON.stringify(testCase.expectViews),
    ...ink,
  });

  await page.locator(".stream-dock__actions button[title='Close stream viewer']").click();
  await row.click();
}

await browser.close();

console.log(JSON.stringify({ results, consoleErrors }, null, 2));

// A plot host that never got drawn on is one flat background colour, plus a
// border; anything genuinely rendered has many more than a handful.
const failures = results.filter((result) => {
  if (!result.modeOk || !result.viewsOk) {
    return true;
  }
  if (result.inspectorText === null && result.status !== "live") {
    return true;
  }
  return result.inspectorText === null
    ? result.colors < 5
    : !new RegExp(CASES.find((c) => c.topic === result.topic).expectNotice).test(result.inspectorText);
});
if (failures.length > 0 || consoleErrors.length > 0) {
  console.error("FAILED: a stream did not render as expected");
  process.exit(1);
}
console.log("OK: every demo stream rendered");
