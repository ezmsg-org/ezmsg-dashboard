import { expect, test, type Page } from "@playwright/test";

async function enableDarkMode(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "ezmsg-dashboard-global-settings",
      JSON.stringify({
        snapshotPollSeconds: 2,
        themeMode: "dark",
        topologyDefaultLayout: "lr",
        edgeConnectorStyle: "curved",
        showLegend: true,
        showMiniMap: true,
        traceMetricsPreset: "publish+lease+backpressure",
        autoFitOnLayoutScopeChange: true,
        autoFocusOnInspectorSelection: true,
        inspectorWidthPx: 500,
      })
    );
  });
}

test("brand card fits its content instead of stretching across the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/?fixture=root-scope-navigation");

  const brandCard = page.locator(".dashboard-brand-card");
  await expect(brandCard).toBeVisible();
  const box = await brandCard.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeLessThan(760);
});

test("top-level scoped collection can navigate back up to root", async ({
  page,
}) => {
  await page.goto("/?fixture=root-scope-navigation");

  await page.locator('button[aria-label="Open SYSTEM scope"]').click();
  const upButton = page.locator('button[aria-label="Go up from SYSTEM"]');
  await expect(upButton).toBeEnabled();
  await upButton.click();

  await expect(page.locator('button[aria-label="Open SYSTEM scope"]')).toBeVisible();
});

test("wide fixture renders the stress collection and sink units", async ({ page }) => {
  await page.goto("/?fixture=wide-fanout");

  await expect(page.getByTestId("rf__node-collection:STRESS")).toBeVisible();
  await page.locator('button[aria-label="Open STRESS scope"]').click();
  await expect(page.getByTestId("rf__node-unit:STRESS/AGGREGATOR")).toBeVisible();
  await expect(page.getByTestId("rf__node-unit:STRESS/SINK_6")).toBeVisible();
});

test("clicking a topology unit focuses the matching settings row", async ({ page }) => {
  await page.goto("/?fixture=root-scope-navigation");

  await page.locator('button[aria-label="Open SYSTEM scope"]').click();
  await page
    .getByTestId("rf__node-unit:SYSTEM/PING")
    .click({ position: { x: 24, y: 18 } });

  const settingsRow = page.locator(".settings-component-row", {
    has: page.locator('.settings-component-address[title="SYSTEM/PING"]'),
  });
  await expect(settingsRow).toHaveClass(/is-expanded/);
});

test("clicking a topology publisher stream expands the publishers row", async ({
  page,
}) => {
  await page.goto("/?fixture=root-scope-navigation");

  await page.locator('button[aria-label="Open SYSTEM scope"]').click();
  await page
    .getByTestId("rf__node-stream:SYSTEM/PING_TOPIC:ping-output-endpoint")
    .click();

  const publisherRow = page.locator(".publisher-row", {
    has: page.locator('.publisher-topic[title="SYSTEM/PING_TOPIC"]'),
  });
  await expect(
    publisherRow.locator(".publisher-row__details")
  ).toBeVisible();
});

test("dark mode keeps the zoom controls readable", async ({ page }) => {
  await enableDarkMode(page);
  await page.goto("/?fixture=root-scope-navigation");

  const controlIcon = page
    .locator(".react-flow__controls button svg")
    .first();
  await expect(controlIcon).toBeVisible();
  await expect(controlIcon).toHaveCSS("color", "rgb(219, 231, 245)");
});
