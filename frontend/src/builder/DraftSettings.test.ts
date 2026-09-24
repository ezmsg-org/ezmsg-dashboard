import { expect, test } from "vitest";
import { draftFields } from "./DraftSettings";
import type { Details } from "./document";

test("adapts nullable numbers, enum references, bounds and compound JSON fields", () => {
  const details = { settings_fields: [
    { name: "factor", type: "int | None", default: null },
    { name: "mode", required: true }, { name: "coefficients" },
  ], json_schema: {
    $defs: { Mode: { type: "string", enum: ["low", "high"] } },
    properties: {
      factor: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }], default: null },
      mode: { $ref: "#/$defs/Mode" },
      coefficients: { type: "array", items: { type: "number" } },
    },
  } } as Details;
  const fields = draftFields(details);
  expect(fields[0]).toMatchObject({ field_type: "integer", nullable: true, default: null, bounds: [1, null] });
  expect(fields[1]).toMatchObject({ field_type: "string", choices: ["low", "high"], required: true });
  expect(fields[2]).toMatchObject({ field_type: "array", nullable: false });
});
