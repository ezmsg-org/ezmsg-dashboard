"""Watching what a publisher is actually sending, from the dashboard backend.

The backend already holds a live ``GraphContext``, so it can create an ezmsg
``Subscriber`` on any topic directly: in its own event loop, with no unit
injected into the graph and no edge added to the topology. That is the whole
mechanism. There is no shared-memory hop and no helper process, because the
thing that forces those on the desktop tools -- a renderer living in a process
that cannot be an ezmsg node -- does not apply when the renderer is a browser at
the other end of a socket the backend is already serving.

Two properties of ezmsg's ``Subscriber`` are what make it safe to point this at
a production graph:

* ``leaky=True`` drops notifications instead of applying backpressure, and
  releases the publisher's buffer for each one it drops (see
  ``Subscriber._handle_dropped_notification``). A wedged browser tab cannot
  stall the graph it is watching. This is the single property worth checking
  first in any "tap a live pipeline" design, and ezmsg provides it at the client
  layer.
* ``recv_zero_copy()`` yields the message itself, so nothing is pickled or
  deep-copied on the way in. We reduce inside the context manager and let go.

What leakiness costs is contiguity: a subscriber that falls behind loses whole
messages, and a sweep drawn straight from those would join two ends of a gap
into a smooth, entirely fictional trace. Hence the ring in
:mod:`..stream_frames`, written at message rate and read at frame rate, which
reports the gap instead of hiding it.

``ezmsg-tools`` supplies the AxisArray-to-plottable reduction
(``ezmsg.tools.plot.describe``). It is an optional dependency: without it the
message inspector still works on every topic -- it needs nothing but the message
-- and only the plotting modes are unavailable. Nothing else in the dashboard
imports it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import sys
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from ezmsg.util.messages.axisarray import AxisArray

from ..stream_frames import RingCursor, SampleRing, envelope_pairs, ring_capacity_for

logger = logging.getLogger("ezmsg.dashboard.stream_tap")

try:
    from ezmsg.tools.chmeta import channel_names
    from ezmsg.tools.plot.describe import (
        StreamShape,
        UnsupportedMetricError,
        describe_axisarray,
        flatten_for_plot,
    )

    PLOTTING_AVAILABLE = True
    PLOTTING_UNAVAILABLE_REASON: str | None = None
except ImportError as exc:  # pragma: no cover - exercised by the extra being absent
    StreamShape = Any  # type: ignore[assignment,misc]
    UnsupportedMetricError = NotImplementedError  # type: ignore[assignment,misc]
    channel_names = None  # type: ignore[assignment]
    describe_axisarray = None  # type: ignore[assignment]
    flatten_for_plot = None  # type: ignore[assignment]
    PLOTTING_AVAILABLE = False
    PLOTTING_UNAVAILABLE_REASON = (
        f"Plotting needs the 'viz' extra (ezmsg-tools): {exc}. "
        "Install with `pip install ezmsg-dashboard[viz]`. The message inspector works without it."
    )

#: How many messages a tap's subscriber may fall behind before ezmsg starts
#: dropping them for us. Deep enough to ride out a scheduling hiccup without
#: losing samples, shallow enough that a stalled tap does not sit on a large
#: share of the publisher's buffers.
LEAKY_MAX_QUEUE = 8

#: Seconds of slack the ring stages between the recv loop and the pump. This is
#: jitter tolerance, not display history -- the history lives in the browser.
RING_SECONDS = 2.0

#: Ceiling on one ring's footprint. A 30 kHz 256-channel stream would otherwise
#: turn RING_SECONDS into hundreds of megabytes.
RING_MAX_BYTES = 32 * 1024 * 1024

#: How many channels the browser draws at once. Not a limit on the stream: a
#: wider one is plotted too, a window at a time, and scrolled.
#:
#: There was a hard ceiling here once, which refused to plot anything wider. It
#: was put in on the assumption that the wire cost scaled with frame rate, and
#: that stopped being true when the sweep gained a time base -- a frame carries
#: only the columns that elapsed, so traffic follows columns per second and the
#: channel count multiplies a much smaller number. At a 2 s window, 2048
#: channels cost about 6 MB/s, which is not a reason to refuse a stream.
MAX_DRAWN_CHANNELS = 512

#: Cap on payload columns per frame regardless of what a client asks for.
MAX_COLUMNS = 4096

#: Seconds of signal a sweep window shows by default.
#:
#: This is what sets the decimation ratio, and it matters far more than it
#: looks. Without a time base, a frame's samples are simply spread across the
#: whole window, so a 30 kHz stream read at 30 Hz puts ~1000 samples into ~760
#: columns -- barely any decimation, a window covering 33 ms, a plot that
#: repaints entirely every frame, and tens of MB/s on the wire. Fixing the
#: window in *time* makes a column a fixed number of samples, which is what
#: makes both the picture and the bandwidth behave.
DEFAULT_WINDOW_SECONDS = 2.0
MIN_WINDOW_SECONDS = 0.05
MAX_WINDOW_SECONDS = 60.0

#: View kinds a *stream* can be, decided by the data rather than by the client.
#: Letting the client pick would mean a browser could ask for a sweep of a
#: spectrum, and the honest answer to that is not a plot.
SWEEP = "sweep"
SPECTRUM = "spectrum"
SCATTER = "scatter"
PLOT_MODES = (SWEEP, SPECTRUM, SCATTER)

#: What a *client* may ask for. ``auto`` takes whatever view the stream turns
#: out to support; ``inspect`` asks for metadata only and never opens the data
#: path at all, which is the right mode for a topic carrying something no plot
#: can draw -- and cheap enough to leave running on a busy stream.
AUTO = "auto"
INSPECT = "inspect"
CLIENT_MODES = (AUTO, INSPECT)


class StreamTapError(RuntimeError):
    """A tap could not be opened, or cannot render the stream it found."""


class StreamTapUnavailableError(StreamTapError):
    """Taps are not available at all -- no GraphContext, or no 'viz' extra."""


def _try_asarray(data: Any) -> np.ndarray | None:
    """``np.asarray`` if it produces something numeric, else None.

    A failed conversion does not always raise: numpy will happily wrap an object
    it cannot interpret in a 0-d object array, which is not something any of
    this can plot.
    """
    try:
        result = np.asarray(data)
    except Exception:  # noqa: BLE001 - any conversion failure is the same failure here
        return None
    return None if result.dtype == object else result


def _bfloat16_via_bits(data: Any) -> np.ndarray | None:
    """``bfloat16`` -> float32 by moving bits, never by running framework compute.

    ``bfloat16`` is exactly the top 16 bits of an IEEE float32, so widening it is
    a shift, not a conversion -- which is fortunate, because the obvious route is
    unsafe here.

    Asking the framework to cast (``array.astype(float32)``) runs a kernel on its
    default device, and an array that arrived over ezmsg's transport is backed by
    a buffer that device cannot address. On MLX that returns values near 2.5e38
    and NaN rather than failing: silently wrong, which for a monitoring tool is
    worse than not plotting at all. Reinterpreting the bits in numpy touches only
    memory we can already read, and was checked against a float32 copy of the
    same signal.

    Returns None if this is not a bfloat16 array, or if its bits cannot be
    reached without compute either.
    """
    if "bfloat16" not in str(getattr(data, "dtype", "")).lower():
        return None
    reinterpret = getattr(data, "view", None)
    module = sys.modules.get(type(data).__module__)
    native_uint16 = getattr(module, "uint16", None) if module is not None else None
    if not callable(reinterpret) or native_uint16 is None:
        return None
    try:
        bits = _try_asarray(reinterpret(native_uint16))
    except Exception:  # noqa: BLE001 - any failure just means this route is closed
        return None
    if bits is None or bits.dtype != np.uint16:
        return None
    # Little-endian assumption, the same one the wire format makes.
    return (bits.astype(np.uint32) << 16).view(np.float32)


def as_numpy(data: Any) -> np.ndarray:
    """A numpy view of a message's payload, whatever framework produced it.

    ezmsg does not require an ``AxisArray``'s ``data`` to be a numpy array, and
    a pipeline running on MLX -- or torch, or jax -- hands over its own array
    type. Those satisfy numpy's buffer or ``__array__`` protocol, so this is
    usually a *view* and not a conversion: on Apple silicon's unified memory,
    ``np.asarray`` of an MLX array aliases the very same buffer.

    That aliasing is worth stating plainly, because writing through the result
    would write into the publisher's array. Everything downstream of here either
    copies into the ring or copies explicitly; none of it writes in place.

    Two things need handling beyond the happy path:

    * **dtypes numpy has no equivalent for.** ``bfloat16`` is the one that
      matters: it fails the buffer protocol outright, and no dtype hint gets
      around it. See :func:`_bfloat16_via_bits`, and note in particular that the
      obvious fix -- asking the framework to cast -- silently corrupts data that
      arrived over the wire.
    * **laziness.** MLX does not evaluate until something reads the buffer, so
      this is where a publisher's pending work gets forced. It is cheap here
      because the message had to be materialised to be delivered at all.

    Deliberately does *not* fall back to running the producing framework's
    compute on the payload. That is what the bfloat16 note above is about, and
    the failure it produces is invisible.

    :raises StreamTapError: if the payload cannot be read as numeric data. The
        caller turns that into a plot error and leaves the message inspector
        working, which is the useful half for a stream nothing can draw.
    """
    if isinstance(data, np.ndarray):
        return data

    converted = _try_asarray(data)
    if converted is not None:
        return converted

    converted = _bfloat16_via_bits(data)
    if converted is not None:
        return converted

    raise StreamTapError(
        f"message data is {type(data).__module__}.{type(data).__name__} with dtype "
        f"{getattr(data, 'dtype', 'unknown')}, which cannot be read as a numpy array. "
        "The inspector still works; plotting needs a payload numpy can view."
    )


def _clean_float(value: Any) -> float | None:
    """A JSON-safe float, or None for anything non-finite.

    Sample data routinely carries NaN and inf, and the header travels as strict
    JSON. Dropping to None keeps one bad statistic from failing the whole frame.
    """
    try:
        as_float = float(value)
    except (TypeError, ValueError):
        return None
    return as_float if math.isfinite(as_float) else None


def _sample_dim(mode: str, dims: list[str]) -> str:
    """Which dimension a stream advances along, or "" if it has none.

    Empty means the whole message is one frame of per-channel values -- always
    true for scatter, and true for a bare ``ch`` stream that gets drawn as a
    sweep advancing one column per message. Those still plot, and usefully: the
    x axis becomes message arrivals instead of seconds.

    This has to be derived from the dims and not from the mode alone, because it
    is also what tells ``describe_axisarray`` which dimension is *not* channels.
    Naming an absent dimension there would fold the sample axis into the channel
    count; naming a present one wrongly would do the reverse.
    """
    if mode == SWEEP:
        return "time" if "time" in dims else ""
    if mode == SPECTRUM:
        return "freq"
    return ""


def _infer_mode(msg: AxisArray) -> str:
    """Pick a default view for a message, mirroring sigmon's dispatch.

    Deliberately the same rules the desktop tool uses, so a stream that shows up
    as a spectrum there does not show up as a sweep here.
    """
    dims = list(msg.dims)
    if "time" in dims:
        return SWEEP
    if "freq" in dims:
        return SPECTRUM
    if "ch" in dims and _channel_positions(msg) is not None:
        return SCATTER
    return SWEEP


def _channel_positions(msg: AxisArray) -> np.ndarray | None:
    """``(n_channels, 2)`` electrode positions from the ``ch`` axis, if present.

    Only returns positions that are not all-zero: a structured ``ch`` axis often
    carries x/y fields left at their defaults, and drawing every channel on top
    of the origin is worse than offering no map at all.
    """
    if "ch" not in msg.dims:
        return None
    try:
        ch_axis = msg.get_axis("ch")
    except (KeyError, ValueError):
        return None
    ch_data = getattr(ch_axis, "data", None)
    if ch_data is None or getattr(ch_data, "dtype", None) is None or ch_data.dtype.names is None:
        return None
    if "x" not in ch_data.dtype.names or "y" not in ch_data.dtype.names:
        return None
    x = np.asarray(ch_data["x"], dtype=np.float32)
    y = np.asarray(ch_data["y"], dtype=np.float32)
    if not (np.any(x != 0) or np.any(y != 0)):
        return None
    return np.column_stack((x, y))


def _axis_entry_labels(axis: Any, size: int) -> list[str] | None:
    """One name per entry of a coordinate axis, or None if it has no names.

    Handles the two shapes an axis's ``data`` actually takes: a structured array
    with a ``label`` field (the ``ch`` convention), and a plain array of strings
    (how a small ``feat``-style axis usually spells itself).
    """
    data = getattr(axis, "data", None)
    if data is None:
        return None
    values = np.asarray(data)
    if values.shape[:1] != (size,):
        return None
    if values.dtype.names:
        return list(channel_names(values, size))
    if values.dtype.kind in "US":
        return [str(value) for value in values]
    return None


def _channel_axes(
    msg: AxisArray,
    dims: list[str],
    shape: tuple[int, ...],
    sample_dim: str,
    metric_dim: str | None,
) -> list[dict[str, Any]]:
    """The dimensions that get folded together into "channels", in fold order.

    ``flatten_for_plot`` reshapes everything that is neither the sample axis nor
    the metric tuple into one channel axis, and ``np.moveaxis`` preserves the
    relative order of what it does not move -- so this list, in ``dims`` order,
    *is* the order the flattening uses. Reporting it is what lets the browser
    label a flattened channel correctly instead of guessing.

    Guessing is the status quo and it is wrong in two different ways. For a
    ``(time, ch, feat)`` stream, flat channel 1 is ``(ch0, feat1)`` but takes the
    name of ``ch1`` -- a different electrode, silently. For ``(time, feat, ch)``
    the first block is right and everything after it gets an invented ``chN``.
    """
    axes: list[dict[str, Any]] = []
    for dim, size in zip(dims, shape):
        if dim == sample_dim or dim == metric_dim:
            continue
        axis = msg.axes.get(dim)
        axes.append(
            {
                "name": dim,
                "size": int(size),
                "labels": _axis_entry_labels(axis, int(size)) if axis is not None else None,
            }
        )
    return axes


def _composite_channel_labels(channel_axes: list[dict[str, Any]]) -> list[str] | None:
    """One name per *flattened* channel, e.g. ``sbp/E12``.

    Correct by construction: it walks the same axis order the reshape does, so a
    name cannot drift from the trace it belongs to.
    """
    if not channel_axes:
        return None
    if not any(axis["labels"] for axis in channel_axes):
        return None

    def entry(axis: dict[str, Any], index: int) -> str:
        labels = axis["labels"]
        if labels and index < len(labels):
            return labels[index]
        # Unlabelled axes still need to say which one they are, or a composite
        # name reads as though the index belonged to the labelled axis.
        return f"{axis['name']}{index}"

    names = [""]
    for axis in channel_axes:
        names = [
            f"{prefix}/{entry(axis, index)}" if prefix else entry(axis, index)
            for prefix in names
            for index in range(axis["size"])
        ]
    return names


def _axes_identity(msg: AxisArray) -> tuple[tuple[str, int], ...]:
    """Cheap fingerprint of a message's axis objects.

    A processor that leaves an axis alone passes the same object through, so in
    the steady state this is a handful of pointer reads per message. It is a
    *trigger*, not a decision: a change here only causes a re-describe, and the
    resulting description is then compared by value before anything is rebuilt.
    That is what keeps an id() collision from mattering.
    """
    return tuple(sorted((name, id(axis)) for name, axis in msg.axes.items()))


@dataclass
class _Description:
    """Everything the browser needs to set up a plot for a stream.

    Compared by value to decide whether the ring and the client's plot have to
    be rebuilt, so every field here is one whose change invalidates them.
    """

    mode: str
    #: Views this stream can be drawn as. The first is the default; the browser
    #: may pick another without re-subscribing, because every view here is a
    #: reading of the same frames.
    available_modes: list[str]
    n_channels: int
    width: int
    srate: float
    dims: list[str]
    sample_dim: str
    dtype: str
    channel_labels: list[str] | None
    unit: str | None
    metric_kind: str | None
    key: str | None
    complex_magnitude: bool
    channel_positions: list[list[float]] | None
    freq_gain: float | None
    n_bins: int | None
    channel_axes: list[dict[str, Any]]

    def to_payload(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "available_modes": self.available_modes,
            "n_channels": self.n_channels,
            "width": self.width,
            "srate": _clean_float(self.srate) or 0.0,
            "dims": self.dims,
            "sample_dim": self.sample_dim,
            "dtype": self.dtype,
            "channel_labels": self.channel_labels,
            "unit": self.unit,
            "metric_kind": self.metric_kind,
            "key": self.key,
            "complex_magnitude": self.complex_magnitude,
            "channel_positions": self.channel_positions,
            "channel_axes": self.channel_axes,
            "freq_gain": _clean_float(self.freq_gain),
            "n_bins": self.n_bins,
        }


@dataclass
class _InspectState:
    """What the message inspector reports, for any message type at all.

    Kept separate from :class:`_Description` because it must survive messages
    that no plot can draw -- a plain dataclass, a dict, a list of strings. Being
    able to say "this topic is carrying a `Foo` at 12 Hz" for *anything* in the
    graph is most of the value of the feature.
    """

    type_name: str = ""
    module: str = ""
    is_axisarray: bool = False
    dims: list[str] | None = None
    shape: list[int] | None = None
    dtype: str | None = None
    key: str | None = None
    axes: dict[str, dict[str, Any]] | None = None
    attrs: dict[str, str] | None = None
    repr_preview: str | None = None
    plottable: bool = False
    plot_error: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "type_name": self.type_name,
            "module": self.module,
            "is_axisarray": self.is_axisarray,
            "dims": self.dims,
            "shape": self.shape,
            "dtype": self.dtype,
            "key": self.key,
            "axes": self.axes,
            "attrs": self.attrs,
            "repr_preview": self.repr_preview,
            "plottable": self.plottable,
            "plot_error": self.plot_error,
        }


def _describe_axis(axis: Any) -> dict[str, Any]:
    """One axis rendered for the inspector, without putting arrays on the wire."""
    data = getattr(axis, "data", None)
    if data is not None:
        as_array = np.asarray(data)
        fields = list(as_array.dtype.names) if as_array.dtype.names else None
        return {
            "kind": "coord",
            "unit": str(getattr(axis, "unit", "") or ""),
            "length": int(as_array.shape[0]) if as_array.ndim else 0,
            "fields": fields,
        }
    return {
        "kind": "linear",
        "unit": str(getattr(axis, "unit", "") or ""),
        "gain": _clean_float(getattr(axis, "gain", None)),
        "offset": _clean_float(getattr(axis, "offset", None)),
    }


def _preview(value: Any, limit: int = 160) -> str:
    """A short, always-safe rendering of an arbitrary value.

    ``repr`` on a user object can raise or return something enormous; the
    inspector must not be the reason a tap dies, so both are contained here.
    """
    try:
        text = repr(value)
    except Exception as exc:  # noqa: BLE001 - a broken __repr__ is the caller's, not ours
        return f"<unreprable {type(value).__name__}: {exc}>"
    return text if len(text) <= limit else text[: limit - 1] + "…"


class StreamTap:
    """One subscriber on one topic, shared by every client watching it.

    Sharing matters more than it looks: each extra ``Subscriber`` on a topic is
    another consumer the publisher has to serve and another set of buffers it
    has to hold, so opening one per browser tab would make the dashboard's cost
    to the graph scale with how many people are looking at it.
    """

    def __init__(
        self,
        topic: str,
        subscriber_factory: Callable[..., Any],
        *,
        subscriber_release: Callable[[Any], None] | None = None,
        ring_seconds: float = RING_SECONDS,
        ring_max_bytes: int = RING_MAX_BYTES,
    ) -> None:
        self._topic = topic
        self._subscriber_factory = subscriber_factory
        self._subscriber_release = subscriber_release
        self._ring_seconds = ring_seconds
        self._ring_max_bytes = ring_max_bytes

        self._subscriber: Any = None
        self._task: asyncio.Task[None] | None = None
        self._ref_count = 0

        self._status = "connecting"
        self._status_detail: str | None = None

        self._axes_identity: tuple[tuple[str, int], ...] | None = None
        self._shape_signature: tuple[Any, ...] | None = None
        self._description: _Description | None = None
        self._description_generation = 0
        self._inspect = _InspectState()

        self._ring: SampleRing | None = None
        self._latest: np.ndarray | None = None
        self._latest_generation = 0
        self._flatten_shape: _FlattenShape | None = None

        self._message_count = 0
        self._first_message_monotonic: float | None = None
        self._last_message_monotonic: float | None = None
        self._rate_window: list[float] = []

    # -- lifecycle ---------------------------------------------------------

    @property
    def topic(self) -> str:
        return self._topic

    @property
    def ref_count(self) -> int:
        return self._ref_count

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name=f"dashboard-tap:{self._topic}")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self._close_subscriber()

    async def _close_subscriber(self) -> None:
        subscriber, self._subscriber = self._subscriber, None
        if subscriber is None:
            return
        subscriber.close()
        with contextlib.suppress(Exception):
            await subscriber.wait_closed()
        if self._subscriber_release is not None:
            # GraphContext keeps every client it creates in a set it only clears
            # on session teardown, with no removal API. Taps open and close for
            # the life of the dashboard, so without this the set grows by one
            # dead subscriber per closed panel.
            self._subscriber_release(subscriber)

    def acquire(self) -> None:
        self._ref_count += 1

    def release(self) -> None:
        self._ref_count = max(0, self._ref_count - 1)

    # -- receive path ------------------------------------------------------

    async def _run(self) -> None:
        try:
            self._subscriber = await self._subscriber_factory(
                self._topic,
                leaky=True,
                max_queue=LEAKY_MAX_QUEUE,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surfaced to the client as status
            self._set_status("error", f"could not subscribe to '{self._topic}': {exc}")
            return

        self._set_status("waiting", None)
        try:
            while True:
                async with self._subscriber.recv_zero_copy() as msg:
                    self._ingest(msg)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surfaced to the client as status
            logger.exception("stream tap on %r stopped", self._topic)
            self._set_status("error", f"tap stopped: {exc}")

    def _set_status(self, status: str, detail: str | None) -> None:
        self._status = status
        self._status_detail = detail

    def _ingest(self, msg: Any) -> None:
        """Absorb one message. Runs inside ``recv_zero_copy``, so keep it short.

        Every failure here is contained: a message we cannot make sense of turns
        into an inspector entry and a status, never into a dead tap. A tap that
        dies on one odd message would be useless for the case it is most needed
        in, which is a pipeline that has started emitting something unexpected.
        """
        now = time.monotonic()
        self._message_count += 1
        if self._first_message_monotonic is None:
            self._first_message_monotonic = now
        self._last_message_monotonic = now
        self._rate_window.append(now)
        if len(self._rate_window) > 64:
            del self._rate_window[:-64]

        try:
            self._observe(msg)
        except Exception as exc:  # noqa: BLE001 - never let a plot problem kill the tap
            self._inspect.plottable = False
            self._inspect.plot_error = str(exc)
            self._ring = None
            self._latest = None
            self._description = None
            self._set_status("live", None)
            return

        self._set_status("live", None)

    def _observe(self, msg: Any) -> None:
        if not isinstance(msg, AxisArray):
            self._observe_foreign(msg)
            return

        identity = _axes_identity(msg)
        signature = self._signature(msg)
        if identity != self._axes_identity or signature != self._shape_signature:
            self._axes_identity = identity
            self._shape_signature = signature
            self._redescribe(msg)

        if self._description is None:
            return
        self._store(msg, self._description)

    def _signature(self, msg: AxisArray) -> tuple[Any, ...]:
        """Shape fingerprint with the sample axis masked out.

        The sample axis is the one dimension that legitimately differs from
        message to message, so including its length would re-describe the stream
        on every message and defeat the point of the check.
        """
        dims = list(msg.dims)
        # Deliberately not routed through _infer_mode: that inspects the `ch`
        # axis data to choose scatter, which is real per-message work, and the
        # only thing needed here is the name of the dimension whose length is
        # allowed to vary.
        sample_dim = "time" if "time" in dims else ("freq" if "freq" in dims else "")
        shape = tuple(-1 if dim == sample_dim else int(size) for dim, size in zip(dims, msg.data.shape))
        # `str(dtype)` rather than numpy's `dtype.str`: the payload is not
        # necessarily a numpy array, and a foreign dtype object has no `.str`.
        # All this needs is a token that changes when the dtype does.
        return (tuple(dims), shape, str(msg.data.dtype), getattr(msg, "key", None))

    def _observe_foreign(self, msg: Any) -> None:
        """Record a non-AxisArray message for the inspector and stop there."""
        self._inspect = _InspectState(
            type_name=type(msg).__name__,
            module=type(msg).__module__,
            is_axisarray=False,
            repr_preview=_preview(msg),
            plottable=False,
            plot_error=f"{type(msg).__name__} is not an AxisArray; only the inspector can show it.",
        )
        self._description = None
        self._ring = None
        self._latest = None

    def _redescribe(self, msg: AxisArray) -> None:
        """Rebuild what we know about the stream, and the ring if it changed."""
        dims = list(msg.dims)
        attrs = getattr(msg, "attrs", None) or {}
        inspect_state = _InspectState(
            type_name=type(msg).__name__,
            module=type(msg).__module__,
            is_axisarray=True,
            dims=dims,
            shape=[int(size) for size in msg.data.shape],
            dtype=str(msg.data.dtype),
            key=str(getattr(msg, "key", "") or "") or None,
            axes={name: _describe_axis(axis) for name, axis in msg.axes.items()},
            attrs={str(name): _preview(value, 80) for name, value in attrs.items()},
            repr_preview=None,
        )

        if not PLOTTING_AVAILABLE:
            inspect_state.plottable = False
            inspect_state.plot_error = PLOTTING_UNAVAILABLE_REASON
            self._inspect = inspect_state
            self._description = None
            self._ring = None
            self._latest = None
            return

        try:
            description = self._build_description(msg, dims)
        except StreamTapError as exc:
            inspect_state.plottable = False
            inspect_state.plot_error = str(exc)
            self._inspect = inspect_state
            self._description = None
            self._ring = None
            self._latest = None
            return

        inspect_state.plottable = True
        inspect_state.plot_error = None
        self._inspect = inspect_state

        if description != self._description:
            self._description = description
            self._description_generation += 1
            self._rebuild_stores(description)

    def _build_description(self, msg: AxisArray, dims: list[str]) -> _Description:
        # Raises StreamTapError for a payload numpy cannot view, which the
        # caller reports as a plot error with the inspector left intact.
        data = as_numpy(msg.data)
        mode = _infer_mode(msg)
        sample_dim = _sample_dim(mode, dims)
        # `time_axis` names the dimension that is *not* channels, so it has to
        # track the mode. Left at its "time" default a spectrum would fold its
        # frequency bins into the channel count -- a 1024-bin 32-channel stream
        # describing itself as 32768 channels, which then trips the channel
        # ceiling rather than plotting.
        shape: StreamShape = describe_axisarray(msg, time_axis=sample_dim)
        width = len(shape.metric.labels) if shape.metric is not None else 1
        metric_kind = shape.metric.kind if shape.metric is not None else None

        if mode == SWEEP and shape.metric is not None and metric_kind != "minmax":
            # describe_axisarray recognises dispersion pairs like (mean, std),
            # which are the same shape as an envelope and must not be drawn as
            # one. Say what arrived instead of drawing something plausible.
            raise StreamTapError(
                f"stream carries a {metric_kind!r} metric axis, which the sweep view "
                "cannot draw yet (only (min, max) envelopes are supported)."
            )
        channel_axes = _channel_axes(
            msg,
            dims,
            tuple(int(size) for size in data.shape),
            sample_dim,
            shape.metric.axis if shape.metric is not None else None,
        )
        # Composite names win over the single-axis ones from `describe_axisarray`
        # whenever more than one dimension was folded into "channels": those are
        # per-axis-entry, so on a folded stream they run out and, worse, can land
        # on the wrong trace.
        composite_labels = _composite_channel_labels(channel_axes)
        channel_labels = composite_labels or (list(shape.channel_labels) if shape.channel_labels else None)

        # Computed regardless of the inferred mode: a (time, ch) stream with real
        # electrode positions can be drawn as a map *as well as* a sweep, and the
        # browser decides which. Positions are static per description, so this
        # costs one extraction per shape change either way.
        positions = _channel_positions(msg)

        # A map needs one position per drawn channel. That holds for an ordinary
        # (time, ch) stream, and for a folded one only once an axis is pinned --
        # which is a browser-side choice, so it offers the view and the browser
        # decides whether the current selection can use it.
        scatter_possible = positions is not None and len(positions) == int(shape.n_channels)
        available_modes = [SPECTRUM] if mode == SPECTRUM else [SWEEP]
        if scatter_possible:
            available_modes.append(SCATTER)
        if mode == SCATTER:
            # Inferred as a map, but it plots as a sweep too, one column per
            # message -- useful for watching a single channel's value move.
            available_modes = [SCATTER, SWEEP]

        freq_gain: float | None = None
        n_bins: int | None = None
        if mode == SPECTRUM:
            n_bins = int(data.shape[dims.index("freq")])
            with contextlib.suppress(Exception):
                freq_gain = float(msg.get_axis("freq").gain)

        # `shape.srate` is derived from the gain of whichever axis was named
        # `time_axis`, so it only means samples-per-second in sweep mode. For a
        # spectrum that same number is bins-per-Hz inverted, which is what
        # `freq_gain` carries properly; reporting it as a sample rate would put
        # a wrong time axis under the plot.
        srate = float(shape.srate) if mode == SWEEP else 0.0

        return _Description(
            mode=mode,
            available_modes=available_modes,
            n_channels=int(shape.n_channels),
            width=int(width),
            srate=srate,
            dims=dims,
            sample_dim=sample_dim,
            dtype=str(msg.data.dtype),
            channel_labels=channel_labels,
            unit=shape.unit,
            metric_kind=metric_kind,
            key=str(getattr(msg, "key", "") or "") or None,
            complex_magnitude=bool(np.iscomplexobj(data)),
            channel_positions=positions.tolist() if positions is not None else None,
            freq_gain=freq_gain,
            n_bins=n_bins,
            channel_axes=channel_axes,
        )

    def _rebuild_stores(self, description: _Description) -> None:
        """Point the tap at fresh storage for a stream whose shape just changed."""
        self._latest = None
        self._latest_generation += 1
        self._flatten_shape = _FlattenShape(
            n_channels=description.n_channels,
            metric=_FlattenMetric(labels=("min", "max")) if description.width == 2 else None,
        )
        if description.mode != SWEEP:
            # Spectrum and scatter replace their whole frame each message, so a
            # ring would only ever hold data the next message invalidates.
            self._ring = None
            return
        capacity = ring_capacity_for(
            srate=description.srate,
            n_channels=description.n_channels,
            width=description.width,
            seconds=self._ring_seconds,
            max_bytes=self._ring_max_bytes,
        )
        self._ring = SampleRing(capacity, description.n_channels, description.width)

    def _store(self, msg: AxisArray, description: _Description) -> None:
        data = as_numpy(msg.data)
        if description.complex_magnitude:
            # A spectrum is routinely complex. Magnitude is the only reduction
            # that means anything on a plot without also asking about phase.
            data = np.abs(data)

        if description.sample_dim:
            sample_index = description.dims.index(description.sample_dim)
            if sample_index != 0:
                data = np.moveaxis(data, sample_index, 0)
        else:
            # No sample axis: the whole message is one frame. The leading
            # singleton is what lets it share the reduction below, and for a
            # sweep it is what makes each message advance the plot by one
            # column.
            data = data.reshape((1, *data.shape))

        block = flatten_for_plot(data, self._plot_shape(description))
        if block.ndim == 2:
            block = block[:, :, np.newaxis]
        block = block.astype(np.float32, copy=False)

        if description.mode == SWEEP:
            if self._ring is not None:
                # Copies into the ring, so nothing here outlives the message.
                self._ring.write(block)
            return

        # Spectrum keeps the whole frame as (n_bins, n_channels); scatter keeps
        # the most recent sample, which is what a map of "right now" means.
        #
        # The copy is load-bearing. Everything above -- asarray, moveaxis,
        # reshape, flatten_for_plot, the float32 cast -- can hand back a *view*
        # of msg.data, and msg.data is the publisher's shared-memory buffer,
        # borrowed only for the duration of recv_zero_copy. Storing a view would
        # leave the plot reading a buffer the publisher is free to overwrite,
        # and would pin the segment open past the lease.
        frame = block[:, :, 0]
        self._latest = np.array(frame if description.mode == SPECTRUM else frame[-1:], dtype=np.float32)
        self._latest_generation += 1

    def _plot_shape(self, description: _Description) -> Any:
        """The ``StreamShape`` stand-in ``flatten_for_plot`` reads.

        Rebuilt only when the description changes -- ``_rebuild_stores`` is the
        one place that happens -- because building a real ``StreamShape`` per
        message would re-run channel-label extraction in the hot path for a
        reduction that never looks at the labels.
        """
        return self._flatten_shape

    # -- read path ---------------------------------------------------------

    def snapshot_rate_hz(self) -> float | None:
        """Message rate over the recent window, or None before it means anything."""
        if len(self._rate_window) < 2:
            return None
        span = self._rate_window[-1] - self._rate_window[0]
        if span <= 0:
            return None
        return (len(self._rate_window) - 1) / span

    def status_payload(self) -> dict[str, Any]:
        last_seen = None
        if self._last_message_monotonic is not None:
            last_seen = max(0.0, time.monotonic() - self._last_message_monotonic)
        return {
            "topic": self._topic,
            "status": self._status,
            "detail": self._status_detail,
            "message_count": self._message_count,
            "rate_hz": _clean_float(self.snapshot_rate_hz()),
            "seconds_since_last_message": _clean_float(last_seen),
            "watchers": self._ref_count,
        }

    def inspect_payload(self) -> dict[str, Any]:
        return self._inspect.to_payload()

    @property
    def description(self) -> _Description | None:
        return self._description

    @property
    def description_generation(self) -> int:
        return self._description_generation

    def pending_samples(self, cursor: RingCursor) -> int:
        """How many samples this cursor has not read yet.

        Lets a client decide whether a read is worth making before it makes one,
        which is what keeps the frame rate from dictating the time base.
        """
        ring = self._ring
        if ring is None:
            return 0
        return max(0, ring.total_written - cursor.total_read)

    def read_sweep(self, cursor: RingCursor, target_columns: int) -> tuple[np.ndarray, bool, int, int] | None:
        """``(pairs, overflowed, first_sample_index, n_samples)`` or None if idle.

        ``target_columns`` is how many columns *this block* should occupy, which
        the caller derives from the window's time base -- not the width of the
        plot. Passing the plot width here instead would make every frame fill
        the whole window regardless of how much time it covered.
        """
        ring = self._ring
        if ring is None:
            return None
        block, overflowed, first_sample_index = ring.read(cursor)
        if block.shape[0] == 0 and not overflowed:
            return None
        pairs = envelope_pairs(block, max(1, target_columns))
        return pairs, overflowed, first_sample_index, int(block.shape[0])

    def read_latest(self, seen_generation: int) -> tuple[np.ndarray, int] | None:
        """The most recent spectrum/scatter frame, if it is newer than ``seen``."""
        if self._latest is None or self._latest_generation == seen_generation:
            return None
        return self._latest, self._latest_generation

    def reset_cursor(self, cursor: RingCursor) -> None:
        """Point a cursor at the newest sample, discarding the backlog.

        Used when a client first attaches or after a shape change: the samples
        already in the ring belong to the previous plot, and prepending them to
        a freshly-configured one would draw the old stream's tail on the new
        stream's axes.
        """
        cursor.total_read = self._ring.total_written if self._ring is not None else 0


@dataclass
class _FlattenMetric:
    labels: tuple[str, ...]


@dataclass
class _FlattenShape:
    """Duck-typed stand-in for the two fields ``flatten_for_plot`` consults."""

    n_channels: int
    metric: _FlattenMetric | None


@dataclass
class StreamTapClient:
    """One websocket's view of a tap: what it wants, and where it has read to."""

    tap: StreamTap
    mode: str
    max_columns: int
    window_seconds: float = DEFAULT_WINDOW_SECONDS
    cursor: RingCursor = field(default_factory=RingCursor)
    seen_description_generation: int = -1
    seen_latest_generation: int = -1
    #: Fractional column carried between frames. Rounding each frame's column
    #: count independently would let the time base drift against the sample
    #: clock, slowly and invisibly.
    column_remainder: float = 0.0

    @property
    def topic(self) -> str:
        return self.tap.topic

    def set_max_columns(self, max_columns: int) -> None:
        self.max_columns = max(1, min(MAX_COLUMNS, int(max_columns)))

    def set_window_seconds(self, window_seconds: float) -> None:
        self.window_seconds = max(MIN_WINDOW_SECONDS, min(MAX_WINDOW_SECONDS, float(window_seconds)))

    def effective_columns(self, srate: float) -> int:
        """How many columns the requested window is actually worth.

        The plot's pixel budget is a *ceiling*, not a target. A slow stream
        cannot fill it: two seconds of a 100 Hz signal is 200 samples, and a
        column can never stand for less than one sample.

        Spreading those 200 samples across a 2000-column plot is what the
        earlier version did, and it silently showed twenty seconds while the
        caption said two -- with the window control apparently dead, because
        every window short enough to matter produced the same one-sample column.
        Shrinking the column count instead keeps the window honest; the plot
        simply draws fewer, wider columns, which is all the data there is.
        """
        if srate <= 0:
            # No sample rate: the stream advances one column per message and
            # seconds do not enter into it.
            return self.max_columns
        return max(2, min(self.max_columns, math.ceil(srate * self.window_seconds)))

    def samples_per_column(self, srate: float) -> float:
        """How many source samples one output column stands for.

        A stream with no sample rate advances one column per message, so there
        is nothing to average and this is 1.
        """
        if srate <= 0:
            return 1.0
        return max(1.0, (srate * self.window_seconds) / self.effective_columns(srate))

    def shown_seconds(self, srate: float) -> float | None:
        """How much time the plot will *actually* span.

        Usually the requested window, but not always: a very slow stream runs
        into the two-column floor, and half a sample of a 1 Hz signal is not
        something anything can draw. The client captions from this rather than
        from the request, so the axis never claims a span the data does not have.
        """
        if srate <= 0:
            return None
        return (self.effective_columns(srate) * self.samples_per_column(srate)) / srate

    def take_description(self) -> dict[str, Any] | None:
        """The stream description, but only once per change."""
        description = self.tap.description
        generation = self.tap.description_generation
        if description is None or generation == self.seen_description_generation:
            return None
        self.seen_description_generation = generation
        self.tap.reset_cursor(self.cursor)
        self.seen_latest_generation = -1
        payload = description.to_payload()
        payload["generation"] = generation
        return payload

    def take_frame(self) -> tuple[dict[str, Any], np.ndarray] | None:
        """The next data frame for this client, or None if there is nothing new.

        Returns the header and payload rather than sending them, so the framing
        and the mode dispatch can be tested without a websocket on either end.

        Callers must consume :meth:`take_description` first: the header refers
        to a description generation, and a frame that arrives before the
        description it belongs to would be drawn on the previous stream's axes.
        """
        if self.mode == INSPECT:
            return None
        description = self.tap.description
        if description is None:
            return None

        if description.mode == SWEEP:
            window_columns = self.effective_columns(description.srate)
            per_column = self.samples_per_column(description.srate)
            pending = self.tap.pending_samples(self.cursor) + self.column_remainder
            target = int(pending // per_column)
            if target <= 0:
                # Not enough new samples to fill a column yet. Returning early
                # keeps a fast frame rate from emitting sub-column frames, which
                # would put more columns on the plot than the time base allows.
                return None
            target = min(target, window_columns)
            result = self.tap.read_sweep(self.cursor, target)
            if result is None:
                self.column_remainder = 0.0
                return None
            pairs, overflowed, first_sample_index, n_samples = result
            # Carry the leftover so the column clock does not drift against the
            # sample clock over a long session.
            self.column_remainder = (
                0.0 if overflowed else max(0.0, n_samples + self.column_remainder - pairs.shape[0] * per_column)
            )
            srate = description.srate
            header = {
                "kind": "stream.data",
                "mode": SWEEP,
                "generation": self.seen_description_generation,
                # Payload is (n_out, n_channels, components): one row per
                # column, one texel per channel, which the browser uploads
                # straight into an RG32F texture.
                "n_out": int(pairs.shape[0]),
                "n_channels": int(pairs.shape[1]),
                # Min/max pairs, always -- see envelope_pairs. The renderer
                # never has to branch on whether decimation happened.
                "components": 2,
                # How wide the browser's ring must be for the window to mean
                # what the caption says. Sent per frame rather than with the
                # description because it moves with the window control, which
                # does not change the stream's shape.
                "columns": window_columns,
                # What is actually spanned, not what was asked for.
                "window_seconds": self.shown_seconds(description.srate),
                "samples_per_column": per_column,
                "n_samples": n_samples,
                "first_sample_index": first_sample_index,
                "t_start": (first_sample_index / srate) if srate > 0 else None,
                "t_end": ((first_sample_index + n_samples) / srate) if srate > 0 else None,
                "overflow": overflowed,
            }
            return header, pairs

        latest = self.tap.read_latest(self.seen_latest_generation)
        if latest is None:
            return None
        frame, generation = latest
        self.seen_latest_generation = generation
        header = {
            "kind": "stream.data",
            "mode": description.mode,
            "generation": self.seen_description_generation,
            "n_out": int(frame.shape[0]),
            "n_channels": int(frame.shape[1]),
            "components": 1,
            "overflow": False,
        }
        return header, frame


class StreamTapManager:
    """Refcounted registry of live taps, one per topic."""

    def __init__(
        self,
        subscriber_factory: Callable[..., Any],
        *,
        subscriber_release: Callable[[Any], None] | None = None,
    ) -> None:
        self._subscriber_factory = subscriber_factory
        self._subscriber_release = subscriber_release
        self._taps: dict[str, StreamTap] = {}
        self._lock = asyncio.Lock()

    @property
    def active_topics(self) -> list[str]:
        return sorted(self._taps)

    async def shutdown(self) -> None:
        async with self._lock:
            taps, self._taps = list(self._taps.values()), {}
        for tap in taps:
            await tap.stop()

    @contextlib.asynccontextmanager
    async def client(
        self,
        topic: str,
        *,
        mode: str,
        max_columns: int,
        window_seconds: float = DEFAULT_WINDOW_SECONDS,
    ) -> AsyncIterator[StreamTapClient]:
        if mode not in CLIENT_MODES:
            raise StreamTapError(f"unknown stream mode {mode!r}; expected one of {', '.join(CLIENT_MODES)}")
        if not topic:
            raise StreamTapError("a stream tap needs a topic")
        async with self._lock:
            tap = self._taps.get(topic)
            if tap is None:
                tap = StreamTap(topic, self._subscriber_factory, subscriber_release=self._subscriber_release)
                self._taps[topic] = tap
                await tap.start()
            tap.acquire()

        client = StreamTapClient(
            tap=tap,
            mode=mode,
            max_columns=max(1, min(MAX_COLUMNS, max_columns)),
        )
        client.set_window_seconds(window_seconds)
        try:
            yield client
        finally:
            async with self._lock:
                tap.release()
                if tap.ref_count == 0 and self._taps.get(topic) is tap:
                    del self._taps[topic]
                    stopping = tap
                else:
                    stopping = None
            if stopping is not None:
                await stopping.stop()


def availability_payload() -> dict[str, Any]:
    """Whether plotting modes can run here, for the frontend to gate its UI on."""
    return {
        "inspector": True,
        "plotting": PLOTTING_AVAILABLE,
        "reason": PLOTTING_UNAVAILABLE_REASON,
        "max_drawn_channels": MAX_DRAWN_CHANNELS,
        "max_columns": MAX_COLUMNS,
    }
