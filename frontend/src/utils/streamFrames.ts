import type { StreamFrame, StreamFrameHeader } from "../types/stream";

/** Bytes of little-endian `uint32` length prefix. Mirrors backend/stream_frames.py. */
const HEADER_PREFIX_BYTES = 4;

/**
 * Split `[u32 header_len][utf-8 JSON header][float32 payload]`.
 *
 * The payload is wrapped, not copied: `Float32Array` over the same buffer costs
 * nothing per sample, which is the entire reason the data path is binary rather
 * than JSON. Callers must treat the result as valid only until they hand the
 * buffer back — in practice the renderer reads it straight into its ring.
 *
 * Byte order is not negotiated. The encoder pins little-endian and every
 * platform that runs a browser is little-endian, so the wrap is safe; a
 * `DataView` loop to be pedantic about it would reintroduce the per-sample cost
 * this format exists to avoid.
 */
export function decodeStreamFrame(buffer: ArrayBuffer): StreamFrame {
  if (buffer.byteLength < HEADER_PREFIX_BYTES) {
    throw new Error("stream frame is shorter than its length prefix");
  }
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const headerEnd = HEADER_PREFIX_BYTES + headerLength;
  if (buffer.byteLength < headerEnd) {
    throw new Error("stream frame is shorter than its declared header");
  }
  const headerText = new TextDecoder().decode(
    new Uint8Array(buffer, HEADER_PREFIX_BYTES, headerLength)
  );
  const header = JSON.parse(headerText) as StreamFrameHeader;

  const payloadBytes = buffer.byteLength - headerEnd;
  // A Float32Array view needs 4-byte alignment. The JSON header is
  // variable-length, so the payload lands wherever it lands; copy only in the
  // (uncommon) misaligned case rather than always.
  const payload =
    headerEnd % 4 === 0
      ? new Float32Array(buffer, headerEnd, payloadBytes / 4)
      : new Float32Array(buffer.slice(headerEnd));

  return { header, payload };
}

/**
 * Read one channel's min/max pair out of a sweep payload.
 *
 * Layout is row-major `(n_out, n_channels, components)`, which is also the
 * memory layout of the `RG32F` texture the renderer uploads it into: one row
 * per column, one texel per channel, red and green holding the pair.
 */
export function sampleAt(
  payload: Float32Array,
  header: StreamFrameHeader,
  column: number,
  channel: number
): [number, number] {
  const base = (column * header.n_channels + channel) * header.components;
  const low = payload[base];
  return header.components >= 2 ? [low, payload[base + 1]] : [low, low];
}
