/**
 * JSON has no literal for infinity or NaN, so the backend sends non-finite
 * floats as the string tokens below (see backend/json_encoding.py) and expects
 * the same tokens back when such a value is patched.
 *
 * The tokens are spelled the way JavaScript spells them, so `Number(token)`
 * recovers the value.
 */

export const INFINITY_TOKEN = "Infinity";
export const NEGATIVE_INFINITY_TOKEN = "-Infinity";
export const NAN_TOKEN = "NaN";

const NON_FINITE_TOKENS = [INFINITY_TOKEN, NEGATIVE_INFINITY_TOKEN, NAN_TOKEN];

/** Spellings a Python user might reasonably type into a float field. */
const INPUT_ALIASES: Record<string, number> = {
  inf: Number.POSITIVE_INFINITY,
  infinity: Number.POSITIVE_INFINITY,
  "+inf": Number.POSITIVE_INFINITY,
  "+infinity": Number.POSITIVE_INFINITY,
  "-inf": Number.NEGATIVE_INFINITY,
  "-infinity": Number.NEGATIVE_INFINITY,
  nan: Number.NaN,
};

export function isNonFiniteToken(value: unknown): value is string {
  return typeof value === "string" && NON_FINITE_TOKENS.includes(value);
}

/** Encode a number for the wire: non-finite values become their token. */
export function encodeNumericValue(value: number): number | string {
  if (Number.isFinite(value)) {
    return value;
  }
  if (Number.isNaN(value)) {
    return NAN_TOKEN;
  }
  return value > 0 ? INFINITY_TOKEN : NEGATIVE_INFINITY_TOKEN;
}

/** Read a wire value as a number, or `null` when it is not numeric. */
export function decodeNumericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }
  if (isNonFiniteToken(value)) {
    return Number(value);
  }
  return null;
}

/** Format a wire value for a text/number input. */
export function formatNumericValue(value: unknown): string {
  const numeric = decodeNumericValue(value);
  return numeric === null ? "" : String(numeric);
}

/** Parse user input, accepting Python and JavaScript spellings of inf/nan. */
export function parseNumericInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const alias = INPUT_ALIASES[trimmed.toLowerCase()];
  if (alias !== undefined) {
    return alias;
  }
  const numeric = Number(trimmed);
  return Number.isNaN(numeric) ? null : numeric;
}
