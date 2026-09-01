"""Staging and wire-encoding for live sample data on its way to the browser.

Everything here is plain numpy with no ezmsg, asyncio or FastAPI in sight, which
is what makes the interesting parts -- ring wraparound, overflow accounting, and
envelope reduction -- testable without a running graph.

Three ideas carry the module:

**A ring, not a queue.** A tap reads messages at whatever rate the publisher
sends them and the browser reads frames at its refresh rate; those are unrelated
clocks. The ring absorbs the difference. It is deliberately small -- it stages
one pump interval plus slack, not the display history, which lives in the
browser -- so sizing it is about jitter, not about how much past the user wants
to see.

**Overflow is reported, never hidden.** When a reader falls far enough behind
that the writer laps it, the samples in between are gone. Silently handing over
whatever is currently in the ring would draw a seamless trace across a gap that
really happened, which is worse than useless on a plot someone is using to
decide whether a pipeline is healthy. :meth:`SampleRing.read` says so instead.

**One payload shape.** Everything a sweep draws goes out as ``(n_out,
n_channels, 2)`` min/max pairs, whether it was decimated, passed through, or
arrived as a native (min, max) envelope from an upstream aggregator. A single
shape means a single code path in the renderer, and the degenerate case
(min == max) draws as the polyline it is.

That shape is also, exactly, the memory layout of an ``RG32F`` texture with one
row per column and one texel per channel, which is how the browser holds the
ring. A frame therefore uploads with ``texSubImage2D`` untouched -- no transpose,
no per-sample work on either side of the wire.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any

import numpy as np

# Little-endian float32 everywhere on the wire. The browser reads payloads as a
# `Float32Array`, which uses *its* platform's byte order, so pinning the encoder
# to LE is what keeps a big-endian server from shipping plausible-looking
# garbage. Nothing else in the payload needs an endianness decision.
WIRE_DTYPE = np.dtype("<f4")

#: Bytes the header length prefix occupies, little-endian ``uint32``.
HEADER_PREFIX = "<I"
HEADER_PREFIX_SIZE = struct.calcsize(HEADER_PREFIX)


@dataclass
class RingCursor:
    """One reader's position in a :class:`SampleRing`.

    Held per websocket client rather than per ring so that several browsers
    watching one topic share a single subscriber without stealing each other's
    samples.
    """

    total_read: int = 0


class SampleRing:
    """Fixed-capacity circular buffer of ``(n_channels, width)`` samples.

    ``width`` is the stream's native per-sample tuple: 1 for an ordinary signal,
    2 when an upstream aggregator already reduced it to (min, max). Keeping the
    native width here rather than expanding everything to pairs on write is what
    keeps the hot path -- one slice assignment per message -- cheap.

    Positions are tracked as monotonic totals rather than an index plus a wrap
    counter. The two are equivalent, but totals make "how far behind is this
    reader" a subtraction instead of a case analysis, and there is no fixed-size
    header forcing the counter to wrap the way there is across a shared-memory
    boundary.
    """

    def __init__(self, capacity: int, n_channels: int, width: int) -> None:
        if capacity <= 0:
            raise ValueError(f"capacity must be positive, got {capacity}")
        if n_channels <= 0:
            raise ValueError(f"n_channels must be positive, got {n_channels}")
        if width <= 0:
            raise ValueError(f"width must be positive, got {width}")
        self._capacity = int(capacity)
        self._n_channels = int(n_channels)
        self._width = int(width)
        self._buffer = np.zeros((self._capacity, self._n_channels, self._width), dtype=np.float32)
        self.total_written = 0

    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def n_channels(self) -> int:
        return self._n_channels

    @property
    def width(self) -> int:
        return self._width

    def write(self, block: np.ndarray) -> None:
        """Append ``(n_samples, n_channels, width)`` samples, wrapping as needed.

        A block longer than the whole ring keeps only its tail: the samples it
        would have overwritten within this one call are already unreachable, so
        copying them in first would be work no reader could ever observe.
        """
        if block.ndim != 3 or block.shape[1:] != (self._n_channels, self._width):
            raise ValueError(f"block shape {block.shape} does not match ring ({self._n_channels}, {self._width})")
        n_samples = int(block.shape[0])
        if n_samples == 0:
            return
        if n_samples > self._capacity:
            block = block[-self._capacity :]
            # The dropped head still happened; count it so a reader sees the gap.
            self.total_written += n_samples - self._capacity
            n_samples = self._capacity

        block = np.asarray(block, dtype=np.float32)
        start = self.total_written % self._capacity
        end = start + n_samples
        if end <= self._capacity:
            self._buffer[start:end] = block
        else:
            split = self._capacity - start
            self._buffer[start:] = block[:split]
            self._buffer[: end - self._capacity] = block[split:]
        self.total_written += n_samples

    def read(self, cursor: RingCursor, *, max_samples: int | None = None) -> tuple[np.ndarray, bool, int]:
        """Take everything ``cursor`` has not seen yet.

        Returns ``(block, overflowed, first_sample_index)``. ``block`` is always
        a copy: the caller is about to await a socket write, by which point the
        writer may well have overwritten the region it came from.

        ``first_sample_index`` counts from the first sample this ring ever
        accepted, which is what lets the client put a real time axis under the
        data even across a gap.
        """
        available = self.total_written - cursor.total_read
        overflowed = available > self._capacity
        if overflowed:
            # Skip to the oldest sample still present rather than serving a
            # block stitched from two different laps of the ring.
            cursor.total_read = self.total_written - self._capacity
            available = self._capacity
        if available < 0:  # a rebuilt ring reset total_written under this cursor
            cursor.total_read = self.total_written
            available = 0

        n_samples = available if max_samples is None else min(available, max_samples)
        first_sample_index = cursor.total_read
        if n_samples <= 0:
            empty = np.empty((0, self._n_channels, self._width), dtype=np.float32)
            return empty, overflowed, first_sample_index

        start = cursor.total_read % self._capacity
        end = start + n_samples
        if end <= self._capacity:
            block = self._buffer[start:end].copy()
        else:
            block = np.concatenate((self._buffer[start:], self._buffer[: end - self._capacity]))
        cursor.total_read += n_samples
        return block, overflowed, first_sample_index


def ring_capacity_for(
    *,
    srate: float,
    n_channels: int,
    width: int,
    seconds: float,
    max_bytes: int,
    minimum: int = 256,
) -> int:
    """How many samples of slack to stage, bounded by a memory ceiling.

    The ring only has to cover one pump interval plus jitter, so ``seconds`` is
    small by design. ``max_bytes`` is what stops a 30 kHz 256-channel stream
    from turning a modest duration into hundreds of megabytes; hitting it costs
    slack, not correctness, since running short of slack surfaces as a reported
    overflow.
    """
    by_time = int(srate * seconds) if srate > 0 else 0
    bytes_per_sample = max(1, n_channels * width * np.dtype(np.float32).itemsize)
    by_memory = max(minimum, max_bytes // bytes_per_sample)
    return int(max(minimum, min(max(by_time, minimum), by_memory)))


def envelope_pairs(block: np.ndarray, max_columns: int) -> np.ndarray:
    """Reduce ``(n, n_channels, width)`` samples to ``(n_out, n_channels, 2)``.

    The trailing pair is what makes a frame an ``RG32F`` texture upload on the
    browser side: one row per output column, one texel per channel, red and
    green holding the column's minimum and maximum.

    Decimating here rather than in the browser is the whole reason a 30 kHz
    stream fits down a websocket: the client only ever has as many columns as it
    has pixels, so the wire cost is set by the plot's width instead of by the
    sample rate.

    Min/max is the only correct reduction for this. Subsampling drops the
    extremes, which on neural data means the spikes -- the part someone opened
    the plot to look at -- vanish at exactly the zoom levels where they matter.

    NaNs propagate into the column that contains them, which draws as a gap.
    That is deliberate: a stream producing NaNs should look broken.
    """
    if block.ndim != 3:
        raise ValueError(f"expected (n, n_channels, width), got shape {block.shape}")
    n_samples, n_channels, width = block.shape
    lows = block[:, :, 0]
    highs = block[:, :, 1] if width >= 2 else lows

    if n_samples == 0:
        return np.empty((0, n_channels, 2), dtype=np.float32)
    if n_samples <= max_columns:
        # Already at or under the pixel budget: pass the samples through as
        # degenerate pairs so the renderer keeps a single code path.
        return np.stack((lows, highs), axis=-1).astype(np.float32, copy=False)

    # Bin edges from linspace are strictly increasing whenever n > max_columns,
    # which is the only branch that reaches here -- reduceat would misbehave on
    # a repeated edge, and this is what rules that out.
    edges = np.linspace(0, n_samples, max_columns + 1)[:-1].astype(np.intp)
    reduced_low = np.minimum.reduceat(lows, edges, axis=0)
    reduced_high = np.maximum.reduceat(highs, edges, axis=0)
    return np.stack((reduced_low, reduced_high), axis=-1).astype(np.float32, copy=False)


def encode_binary_frame(header: dict[str, Any], payload: np.ndarray) -> bytes:
    """``[u32 header_len][utf-8 JSON header][float32 payload]``.

    Binary rather than JSON because the payload is the bulk of the traffic and
    JSON would roughly quadruple it while forcing the browser to parse numbers
    one at a time; this way the client wraps the tail in a ``Float32Array`` with
    no per-sample work at all. The header stays JSON because it is small, it
    changes shape as modes are added, and being able to read a frame in devtools
    is worth more than the bytes.
    """
    head = json.dumps(header, separators=(",", ":"), allow_nan=False).encode("utf-8")
    body = np.ascontiguousarray(payload, dtype=WIRE_DTYPE).tobytes()
    return struct.pack(HEADER_PREFIX, len(head)) + head + body


def decode_binary_frame(frame: bytes) -> tuple[dict[str, Any], np.ndarray]:
    """Inverse of :func:`encode_binary_frame`, for tests and for debugging."""
    if len(frame) < HEADER_PREFIX_SIZE:
        raise ValueError("frame is shorter than its length prefix")
    (head_len,) = struct.unpack_from(HEADER_PREFIX, frame)
    head_end = HEADER_PREFIX_SIZE + head_len
    if len(frame) < head_end:
        raise ValueError("frame is shorter than its declared header")
    header = json.loads(frame[HEADER_PREFIX_SIZE:head_end].decode("utf-8"))
    payload = np.frombuffer(frame[head_end:], dtype=WIRE_DTYPE)
    return header, payload
