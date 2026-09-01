"""A small graph to point the dashboard's stream viewer at.

Publishes four streams that between them exercise every view the tap can build:
a labelled multichannel timeseries (sweep), a spectrum, a channel map with
electrode positions (scatter), and a plain dataclass that no plot can draw
(message inspector). Run it, then open the dashboard and click a publisher.

    ezmsg serve                             # in one terminal
    python examples/stream_demo_graph.py    # in another
    ezmsg dashboard                         # in a third
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from dataclasses import dataclass

import ezmsg.core as ez
import numpy as np
from ezmsg.util.messages.axisarray import AxisArray


class SignalGeneratorSettings(ez.Settings):
    fs: float = 1000.0
    n_channels: int = 8
    chunk_samples: int = 100
    frequency_hz: float = 7.0


class SignalGenerator(ez.Unit):
    """A labelled multichannel sine, one harmonic per channel.

    Its ``ch`` axis carries real x/y positions, so the viewer offers the channel
    map as an alternative view of the same stream -- the common case for
    ``(time, ch)`` data from an electrode array.
    """

    SETTINGS = SignalGeneratorSettings

    OUTPUT = ez.OutputStream(AxisArray)

    @ez.publisher(OUTPUT)
    async def generate(self) -> AsyncGenerator:
        settings = self.SETTINGS
        channel_axis = np.zeros(settings.n_channels, dtype=[("label", "U8"), ("x", "f4"), ("y", "f4")])
        channel_axis["label"] = [f"ch{index:02d}" for index in range(settings.n_channels)]
        # A 4x2 grid, so the sweep stream can also be drawn as a channel map.
        channel_axis["x"] = np.tile(np.arange(4, dtype=np.float32), 2)[: settings.n_channels]
        channel_axis["y"] = np.repeat(np.arange(2, dtype=np.float32), 4)[: settings.n_channels]
        harmonics = np.arange(1, settings.n_channels + 1, dtype=np.float32)

        sample_index = 0
        while True:
            times = (np.arange(settings.chunk_samples) + sample_index) / settings.fs
            data = np.sin(2 * np.pi * settings.frequency_hz * times[:, None] * harmonics[None, :])
            yield (
                self.OUTPUT,
                AxisArray(
                    data.astype(np.float32),
                    dims=["time", "ch"],
                    axes={
                        "time": AxisArray.TimeAxis(fs=settings.fs, offset=sample_index / settings.fs),
                        "ch": AxisArray.CoordinateAxis(data=channel_axis, dims=["ch"]),
                    },
                    attrs={"unit": "uV"},
                    key="demo_signal",
                ),
            )
            sample_index += settings.chunk_samples
            await asyncio.sleep(settings.chunk_samples / settings.fs)


class SpectrumGeneratorSettings(ez.Settings):
    n_bins: int = 128
    n_channels: int = 4
    bin_hz: float = 2.0
    rate_hz: float = 10.0


class SpectrumGenerator(ez.Unit):
    SETTINGS = SpectrumGeneratorSettings

    OUTPUT = ez.OutputStream(AxisArray)

    @ez.publisher(OUTPUT)
    async def generate(self) -> AsyncGenerator:
        settings = self.SETTINGS
        bins = np.arange(settings.n_bins, dtype=np.float32)
        step = 0
        while True:
            centre = 20.0 + 10.0 * np.sin(step / 10.0)
            envelope = np.exp(-(((bins - centre) / 8.0) ** 2))
            data = envelope[:, None] * np.linspace(1.0, 2.0, settings.n_channels)[None, :]
            yield (
                self.OUTPUT,
                AxisArray(
                    data.astype(np.float32),
                    dims=["freq", "ch"],
                    axes={"freq": AxisArray.LinearAxis(gain=settings.bin_hz, offset=0.0, unit="Hz")},
                    key="demo_spectrum",
                ),
            )
            step += 1
            await asyncio.sleep(1.0 / settings.rate_hz)


class ChannelMapGeneratorSettings(ez.Settings):
    grid: int = 6
    rate_hz: float = 20.0


class ChannelMapGenerator(ez.Unit):
    """Per-channel values on a grid of electrode positions -- the scatter view."""

    SETTINGS = ChannelMapGeneratorSettings

    OUTPUT = ez.OutputStream(AxisArray)

    @ez.publisher(OUTPUT)
    async def generate(self) -> AsyncGenerator:
        settings = self.SETTINGS
        n_channels = settings.grid * settings.grid
        xs, ys = np.meshgrid(np.arange(settings.grid), np.arange(settings.grid))
        channel_axis = np.zeros(n_channels, dtype=[("label", "U8"), ("x", "f4"), ("y", "f4")])
        channel_axis["label"] = [f"e{index:02d}" for index in range(n_channels)]
        channel_axis["x"] = xs.ravel().astype(np.float32)
        channel_axis["y"] = ys.ravel().astype(np.float32)

        step = 0
        while True:
            phase = step / 10.0
            values = np.sin(phase + channel_axis["x"] * 0.6) * np.cos(phase + channel_axis["y"] * 0.6)
            yield (
                self.OUTPUT,
                AxisArray(
                    values.astype(np.float32),
                    dims=["ch"],
                    axes={"ch": AxisArray.CoordinateAxis(data=channel_axis, dims=["ch"])},
                    key="demo_map",
                ),
            )
            step += 1
            await asyncio.sleep(1.0 / settings.rate_hz)


@dataclass
class TrialEvent:
    """Not an AxisArray -- there is nothing here for a plot to draw.

    Included because a real graph is full of streams like this, and the message
    inspector working on them is most of why it exists.
    """

    index: int
    label: str
    confidence: float


class EventGeneratorSettings(ez.Settings):
    rate_hz: float = 2.0


class EventGenerator(ez.Unit):
    SETTINGS = EventGeneratorSettings

    OUTPUT = ez.OutputStream(TrialEvent)

    @ez.publisher(OUTPUT)
    async def generate(self) -> AsyncGenerator:
        labels = ("rest", "left", "right")
        index = 0
        while True:
            yield (
                self.OUTPUT,
                TrialEvent(
                    index=index,
                    label=labels[index % len(labels)],
                    confidence=0.5 + 0.5 * np.sin(index / 5.0),
                ),
            )
            index += 1
            await asyncio.sleep(1.0 / self.SETTINGS.rate_hz)


class Sink(ez.Unit):
    """Somewhere for the streams to go, so the graph has real edges to show."""

    SIGNAL = ez.InputStream(AxisArray)
    SPECTRUM = ez.InputStream(AxisArray)
    MAP = ez.InputStream(AxisArray)
    EVENTS = ez.InputStream(TrialEvent)

    @ez.subscriber(SIGNAL)
    async def on_signal(self, msg: AxisArray) -> None:
        return None

    @ez.subscriber(SPECTRUM)
    async def on_spectrum(self, msg: AxisArray) -> None:
        return None

    @ez.subscriber(MAP)
    async def on_map(self, msg: AxisArray) -> None:
        return None

    @ez.subscriber(EVENTS)
    async def on_events(self, msg: TrialEvent) -> None:
        return None


if __name__ == "__main__":
    signal = SignalGenerator()
    spectrum = SpectrumGenerator()
    channel_map = ChannelMapGenerator()
    events = EventGenerator()
    sink = Sink()

    # No graph_address: this attaches to whatever GraphServer `ezmsg serve`
    # already started, which is also the one the dashboard connects to. Left to
    # start its own, ez.run picks an ephemeral port neither would agree on.
    ez.run(
        SIGNAL=signal,
        SPECTRUM=spectrum,
        MAP=channel_map,
        EVENTS=events,
        SINK=sink,
        connections=(
            (signal.OUTPUT, sink.SIGNAL),
            (spectrum.OUTPUT, sink.SPECTRUM),
            (channel_map.OUTPUT, sink.MAP),
            (events.OUTPUT, sink.EVENTS),
        ),
    )
