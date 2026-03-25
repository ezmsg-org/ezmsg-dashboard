import { expect, test, type Locator, type Page } from "@playwright/test";

type NodeBox = {
  testId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

async function primeGlobalSettings(
  page: Page,
  overrides: Record<string, unknown> = {}
) {
  await page.addInitScript((settings) => {
    window.localStorage.setItem(
      "ezmsg-dashboard-global-settings",
      JSON.stringify(settings)
    );
  }, {
    snapshotPollSeconds: 2,
    themeMode: "light",
    topologyDefaultLayout: "lr",
    edgeConnectorStyle: "curved",
    showLegend: true,
    showMiniMap: true,
    traceMetricsPreset: "publish+lease+backpressure",
    autoFitOnLayoutScopeChange: true,
    autoFocusOnInspectorSelection: true,
    inspectorWidthPx: 500,
    ...overrides,
  });
}

async function enableDarkMode(page: Page) {
  await primeGlobalSettings(page, { themeMode: "dark" });
}

async function primeVisualSnapshotSettings(
  page: Page,
  overrides: Record<string, unknown> = {}
) {
  await primeGlobalSettings(page, {
    themeMode: "dark",
    topologyDefaultLayout: "lr",
    showLegend: false,
    showMiniMap: false,
    inspectorWidthPx: 500,
    ...overrides,
  });
}

async function collectNodeBoxes(
  page: Page,
  prefixes: string[]
): Promise<NodeBox[]> {
  return page.locator('[data-testid^="rf__node-"]').evaluateAll((elements, activePrefixes) => {
    return elements.flatMap((element) => {
      const testId = element.getAttribute("data-testid") ?? "";
      if (!activePrefixes.some((prefix) => testId.startsWith(prefix))) {
        return [];
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return [];
      }
      return [{
        testId,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }];
    });
  }, prefixes);
}

async function boxForTestId(page: Page, testId: string): Promise<NodeBox> {
  const locator = page.getByTestId(testId);
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return {
    testId,
    left: box?.x ?? 0,
    top: box?.y ?? 0,
    right: (box?.x ?? 0) + (box?.width ?? 0),
    bottom: (box?.y ?? 0) + (box?.height ?? 0),
    width: box?.width ?? 0,
    height: box?.height ?? 0,
  };
}

async function clickWithTinyPointerMove(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 1, y + 1);
  await page.mouse.up();
}

async function openScopeIfPresent(page: Page, collectionName: string) {
  const scopeTail = page.locator(".topology-scope-tail", { hasText: collectionName });
  const alreadyScoped = await scopeTail.isVisible({ timeout: 250 }).catch(() => false);
  if (alreadyScoped) {
    return;
  }
  const button = page.locator(`button[aria-label="Open ${collectionName} scope"]`);
  const isVisible = await button.isVisible({ timeout: 250 }).catch(() => false);
  if (isVisible) {
    await button.dispatchEvent("click");
  }
}

function overlapArea(left: NodeBox, right: NodeBox): number {
  const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
  const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function expectNoMeaningfulOverlap(boxes: NodeBox[], label: string) {
  for (let index = 0; index < boxes.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < boxes.length; nextIndex += 1) {
      expect(
        overlapArea(boxes[index], boxes[nextIndex]),
        `${label}: ${boxes[index].testId} overlaps ${boxes[nextIndex].testId}`
      ).toBeLessThan(4);
    }
  }
}

function expectBoxesInside(parent: NodeBox, children: NodeBox[], label: string) {
  for (const child of children) {
    expect(child.left, `${label}: ${child.testId} extends past parent left`).toBeGreaterThanOrEqual(
      parent.left - 1
    );
    expect(child.right, `${label}: ${child.testId} extends past parent right`).toBeLessThanOrEqual(
      parent.right + 1
    );
    expect(child.top, `${label}: ${child.testId} extends past parent top`).toBeGreaterThanOrEqual(
      parent.top - 1
    );
    expect(child.bottom, `${label}: ${child.testId} extends past parent bottom`).toBeLessThanOrEqual(
      parent.bottom + 1
    );
  }
}

