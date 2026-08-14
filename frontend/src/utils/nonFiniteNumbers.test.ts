import { describe, expect, it } from "vitest";

import {
  decodeNumericValue,
  encodeNumericValue,
  formatNumericValue,
  isNonFiniteToken,
  parseNumericInput,
} from "./nonFiniteNumbers";

describe("non-finite number tokens", () => {
  it("recognizes the wire tokens", () => {
    expect(isNonFiniteToken("Infinity")).toBe(true);
    expect(isNonFiniteToken("-Infinity")).toBe(true);
    expect(isNonFiniteToken("NaN")).toBe(true);
    expect(isNonFiniteToken("infinity")).toBe(false);
    expect(isNonFiniteToken("12")).toBe(false);
    expect(isNonFiniteToken(12)).toBe(false);
  });

  it("encodes non-finite numbers and passes finite ones through", () => {
    expect(encodeNumericValue(1.5)).toBe(1.5);
    expect(encodeNumericValue(0)).toBe(0);
    expect(encodeNumericValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(encodeNumericValue(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
    expect(encodeNumericValue(Number.NaN)).toBe("NaN");
  });

  it("decodes wire values back to numbers", () => {
    expect(decodeNumericValue(2)).toBe(2);
    expect(decodeNumericValue("Infinity")).toBe(Number.POSITIVE_INFINITY);
    expect(decodeNumericValue("-Infinity")).toBe(Number.NEGATIVE_INFINITY);
    expect(decodeNumericValue("NaN")).toBeNaN();
    expect(decodeNumericValue("alpha")).toBeNull();
    expect(decodeNumericValue(null)).toBeNull();
    expect(decodeNumericValue(undefined)).toBeNull();
  });

  it("round-trips through the wire representation", () => {
    for (const value of [
      1.25,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(decodeNumericValue(encodeNumericValue(value))).toBe(value);
    }
    expect(decodeNumericValue(encodeNumericValue(Number.NaN))).toBeNaN();
  });

  it("formats wire values for inputs", () => {
    expect(formatNumericValue(3)).toBe("3");
    expect(formatNumericValue("Infinity")).toBe("Infinity");
    expect(formatNumericValue("NaN")).toBe("NaN");
    expect(formatNumericValue("alpha")).toBe("");
    expect(formatNumericValue(null)).toBe("");
  });

  it("parses javascript and python spellings of non-finite input", () => {
    expect(parseNumericInput("Infinity")).toBe(Number.POSITIVE_INFINITY);
    expect(parseNumericInput("inf")).toBe(Number.POSITIVE_INFINITY);
    expect(parseNumericInput(" INF ")).toBe(Number.POSITIVE_INFINITY);
    expect(parseNumericInput("+inf")).toBe(Number.POSITIVE_INFINITY);
    expect(parseNumericInput("-inf")).toBe(Number.NEGATIVE_INFINITY);
    expect(parseNumericInput("-Infinity")).toBe(Number.NEGATIVE_INFINITY);
    expect(parseNumericInput("nan")).toBeNaN();
    expect(parseNumericInput("NaN")).toBeNaN();
  });

  it("parses ordinary numbers and rejects junk", () => {
    expect(parseNumericInput("42")).toBe(42);
    expect(parseNumericInput(" -1.5e3 ")).toBe(-1500);
    expect(parseNumericInput("")).toBeNull();
    expect(parseNumericInput("   ")).toBeNull();
    expect(parseNumericInput("12abc")).toBeNull();
    expect(parseNumericInput("alpha")).toBeNull();
  });
});
