import { describe, expect, it } from "vitest";

import { decodeStreamFrame, sampleAt } from "./streamFrames";
import type { StreamFrameHeader } from "../types/stream";

/** Builds a frame the way the backend does, so the test pins the real format. */
function encodeFrame(header: Record<string, unknown>, payload: Float32Array): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const buffer = new ArrayBuffer(4 + headerBytes.length + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerBytes.length, true);
  new Uint8Array(buffer, 4, headerBytes.length).set(headerBytes);
  new Uint8Array(buffer, 4 + headerBytes.length).set(new Uint8Array(payload.buffer.slice(0)));
  return buffer;
}

const SWEEP_HEADER: StreamFrameHeader = {
  kind: "stream.data",
  mode: "sweep",
  generation: 3,
  n_out: 2,
  n_channels: 3,
  components: 2,
  overflow: false,
};

describe("decodeStreamFrame", () => {
  it("splits the header from the payload", () => {
    const payload = new Float32Array([1, 2, 3, 4]);
    const { header, payload: decoded } = decodeStreamFrame(
      encodeFrame({ kind: "stream.data", n_out: 2 }, payload)
    );

    expect(header).toEqual({ kind: "stream.data", n_out: 2 });
    expect(Array.from(decoded)).toEqual([1, 2, 3, 4]);
  });

  it("decodes correctly whatever alignment the header length forces", () => {
    // A Float32Array view needs 4-byte alignment and the JSON header is
    // variable-length, so every residue has to work.
    for (const padding of ["", "a", "bb", "ccc"]) {
      const payload = new Float32Array([9, 8]);
      const { header, payload: decoded } = decodeStreamFrame(
        encodeFrame({ kind: "stream.data", pad: padding }, payload)
      );
      expect(header.kind).toBe("stream.data");
      expect(Array.from(decoded)).toEqual([9, 8]);
    }
  });

  it("rejects a truncated frame instead of returning nonsense", () => {
    const frame = encodeFrame({ kind: "stream.data" }, new Float32Array([1]));
    expect(() => decodeStreamFrame(frame.slice(0, 2))).toThrow(/length prefix/);
    expect(() => decodeStreamFrame(frame.slice(0, 6))).toThrow(/declared header/);
  });
});

describe("sampleAt", () => {
  it("reads min/max pairs out of (n_out, n_channels, components) layout", () => {
    // The trailing pair is what makes a row an RG32F texel run: channel 0's
    // (min, max) then channel 1's, and so on, one row per column.
    // column 0: (0,10) (1,11) (2,12) ; column 1: (3,13) (4,14) (5,15)
    const payload = new Float32Array([0, 10, 1, 11, 2, 12, 3, 13, 4, 14, 5, 15]);

    expect(sampleAt(payload, SWEEP_HEADER, 0, 0)).toEqual([0, 10]);
    expect(sampleAt(payload, SWEEP_HEADER, 0, 2)).toEqual([2, 12]);
    expect(sampleAt(payload, SWEEP_HEADER, 1, 1)).toEqual([4, 14]);
  });

  it("treats a single-component payload as a degenerate pair", () => {
    const header: StreamFrameHeader = { ...SWEEP_HEADER, components: 1, mode: "spectrum" };
    const payload = new Float32Array([7, 8, 9, 70, 80, 90]);

    expect(sampleAt(payload, header, 0, 1)).toEqual([8, 8]);
    expect(sampleAt(payload, header, 1, 2)).toEqual([90, 90]);
  });
});