async function expectStableScreenshot(locator: Locator, name: string) {
  await expect(locator).toHaveScreenshot(name, {
    animations: "disabled",
    caret: "hide",
    scale: "css",
    maxDiffPixelRatio: 0.01,
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

test("long-label fixture keeps type pills contained and exposes richer tooltips", async ({
  page,
}) => {
  await page.goto("/?fixture=long-labels");

  const scopeLabel = page.locator(".topology-collection-label--scope");
  await expect(scopeLabel).toHaveAttribute(
    "title",
    /EXTRAORDINARILY_VERBOSE_COLLECTION_NAME_FOR_LAYOUT_TESTING/
  );

  const unitCard = await boxForTestId(
    page,
    "rf__node-unit:LONG_SCOPE/COMPONENT_WITH_EXCEPTIONALLY_LONG_NAME"
  );
  const unitTypePill = page.locator(
    '.topology-unit-type[title*="ExceptionallyLongComponentTypeName"]'
  );
  const typePillBox = await unitTypePill.boundingBox();
  expect(typePillBox).not.toBeNull();
  expect(((typePillBox?.x ?? 0) + (typePillBox?.width ?? 0)) <= unitCard.right + 1).toBe(true);

  await expect(
    page.getByTestId(
      "rf__node-stream:LONG_SCOPE/EXTRAORDINARILY_VERBOSE_PUBLISHER_TOPIC_NAME:publisher-endpoint-with-a-very-long-token"
    )
  )
    .toContainText("OUTPUT_WITH_A_LONG_NAME");
  await expect(
    page.locator(
      '[data-testid="rf__node-stream:LONG_SCOPE/EXTRAORDINARILY_VERBOSE_PUBLISHER_TOPIC_NAME:publisher-endpoint-with-a-very-long-token"] .topology-stream-label'
    )
  ).toHaveAttribute("title", /ReallyLongStructuredMessageTypeName/);

  await page
    .getByTestId("rf__node-unit:LONG_SCOPE/COMPONENT_WITH_EXCEPTIONALLY_LONG_NAME")
    .click({ position: { x: 24, y: 18 } });
  const settingsType = page.locator(
    '.settings-type[title*="ExceptionallyLongComponentTypeName"]'
  );
  await expect(settingsType).toBeVisible();
  const settingsRow = page.locator(".settings-component-row", {
    has: page.locator(
      '.settings-component-address[title="LONG_SCOPE/COMPONENT_WITH_EXCEPTIONALLY_LONG_NAME"]'
    ),
  });
  const settingsOverflow = await settingsRow.evaluate(
    (element) => element.scrollWidth - element.clientWidth
  );
  expect(settingsOverflow).toBeLessThanOrEqual(2);

  await page
    .locator(".settings-component-row", {
      has: page.locator('.settings-component-address[title="LONG_SCOPE"]'),
    })
    .getByRole("button")
    .click();
  const booleanRow = page.locator(".settings-field-row", {
    has: page.locator("label", { hasText: "debug_mode_enabled" }),
  });
  const checkbox = booleanRow.locator('input[type="checkbox"]');
  const checkboxBox = await checkbox.boundingBox();
  expect(checkboxBox).not.toBeNull();
  expect(checkboxBox?.width ?? 0).toBeLessThanOrEqual(20);
  expect(checkboxBox?.height ?? 0).toBeLessThanOrEqual(20);
  const booleanOverflow = await booleanRow.evaluate(
    (element) => element.scrollWidth - element.clientWidth
  );
  expect(booleanOverflow).toBeLessThanOrEqual(2);
});

test("stream identifiers render without semantic shortening for common code names", async ({
  page,
}) => {
  await page.goto("/?fixture=semantic-stream-names");

  const expectations = [
    {
      testId: "rf__node-stream:SIN/INPUT_SIGNAL_TOPIC:sin-input-signal",
      name: "INPUT_SIGNAL",
      type: "[AxisArray]",
    },
    {
      testId: "rf__node-stream:SIN/INPUT_SETTINGS_TOPIC:sin-input-settings",
      name: "INPUT_SETTINGS",
      type: "[LFOSettings]",
    },
    {
      testId: "rf__node-stream:SIN/OUTPUT_SIGNAL_TOPIC:sin-output-signal",
      name: "OUTPUT_SIGNAL",
      type: "[AxisArray]",
    },
  ] as const;

  for (const expectation of expectations) {
    const node = page.getByTestId(expectation.testId);
    await expect(node).toContainText(expectation.name);
    await expect(node).toContainText(expectation.type);

    const nameOverflow = await node.locator(".topology-stream-name").evaluate(
      (element) => element.scrollWidth - element.clientWidth
    );
    expect(nameOverflow, `${expectation.name} should render without truncation`).toBeLessThanOrEqual(1);

    const typeOverflow = await node.locator(".topology-stream-type").evaluate(
      (element) => element.scrollWidth - element.clientWidth
    );
    expect(typeOverflow, `${expectation.type} should render without truncation`).toBeLessThanOrEqual(1);
  }
});

test("nested collection fixture supports breadcrumbs and root transitions", async ({
  page,
}) => {
  await page.goto("/?fixture=nested-collections");

  await expect(page.locator('button[aria-label="Open LAB scope"]')).toBeVisible();
  await expect(page.getByTestId("rf__node-unit:CONTROL/PROBE")).toBeVisible();

  await page.locator('button[aria-label="Open LAB scope"]').click();
  await expect(page.getByTestId("rf__node-unit:CONTROL/PROBE")).toHaveCount(0);
  await expect(page.locator('button[aria-label="Open PIPELINE scope"]')).toBeVisible();
  await expect(page.locator(".topology-scope-tail")).toHaveText("LAB");
  await expect(page.locator(".topology-scope-tail")).toHaveAttribute("title", /fixture\.RootCollection/);

  await page.locator('button[aria-label="Open PIPELINE scope"]').click();
  await expect(page.getByTestId("rf__node-unit:LAB/PIPELINE/SOURCE")).toBeVisible();
  await expect(page.locator('button[aria-label="Open INNER scope"]')).toBeVisible();
  await expect(page.locator(".topology-scope-chip", { hasText: "LAB" })).toHaveAttribute(
    "title",
    /fixture\.RootCollection/
  );

  await page.locator('button[aria-label="Open INNER scope"]').click();
  await expect(page.getByTestId("rf__node-unit:LAB/PIPELINE/INNER/SINK")).toBeVisible();

  await expect(page.locator(".topology-scope-chip", { hasText: "LAB" })).toBeVisible();
  await expect(
    page.locator(".topology-scope-chip", { hasText: "PIPELINE" })
  ).toBeVisible();
  await expect(page.locator(".topology-scope-tail")).toHaveText("INNER");

  await page
    .getByTestId("rf__node-scope:LAB/PIPELINE/INNER")
    .locator('button[aria-label="Go up from INNER"]')
    .click();
  await expect(page.locator(".topology-scope-tail")).toHaveText("PIPELINE");
  await expect(page.getByTestId("rf__node-unit:LAB/PIPELINE/SOURCE")).toBeVisible();

  await page.locator(".topology-scope-chip", { hasText: "LAB" }).click();
  await expect(page.locator(".topology-scope-tail")).toHaveText("LAB");
  await expect(page.locator('button[aria-label="Open PIPELINE scope"]')).toBeVisible();

  await page.locator(".topology-flow-toolbar button", { hasText: "Root" }).click();
  await expect(page.locator('button[aria-label="Open LAB scope"]')).toBeVisible();
  await expect(page.getByTestId("rf__node-unit:CONTROL/PROBE")).toBeVisible();
});

test("collection open and up buttons still activate after a tiny pointer move", async ({
  page,
}) => {
  await page.goto("/?fixture=nested-collections");

  await clickWithTinyPointerMove(page, page.locator('button[aria-label="Open LAB scope"]'));
  await expect(page.locator(".topology-scope-tail")).toHaveText("LAB");

  await clickWithTinyPointerMove(
    page,
    page
      .getByTestId("rf__node-scope:LAB")
      .locator('button[aria-label="Go up from LAB"]')
  );
  await expect(page.locator('button[aria-label="Open LAB scope"]')).toBeVisible();
});

test("top-right shortcut dock toggles layout and theme", async ({ page }) => {
  await page.goto("/?fixture=root-scope-navigation");

  const layoutShortcut = page.getByRole("button", { name: "Topology layout left-to-right" });
  await expect(layoutShortcut).toBeVisible();
  await layoutShortcut.click();
  await expect(
    page.getByRole("button", { name: "Topology layout top-to-bottom" })
  ).toBeVisible();

  const themeShortcut = page.getByRole("button", { name: "Theme light" });
  await expect(themeShortcut).toBeVisible();
  await themeShortcut.click();
  await expect(page.locator(".dashboard-layout")).toHaveClass(/is-dark/);
  await expect(page.getByRole("button", { name: "Theme dark" })).toBeVisible();
});

test("orphan stream fixture renders orphan source and sink nodes", async ({ page }) => {
  await page.goto("/?fixture=orphan-streams");

  await expect(page.getByTestId("rf__node-stream:ORPHAN/INPUT_TOPIC")).toBeVisible();
  await expect(page.getByTestId("rf__node-stream:ORPHAN/OUTPUT_TOPIC")).toBeVisible();
});

test("profiling trace fixture covers sparse and dense publisher traces", async ({ page }) => {
  await page.goto("/?fixture=profiling-trace-rates");

  const sparseRow = page.locator(".publisher-row", {
    has: page.locator('.publisher-topic[title="TRACE_LAB/SPARSE_TOPIC"]'),
  });
  const denseRow = page.locator(".publisher-row", {
    has: page.locator('.publisher-topic[title="TRACE_LAB/DENSE_TOPIC"]'),
  });
  await expect(sparseRow).toBeVisible();
  await expect(denseRow).toBeVisible();

  await sparseRow.locator(".publisher-row__toggle").click();
  await expect(sparseRow.locator(".subscriber-item")).toHaveCount(6);
  await sparseRow.getByRole("button", { name: /Start Profiling Trace/ }).click();

  const traceDock = page.locator(".trace-dock-trace");
  await expect(traceDock.locator(".timing-trace__canvas")).toBeVisible();
  await expect(traceDock).not.toContainText("Waiting for trace samples");
  await expect(traceDock.locator('.timing-trace__axis-input input').first()).toHaveValue("10.0");
  await sparseRow.getByRole("button", { name: /Stop Profiling Trace/ }).click();

  await denseRow.locator(".publisher-row__toggle").click();
  await expect(denseRow.locator(".subscriber-item")).toHaveCount(8);
  await denseRow.getByRole("button", { name: /Start Profiling Trace/ }).click();
  await expect(traceDock).not.toContainText("Waiting for trace samples");
  await expect(traceDock.locator('.timing-trace__axis-input input').first()).toHaveValue("2.0");
});

test("massive fanout fixture keeps owner cards separated inside scope", async ({ page }) => {
  await page.goto("/?fixture=massive-fanout");

  await openScopeIfPresent(page, "MEGA");
  const ownerBoxes = await collectNodeBoxes(page, ["rf__node-unit:MEGA/"]);
  expect(ownerBoxes.length).toBe(25);
  expectNoMeaningfulOverlap(ownerBoxes, "massive fanout scope");
});

test("dense unit fixture keeps stream and task nodes inside the router card", async ({
  page,
}) => {
  await page.goto("/?fixture=dense-unit-layout");

  await openScopeIfPresent(page, "MATRIX");
  const routerBox = await boxForTestId(page, "rf__node-unit:MATRIX/ROUTER");
  const childBoxes = await collectNodeBoxes(page, [
    "rf__node-stream:MATRIX/IN_",
    "rf__node-stream:MATRIX/OUT_",
    "rf__node-task:MATRIX/ROUTER:",
  ]);
  expect(childBoxes.length).toBe(36);
  expectBoxesInside(routerBox, childBoxes, "dense unit router");
  expectNoMeaningfulOverlap(childBoxes, "dense unit router");
});

test("cyclic feedback fixture renders distinct owner cards without collapse", async ({
  page,
}) => {
  await page.goto("/?fixture=cyclic-feedback");

  const ownerBoxes = await collectNodeBoxes(page, [
    "rf__node-unit:ALPHA",
    "rf__node-unit:BETA",
    "rf__node-unit:GAMMA",
    "rf__node-unit:MONITOR",
  ]);
  expect(ownerBoxes.length).toBe(4);
  expectNoMeaningfulOverlap(ownerBoxes, "cyclic feedback root");
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

test("settings edits apply in fixture mode", async ({ page }) => {
  await page.goto("/?fixture=root-scope-navigation");

  await page.locator('button[aria-label="Open SYSTEM scope"]').click();
  await page
    .getByTestId("rf__node-unit:SYSTEM/PING")
    .click({ position: { x: 24, y: 18 } });

  const rateRow = page.locator(".settings-field-row", {
    has: page.locator("label", { hasText: "rate_hz" }),
  });
  await rateRow.locator('input[type="number"]').fill("42");
  await rateRow.getByRole("button", { name: "Apply" }).click();

  await expect(rateRow.locator(".patch-status.ok")).toHaveText("Applied rate_hz");
  await expect(rateRow.locator('input[type="number"]')).toHaveValue("42");
});

test("inspector widths keep settings and publisher rows from horizontal overflow", async ({
  page,
}) => {
  for (const width of [360, 500, 900]) {
    await primeGlobalSettings(page, { inspectorWidthPx: width });
    await page.goto("/?fixture=root-scope-navigation");

    await page.locator('button[aria-label="Open SYSTEM scope"]').click();
    await page
      .getByTestId("rf__node-unit:SYSTEM/PING")
      .click({ position: { x: 24, y: 18 } });

    const settingsRow = page.locator(".settings-field-row", {
      has: page.locator("label", { hasText: "rate_hz" }),
    });
    const settingsOverflow = await settingsRow.evaluate(
      (element) => element.scrollWidth - element.clientWidth
    );
    expect(settingsOverflow, `settings row overflow at ${width}px`).toBeLessThanOrEqual(2);

    await page
      .getByTestId("rf__node-stream:SYSTEM/PING_TOPIC:ping-output-endpoint")
      .click();

    const publisherRow = page.locator(".publisher-row", {
      has: page.locator('.publisher-topic[title="SYSTEM/PING_TOPIC"]'),
    });
    const publisherOverflow = await publisherRow.evaluate(
      (element) => element.scrollWidth - element.clientWidth
    );
    expect(publisherOverflow, `publisher row overflow at ${width}px`).toBeLessThanOrEqual(2);
  }
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

test("dark mode keeps publisher severity highlights visible", async ({ page }) => {
  await enableDarkMode(page);
  await page.goto("/?fixture=profiling-trace-rates");

  const denseRow = page.locator(".publisher-row", {
    has: page.locator('.publisher-topic[title="TRACE_LAB/DENSE_TOPIC"]'),
  });
  const sparseRow = page.locator(".publisher-row", {
    has: page.locator('.publisher-topic[title="TRACE_LAB/SPARSE_TOPIC"]'),
  });

  await expect(denseRow).toHaveCSS("border-top-color", "rgb(251, 191, 36)");
  await expect(sparseRow).toHaveCSS("border-top-color", "rgb(74, 222, 128)");
});

test.describe("visual baselines", () => {
  test("long-labels topology remains readable", async ({ page }) => {
    await primeVisualSnapshotSettings(page, {
      topologyDefaultLayout: "tb",
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/?fixture=long-labels");
    await page.waitForTimeout(150);

    await expectStableScreenshot(
      page.locator(".topology-flow-shell"),
      "long-labels-topology-dark.png"
    );
  });

  test("nested-collections scoped topology remains readable", async ({ page }) => {
    await primeVisualSnapshotSettings(page, {
      topologyDefaultLayout: "tb",
    });
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto("/?fixture=nested-collections");
    await page.locator('button[aria-label="Open LAB scope"]').click();
    await page.locator('button[aria-label="Open PIPELINE scope"]').click();
    await page.waitForTimeout(150);

    await expectStableScreenshot(
      page.locator(".topology-flow-shell"),
      "nested-collections-pipeline-scope-dark.png"
    );
  });

  test("massive-fanout scoped topology remains readable", async ({ page }) => {
    await primeVisualSnapshotSettings(page, {
      topologyDefaultLayout: "lr",
    });
    await page.setViewportSize({ width: 1800, height: 1100 });
    await page.goto("/?fixture=massive-fanout");
    await openScopeIfPresent(page, "MEGA");
    await page.waitForTimeout(150);

    await expectStableScreenshot(
      page.locator(".topology-flow-shell"),
      "massive-fanout-scope-dark.png"
    );
  });

  test("profiling publishers pane remains readable with many subscribers", async ({
    page,
  }) => {
    await primeVisualSnapshotSettings(page, {
      inspectorWidthPx: 560,
    });
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto("/?fixture=profiling-trace-rates");

    const sparseRow = page.locator(".publisher-row", {
      has: page.locator('.publisher-topic[title="TRACE_LAB/SPARSE_TOPIC"]'),
    });
    const denseRow = page.locator(".publisher-row", {
      has: page.locator('.publisher-topic[title="TRACE_LAB/DENSE_TOPIC"]'),
    });
    await sparseRow.locator(".publisher-row__toggle").click();
    await denseRow.locator(".publisher-row__toggle").click();
    await page.waitForTimeout(150);

    await expectStableScreenshot(
      page.locator(".inspector-section", {
        has: page.locator(".inspector-section__header", { hasText: "Publishers" }),
      }),
      "profiling-publishers-pane-dark.png"
    );
  });
});
