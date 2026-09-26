import { expect, test } from "vitest";
import { catalogTree } from "./ComponentBrowser";
import type { Registration } from "./document";
const entry = (id: string, distribution: string, value: string): Registration => ({ id, distribution, value, name: id, version: "1" });
const catalog = [
  entry("Scale", "ezmsg-sigproc", "ezmsg.sigproc.math.scale:Scale"),
  entry("Invert", "ezmsg-sigproc", "ezmsg.sigproc.math.invert:Invert"),
  entry("Source", "ezmsg-lsl", "ezmsg.lsl.inlet:LSLInletUnit"),
];
test("groups distribution, subpackage, and module without importing metadata", () => {
  const tree = catalogTree(catalog, "");
  expect(tree.map(g => g.name)).toEqual(["ezmsg-lsl", "ezmsg-sigproc"]);
  expect(tree[1].count).toBe(2);
  expect(tree[1].groups[0].name).toBe("math");
  expect(tree[1].groups[0].groups.map(g => g.name)).toEqual(["invert", "scale"]);
});
test("search matches extension and full module path with multiple terms", () => {
  expect(catalogTree(catalog, "SIGPROC math.scale")[0].count).toBe(1);
  expect(catalogTree(catalog, "absent")).toEqual([]);
});
