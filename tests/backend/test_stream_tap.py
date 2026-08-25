from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import numpy as np
import pytest
from ezmsg.util.messages.axisarray import AxisArray

from ezmsg.dashboard.backend.services import stream_tap as tap_module
from ezmsg.dashboard.backend.services.stream_tap import (
    AUTO,
    INSPECT,
    MIN_WINDOW_SECONDS,
    SCATTER,
    SPECTRUM,
    SWEEP,
    StreamTap,
    StreamTapClient,
    StreamTapError,
    StreamTapManager,
)

pytestmark = pytest.mark.skipif(
    not tap_module.PLOTTING_AVAILABLE,
    reason="plotting modes need the 'viz' extra (ezmsg-tools)",
)


# -- fakes -----------------------------------------------------------------


class FakeSubscriber:
    """Stands in for ezmsg's Subscriber, down to the zero-copy contract."""

    def __init__(self, queue: asyncio.Queue[Any]) -> None:
        self._queue = queue
        self.closed = False

    @contextlib.asynccontextmanager
    async def recv_zero_copy(self):
        message = await self._queue.get()
        yield message

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        return None


class FakeSubscriberFactory:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[Any] = asyncio.Queue()
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.created: list[FakeSubscriber] = []
        self.fail_with: Exception | None = None

    async def __call__(self, topic: str, **kwargs: Any) -> FakeSubscriber:
        self.calls.append((topic, kwargs))
        if self.fail_with is not None:
            raise self.fail_with
        subscriber = FakeSubscriber(self.queue)
        self.created.append(subscriber)
        return subscriber


async def feed(tap: StreamTap, factory: FakeSubscriberFactory, *messages: Any) -> None:
    """Hand messages to a running tap and wait for it to absorb them."""
    for message in messages:
        await factory.queue.put(message)
    for _ in range(200):
        if factory.queue.empty():
            await asyncio.sleep(0)
            return
        await asyncio.sleep(0.001)
    raise AssertionError("tap did not consume its messages")


@contextlib.asynccontextmanager
async def running_tap(factory: FakeSubscriberFactory, topic: str = "SOURCE/OUTPUT"):
    tap = StreamTap(topic, factory)
    await tap.start()
    try:
        yield tap
    finally:
        await tap.stop()


# -- message builders ------------------------------------------------------


def timeseries(n_samples: int = 8, n_channels: int = 3, fs: float = 100.0, key: str = "sig") -> AxisArray:
    data = np.arange(n_samples * n_channels, dtype=np.float32).reshape(n_samples, n_channels)
    return AxisArray(
        data,
        dims=["time", "ch"],
        axes={"time": AxisArray.TimeAxis(fs=fs)},
        key=key,
    )


def labelled_timeseries(labels: list[str], n_samples: int = 4) -> AxisArray:
    ch_data = np.array(labels, dtype=[("label", "U8")])
    return AxisArray(
        np.zeros((n_samples, len(labels)), dtype=np.float32),
        dims=["time", "ch"],
        axes={
            "time": AxisArray.TimeAxis(fs=50.0),
            "ch": AxisArray.CoordinateAxis(data=ch_data, dims=["ch"]),
        },
        key="labelled",
    )


def spectrum(n_bins: int = 16, n_channels: int = 4) -> AxisArray:
    return AxisArray(
        np.ones((n_bins, n_channels), dtype=np.float32),
        dims=["freq", "ch"],
        axes={"freq": AxisArray.LinearAxis(gain=2.0, offset=0.0, unit="Hz")},
        key="spec",
    )


def positioned_channels(n_channels: int = 5) -> AxisArray:
    ch_data = np.zeros(n_channels, dtype=[("label", "U4"), ("x", "f4"), ("y", "f4")])
    ch_data["label"] = [f"c{i}" for i in range(n_channels)]
    ch_data["x"] = np.arange(n_channels, dtype=np.float32)
    ch_data["y"] = np.arange(n_channels, dtype=np.float32) * 2.0
    return AxisArray(
        np.arange(n_channels, dtype=np.float32),
        dims=["ch"],
        axes={"ch": AxisArray.CoordinateAxis(data=ch_data, dims=["ch"])},
        key="map",
    )


# -- tests -----------------------------------------------------------------


class TestSubscriberContract:
    @pytest.mark.asyncio
    async def test_tap_subscribes_leaky_so_it_cannot_backpressure_the_graph(self) -> None:
        """The property that makes tapping a production graph safe at all."""
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries())

        assert factory.calls
        topic, kwargs = factory.calls[0]
        assert topic == "SOURCE/OUTPUT"
        assert kwargs["leaky"] is True
        assert kwargs["max_queue"] == tap_module.LEAKY_MAX_QUEUE

    @pytest.mark.asyncio
    async def test_failure_to_subscribe_becomes_a_status_not_a_crash(self) -> None:
        factory = FakeSubscriberFactory()
        factory.fail_with = ConnectionRefusedError("no graph server")
        async with running_tap(factory) as tap:
            await asyncio.sleep(0.01)
            status = tap.status_payload()

        assert status["status"] == "error"
        assert "no graph server" in status["detail"]

    @pytest.mark.asyncio
    async def test_stopping_closes_the_subscriber_and_releases_it(self) -> None:
        released: list[Any] = []
        factory = FakeSubscriberFactory()
        tap = StreamTap("T", factory, subscriber_release=released.append)
        await tap.start()
        await feed(tap, factory, timeseries())
        await tap.stop()

        assert factory.created[0].closed is True
        assert released == [factory.created[0]]


class TestSweep:
    @pytest.mark.asyncio
    async def test_describes_a_timeseries_and_buffers_its_samples(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries(n_samples=8, n_channels=3, fs=100.0))

            description = tap.description
            assert description is not None
            assert description.mode == SWEEP
            assert description.n_channels == 3
            assert description.srate == pytest.approx(100.0)
            assert description.width == 1

            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=1000, window_seconds=MIN_WINDOW_SECONDS)
            assert client.take_description() is not None
            # take_description resets the cursor to "now", so a client only ever
            # sees samples that belong to the plot it just configured.
            assert client.take_frame() is None

            await feed(tap, factory, timeseries(n_samples=4, n_channels=3))
            frame = client.take_frame()

        assert frame is not None
        header, payload = frame
        assert header["mode"] == SWEEP
        assert header["n_out"] == 4
        assert header["n_channels"] == 3
        assert header["components"] == 2
        assert header["overflow"] is False
        assert payload.shape == (4, 3, 2)

    @pytest.mark.asyncio
    async def test_header_carries_a_real_time_axis(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries(n_samples=10, fs=100.0))
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=1000, window_seconds=MIN_WINDOW_SECONDS)
            client.take_description()
            await feed(tap, factory, timeseries(n_samples=50, fs=100.0))
            frame = client.take_frame()

        assert frame is not None
        header, _ = frame
        assert header["t_end"] - header["t_start"] == pytest.approx(0.5)

    @pytest.mark.asyncio
    async def test_window_decides_how_many_samples_a_column_stands_for(self) -> None:
        """The time base, not the frame rate, sets the decimation ratio.

        Without this a fast stream spreads whatever arrived since the last read
        across the whole plot, so the window covers a few milliseconds, the plot
        repaints entirely every frame, and the wire carries a full window per
        frame.
        """
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries(n_samples=4, n_channels=2, fs=10_000.0))
            # 10 kHz over a 2 s window in 100 columns: 200 samples per column.
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=2.0)
            client.take_description()
            await feed(tap, factory, timeseries(n_samples=5000, n_channels=2, fs=10_000.0))
            frame = client.take_frame()

        assert frame is not None
        header, payload = frame
        assert header["n_samples"] == 5000
        assert header["n_out"] == 25
        assert payload.shape == (25, 2, 2)

    @pytest.mark.asyncio
    async def test_a_slow_stream_shrinks_the_column_count_to_keep_the_window(self) -> None:
        """The pixel budget is a ceiling, not a target.

        2 s of a 100 Hz signal is 200 samples. Spreading them across a 2000
        column plot showed 20 s while the caption said 2, and made the window
        control look dead, because a column cannot hold less than one sample.
        """
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries(n_samples=10, n_channels=2, fs=100.0))
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=2000, window_seconds=2.0)
            client.take_description()
            for _ in range(30):
                await feed(tap, factory, timeseries(n_samples=10, n_channels=2, fs=100.0))
            frame = client.take_frame()

        assert frame is not None
        header, _ = frame
        assert header["columns"] == 200
        assert header["samples_per_column"] == pytest.approx(1.0)
        assert header["window_seconds"] == pytest.approx(2.0)

    @pytest.mark.asyncio
    async def test_the_window_control_still_bites_on_a_slow_stream(self) -> None:
        """The reported symptom: changing the window appeared to do nothing."""
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries(n_samples=10, n_channels=2, fs=100.0))
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=2000, window_seconds=2.0)
            client.take_description()

            spans = {}
            for window in (0.5, 2.0, 10.0):
                client.set_window_seconds(window)
                spans[window] = (
                    client.effective_columns(100.0),
                    client.shown_seconds(100.0),
                )

        assert spans[0.5] == (50, pytest.approx(0.5))
        assert spans[2.0] == (200, pytest.approx(2.0))
        assert spans[10.0] == (1000, pytest.approx(10.0))

    @pytest.mark.asyncio
    async def test_a_fast_stream_still_fills_the_pixel_budget(self) -> None:
        """The shrink must not touch streams that can fill the plot."""
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries(n_samples=10, n_channels=2, fs=30_000.0))
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=761, window_seconds=2.0)

            assert client.effective_columns(30_000.0) == 761
            assert client.samples_per_column(30_000.0) == pytest.approx(60_000 / 761)
            assert client.shown_seconds(30_000.0) == pytest.approx(2.0)

    def test_a_span_too_short_to_draw_reports_what_it_actually_shows(self) -> None:
        """Half a sample of a 1 Hz signal is not something anything can draw."""
        client = StreamTapClient(tap=None, mode=AUTO, max_columns=2000, window_seconds=0.5)

        # Floored at two columns, so the span really is two seconds -- and the
        # header says two, rather than echoing the request back as a lie.
        assert client.effective_columns(1.0) == 2
        assert client.shown_seconds(1.0) == pytest.approx(2.0)

    def test_a_stream_with_no_sample_rate_has_no_span(self) -> None:
        client = StreamTapClient(tap=None, mode=AUTO, max_columns=500, window_seconds=2.0)

        assert client.effective_columns(0.0) == 500
        assert client.shown_seconds(0.0) is None

    @pytest.mark.asyncio
    async def test_a_backlog_never_exceeds_the_window(self) -> None:
        """A big backlog fills the window, and stops there.

        The bound is the window's own column count, not the plot's pixel budget:
        more columns than the window is worth would show more time than the
        caption claims.
        """
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries(n_samples=4, n_channels=2, fs=100.0))
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=2000, window_seconds=1.0)
            client.take_description()
            await feed(tap, factory, timeseries(n_samples=900, n_channels=2, fs=100.0))
            frame = client.take_frame()

        assert frame is not None
        header, payload = frame
        # 1 s of a 100 Hz stream is 100 columns, however far behind the reader is.
        assert header["columns"] == 100
        assert header["n_out"] == 100
        assert payload.shape == (100, 2, 2)

    @pytest.mark.asyncio
    async def test_no_frame_until_a_whole_column_is_available(self) -> None:
        """Sub-column frames would put more columns on the plot than time allows."""
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries(n_samples=10, n_channels=1, fs=10_000.0))
            # 100 samples per column, so ten-sample messages must accumulate.
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=200, window_seconds=2.0)
            client.take_description()

            await feed(tap, factory, timeseries(n_samples=10, n_channels=1, fs=10_000.0))
            assert client.take_frame() is None

            for _ in range(11):
                await feed(tap, factory, timeseries(n_samples=10, n_channels=1, fs=10_000.0))
            frame = client.take_frame()

        assert frame is not None
        assert frame[0]["n_out"] >= 1

    @pytest.mark.asyncio
    async def test_a_relabelled_channel_axis_republishes_the_description(self) -> None:
        """Labels changing must reach the plot; nothing else says the axis moved."""
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, labelled_timeseries(["a", "b"]))
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            first = client.take_description()
            assert first is not None
            assert first["channel_labels"] == ["a", "b"]
            assert client.take_description() is None

            await feed(tap, factory, labelled_timeseries(["x", "y"]))
            second = client.take_description()

        assert second is not None
        assert second["channel_labels"] == ["x", "y"]
        assert second["generation"] > first["generation"]

    @pytest.mark.asyncio
    async def test_repeated_identical_messages_do_not_republish(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, *[timeseries() for _ in range(5)])
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            assert client.take_description() is not None
            await feed(tap, factory, *[timeseries() for _ in range(5)])

            assert client.take_description() is None

    @pytest.mark.asyncio
    async def test_channel_count_change_rebuilds_and_resets(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries(n_channels=3))
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            assert client.take_description()["n_channels"] == 3

            await feed(tap, factory, timeseries(n_channels=7))
            second = client.take_description()

        assert second is not None
        assert second["n_channels"] == 7


def folded_timeseries(dim_order: list[str], n_ch: int = 4, n_feat: int = 2) -> AxisArray:
    """A stream that folds two dimensions into channels, values encoding both.

    Each sample is ``ch * 10 + feat``, so a test can read back which channel a
    given flattened lane actually holds.
    """
    sizes = {"time": 3, "ch": n_ch, "feat": n_feat}
    data = np.zeros([sizes[dim] for dim in dim_order], dtype=np.float32)
    iterator = np.nditer(data, flags=["multi_index"], op_flags=["writeonly"])
    for cell in iterator:
        index = dict(zip(dim_order, iterator.multi_index))
        cell[...] = index["ch"] * 10 + index["feat"]

    ch_axis = np.zeros(n_ch, dtype=[("label", "U8")])
    ch_axis["label"] = [f"E{i}" for i in range(n_ch)]
    return AxisArray(
        data,
        dims=list(dim_order),
        axes={
            "time": AxisArray.TimeAxis(fs=100.0),
            "ch": AxisArray.CoordinateAxis(data=ch_axis, dims=["ch"]),
            "feat": AxisArray.CoordinateAxis(data=np.array(["sbp", "rate"][:n_feat]), dims=["feat"]),
        },
        key="folded",
    )


class TestFoldedChannelAxes:
    """Streams whose channels are several dimensions folded together.

    The old behaviour named flattened channels from the ``ch`` axis alone, which
    ran out after one axis' worth and -- for a ``(ch, feat)`` fold -- put a real
    electrode's name on a different electrode's feature.
    """

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("dim_order", "expected"),
        [
            (
                ["time", "ch", "feat"],
                ["E0/sbp", "E0/rate", "E1/sbp", "E1/rate", "E2/sbp", "E2/rate", "E3/sbp", "E3/rate"],
            ),
            (
                ["time", "feat", "ch"],
                ["sbp/E0", "sbp/E1", "sbp/E2", "sbp/E3", "rate/E0", "rate/E1", "rate/E2", "rate/E3"],
            ),
        ],
    )
    async def test_labels_follow_the_fold_order(self, dim_order: list[str], expected: list[str]) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, folded_timeseries(dim_order))
            description = tap.description

        assert description is not None
        assert description.n_channels == 8
        assert description.channel_labels == expected

    @pytest.mark.asyncio
    async def test_labels_name_the_channel_the_data_actually_holds(self) -> None:
        """The alignment the old code got wrong, checked against the values."""
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, folded_timeseries(["time", "ch", "feat"]))
            description = tap.description
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=0.03)
            client.take_description()
            await feed(tap, factory, folded_timeseries(["time", "ch", "feat"]))
            frame = client.take_frame()

        assert description is not None and frame is not None
        _, payload = frame
        feature_names = ("sbp", "rate")
        for flat_index, label in enumerate(description.channel_labels):
            encoded = payload[0, flat_index, 0]
            channel, feature = divmod(int(round(float(encoded))), 10)
            assert label == f"E{channel}/{feature_names[feature]}"

    @pytest.mark.asyncio
    async def test_the_folded_dimensions_are_reported_in_fold_order(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, folded_timeseries(["time", "feat", "ch"]))
            description = tap.description

        assert description is not None
        assert [(axis["name"], axis["size"]) for axis in description.channel_axes] == [
            ("feat", 2),
            ("ch", 4),
        ]
        assert description.channel_axes[0]["labels"] == ["sbp", "rate"]
        assert description.channel_axes[1]["labels"] == ["E0", "E1", "E2", "E3"]

    @pytest.mark.asyncio
    async def test_an_unfolded_stream_keeps_its_plain_channel_names(self) -> None:
        """One channel dimension must not grow a composite name."""
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, labelled_timeseries(["a", "b"]))
            description = tap.description

        assert description is not None
        assert description.channel_labels == ["a", "b"]
        assert [axis["name"] for axis in description.channel_axes] == ["ch"]

    @pytest.mark.asyncio
    async def test_the_metric_axis_is_not_folded_into_channels(self) -> None:
        """A (min, max) tuple is an envelope, not another channel dimension."""
        metric_data = np.array(["min", "max"], dtype=[("label", "U4")])["label"]
        ch_axis = np.zeros(3, dtype=[("label", "U8")])
        ch_axis["label"] = ["E0", "E1", "E2"]
        message = AxisArray(
            np.zeros((4, 3, 2), dtype=np.float32),
            dims=["time", "ch", "metric"],
            axes={
                "time": AxisArray.TimeAxis(fs=100.0),
                "ch": AxisArray.CoordinateAxis(data=ch_axis, dims=["ch"]),
                "metric": AxisArray.CoordinateAxis(data=metric_data, dims=["metric"]),
            },
            key="env",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            description = tap.description

        assert description is not None
        assert [axis["name"] for axis in description.channel_axes] == ["ch"]
        assert description.channel_labels == ["E0", "E1", "E2"]


class TestSpectrumAndScatter:
    @pytest.mark.asyncio
    async def test_spectrum_keeps_its_bins_out_of_the_channel_count(self) -> None:
        """`describe_axisarray` defaults to excluding `time`; a spectrum has none."""
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, spectrum(n_bins=16, n_channels=4))
            description = tap.description
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            client.take_description()
            await feed(tap, factory, spectrum(n_bins=16, n_channels=4))
            frame = client.take_frame()

        assert description is not None
        assert description.mode == SPECTRUM
        assert description.n_channels == 4
        assert description.n_bins == 16
        assert description.freq_gain == pytest.approx(2.0)
        # A sample rate would be a lie here -- the axis is frequency.
        assert description.srate == 0.0

        assert frame is not None
        header, payload = frame
        assert header["mode"] == SPECTRUM
        assert header["components"] == 1
        assert payload.shape == (16, 4)

    @pytest.mark.asyncio
    async def test_spectrum_frame_is_sent_once_per_message(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, spectrum())
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            client.take_description()
            await feed(tap, factory, spectrum())

            assert client.take_frame() is not None
            assert client.take_frame() is None

    @pytest.mark.asyncio
    async def test_channel_positions_select_the_scatter_view(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, positioned_channels(5))
            description = tap.description
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            client.take_description()
            await feed(tap, factory, positioned_channels(5))
            frame = client.take_frame()

        assert description is not None
        assert description.mode == SCATTER
        assert description.n_channels == 5
        assert description.channel_positions is not None
        assert len(description.channel_positions) == 5

        assert frame is not None
        header, payload = frame
        assert header["mode"] == SCATTER
        assert payload.shape == (1, 5)

    @pytest.mark.asyncio
    async def test_all_zero_positions_do_not_count_as_a_map(self) -> None:
        """An unpopulated x/y would otherwise draw every channel on the origin."""
        ch_data = np.zeros(4, dtype=[("label", "U4"), ("x", "f4"), ("y", "f4")])
        ch_data["label"] = ["a", "b", "c", "d"]
        message = AxisArray(
            np.zeros(4, dtype=np.float32),
            dims=["ch"],
            axes={"ch": AxisArray.CoordinateAxis(data=ch_data, dims=["ch"])},
            key="flat",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            description = tap.description

        assert description is not None
        assert description.mode != SCATTER


class TestVeryWideStreams:
    """A wide stream is plotted, a window at a time -- not refused.

    There was a hard ceiling here that turned anything past it into an inspector
    entry. It rested on a bandwidth estimate that stopped being true once the
    sweep gained a time base: traffic follows columns per second, so the channel
    count multiplies a few hundred columns, not a few hundred *frames*.
    """

    @pytest.mark.asyncio
    @pytest.mark.parametrize("n_channels", [513, 2048])
    async def test_a_wide_stream_is_described_rather_than_refused(self, n_channels: int) -> None:
        message = AxisArray(
            np.zeros((4, n_channels), dtype=np.float32),
            dims=["time", "ch"],
            axes={"time": AxisArray.TimeAxis(fs=1000.0)},
            key="wide",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            description = tap.description
            payload = tap.inspect_payload()

        assert description is not None
        assert description.n_channels == n_channels
        assert payload["plottable"] is True
        assert payload["plot_error"] is None

    @pytest.mark.asyncio
    async def test_a_wide_stream_sends_every_channel(self) -> None:
        """Selection is the browser's job; the tap does not silently drop any."""
        n_channels = 2048
        message = AxisArray(
            np.tile(np.arange(n_channels, dtype=np.float32), (4, 1)),
            dims=["time", "ch"],
            axes={"time": AxisArray.TimeAxis(fs=1000.0)},
            key="wide",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=200, window_seconds=0.004)
            client.take_description()
            await feed(tap, factory, message)
            frame = client.take_frame()

        assert frame is not None
        header, payload = frame
        assert header["n_channels"] == n_channels
        assert payload.shape[1] == n_channels
        # Channel k really does carry channel k's value, all the way out.
        np.testing.assert_allclose(payload[0, :, 0], np.arange(n_channels, dtype=np.float32))

    def test_the_drawn_ceiling_is_advertised_as_a_view_limit(self) -> None:
        payload = tap_module.availability_payload()

        assert payload["max_drawn_channels"] == tap_module.MAX_DRAWN_CHANNELS
        assert "max_plot_channels" not in payload


class TestAvailableViews:
    """Which views a stream can be drawn as, as opposed to which it opens as.

    A `(time, ch)` stream with real electrode positions is both a sweep and a
    map. Reporting only the inferred view would make the browser re-subscribe to
    change its mind, when every view here is a reading of the same frames.
    """

    @pytest.mark.asyncio
    async def test_a_timeseries_with_positions_offers_the_map_too(self) -> None:
        n_ch = 6
        ch_axis = np.zeros(n_ch, dtype=[("label", "U8"), ("x", "f4"), ("y", "f4")])
        ch_axis["label"] = [f"e{i}" for i in range(n_ch)]
        ch_axis["x"] = np.arange(n_ch, dtype=np.float32)
        ch_axis["y"] = np.arange(n_ch, dtype=np.float32) * 0.5
        message = AxisArray(
            np.zeros((4, n_ch), dtype=np.float32),
            dims=["time", "ch"],
            axes={
                "time": AxisArray.TimeAxis(fs=100.0),
                "ch": AxisArray.CoordinateAxis(data=ch_axis, dims=["ch"]),
            },
            key="positioned",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            description = tap.description

        assert description is not None
        # Sweep stays the default: time is what the stream is about.
        assert description.mode == SWEEP
        assert description.available_modes == [SWEEP, SCATTER]
        assert description.channel_positions is not None
        assert len(description.channel_positions) == n_ch

    @pytest.mark.asyncio
    async def test_a_timeseries_without_positions_offers_only_the_sweep(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, labelled_timeseries(["a", "b"]))
            description = tap.description

        assert description is not None
        assert description.available_modes == [SWEEP]
        assert description.channel_positions is None

    @pytest.mark.asyncio
    async def test_a_map_stream_offers_the_sweep_as_well(self) -> None:
        """Watching one electrode's value move over time is a real use."""
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, positioned_channels(5))
            description = tap.description

        assert description is not None
        assert description.mode == SCATTER
        assert description.available_modes == [SCATTER, SWEEP]

    @pytest.mark.asyncio
    async def test_a_folded_stream_does_not_offer_a_map_it_cannot_draw(self) -> None:
        """One position per drawn channel, or the map would be a lie.

        A (ch, feat) fold has twice as many channels as positions; the browser
        can offer the map once a pin brings the counts back into line, but the
        unpinned stream cannot draw one.
        """
        n_ch, n_feat = 4, 2
        ch_axis = np.zeros(n_ch, dtype=[("label", "U8"), ("x", "f4"), ("y", "f4")])
        ch_axis["label"] = [f"e{i}" for i in range(n_ch)]
        ch_axis["x"] = np.arange(n_ch, dtype=np.float32)
        ch_axis["y"] = np.ones(n_ch, dtype=np.float32)
        message = AxisArray(
            np.zeros((3, n_ch, n_feat), dtype=np.float32),
            dims=["time", "ch", "feat"],
            axes={
                "time": AxisArray.TimeAxis(fs=100.0),
                "ch": AxisArray.CoordinateAxis(data=ch_axis, dims=["ch"]),
                "feat": AxisArray.CoordinateAxis(data=np.array(["sbp", "rate"]), dims=["feat"]),
            },
            key="folded_positions",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            description = tap.description

        assert description is not None
        assert description.n_channels == 8
        assert description.available_modes == [SWEEP]

    @pytest.mark.asyncio
    async def test_a_spectrum_offers_only_the_spectrum(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, spectrum())
            description = tap.description

        assert description is not None
        assert description.available_modes == [SPECTRUM]


class TestInspector:
    @pytest.mark.asyncio
    async def test_a_non_axisarray_message_is_still_described(self) -> None:
        """Most of the inspector's value is working on things no plot can draw."""

        class Command:
            def __repr__(self) -> str:
                return "Command(start=True)"

        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, Command())
            inspect_payload = tap.inspect_payload()
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)

            assert client.take_frame() is None

        assert inspect_payload["type_name"] == "Command"
        assert inspect_payload["is_axisarray"] is False
        assert inspect_payload["plottable"] is False
        assert "Command(start=True)" in inspect_payload["repr_preview"]

    @pytest.mark.asyncio
    async def test_a_broken_repr_does_not_kill_the_tap(self) -> None:
        class Hostile:
            def __repr__(self) -> str:
                raise RuntimeError("nope")

        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, Hostile())
            payload = tap.inspect_payload()
            status = tap.status_payload()

        assert "unreprable" in payload["repr_preview"]
        assert status["status"] == "live"

    @pytest.mark.asyncio
    async def test_axisarray_inspection_reports_axes_without_shipping_arrays(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, labelled_timeseries(["a", "b"], n_samples=6))
            payload = tap.inspect_payload()

        assert payload["is_axisarray"] is True
        assert payload["dims"] == ["time", "ch"]
        assert payload["shape"] == [6, 2]
        assert payload["plottable"] is True
        assert payload["axes"]["ch"]["kind"] == "coord"
        assert payload["axes"]["ch"]["fields"] == ["label"]
        assert payload["axes"]["ch"]["length"] == 2
        assert "data" not in payload["axes"]["ch"]
        assert payload["axes"]["time"]["kind"] == "linear"

    @pytest.mark.asyncio
    async def test_inspect_mode_never_opens_the_data_path(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, timeseries())
            client = StreamTapClient(tap=tap, mode=INSPECT, max_columns=100)
            client.take_description()
            await feed(tap, factory, timeseries())

            assert client.take_frame() is None

    @pytest.mark.asyncio
    async def test_a_dispersion_metric_is_refused_rather_than_drawn_as_an_envelope(self) -> None:
        """(mean, std) is the same shape as (min, max) and means something else."""
        metric_data = np.array(["mean", "std"], dtype=[("label", "U4")])["label"]
        message = AxisArray(
            np.zeros((4, 3, 2), dtype=np.float32),
            dims=["time", "ch", "metric"],
            axes={
                "time": AxisArray.TimeAxis(fs=100.0),
                "metric": AxisArray.CoordinateAxis(data=metric_data, dims=["metric"]),
            },
            key="agg",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            payload = tap.inspect_payload()

        assert payload["plottable"] is False
        assert "mean_std" in payload["plot_error"]

    @pytest.mark.asyncio
    async def test_a_native_minmax_envelope_is_drawn_as_one(self) -> None:
        metric_data = np.array(["min", "max"], dtype=[("label", "U4")])["label"]
        message = AxisArray(
            np.stack(
                [np.full((4, 3), -1.0, dtype=np.float32), np.full((4, 3), 1.0, dtype=np.float32)],
                axis=-1,
            ),
            dims=["time", "ch", "metric"],
            axes={
                "time": AxisArray.TimeAxis(fs=100.0),
                "metric": AxisArray.CoordinateAxis(data=metric_data, dims=["metric"]),
            },
            key="env",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            description = tap.description
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            client.take_description()
            await feed(tap, factory, message)
            frame = client.take_frame()

        assert description is not None
        assert description.width == 2
        assert description.metric_kind == "minmax"
        assert description.n_channels == 3
        assert frame is not None
        _, payload = frame
        assert payload.shape == (4, 3, 2)
        np.testing.assert_allclose(payload[:, :, 0], -1.0)
        np.testing.assert_allclose(payload[:, :, 1], 1.0)


class TestComplexData:
    @pytest.mark.asyncio
    async def test_complex_spectrum_is_reduced_to_magnitude(self) -> None:
        message = AxisArray(
            np.full((8, 2), 3.0 + 4.0j, dtype=np.complex64),
            dims=["freq", "ch"],
            axes={"freq": AxisArray.LinearAxis(gain=1.0, offset=0.0, unit="Hz")},
            key="cspec",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            description = tap.description
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            client.take_description()
            await feed(tap, factory, message)
            frame = client.take_frame()

        assert description is not None
        assert description.complex_magnitude is True
        assert frame is not None
        _, payload = frame
        np.testing.assert_allclose(payload, 5.0)


class TestManager:
    @pytest.mark.asyncio
    async def test_two_clients_on_one_topic_share_a_single_subscriber(self) -> None:
        """Otherwise the dashboard's cost to the graph scales with browser tabs."""
        factory = FakeSubscriberFactory()
        manager = StreamTapManager(factory)
        try:
            async with manager.client("T", mode=AUTO, max_columns=100) as first:
                async with manager.client("T", mode=AUTO, max_columns=100) as second:
                    # The tap subscribes on its own task, so opening a client
                    # deliberately does not block on the graph server.
                    await asyncio.sleep(0)
                    assert first.tap is second.tap
                    assert len(factory.calls) == 1
                    assert manager.active_topics == ["T"]
                # One releasing does not tear the tap down for the other.
                assert manager.active_topics == ["T"]
        finally:
            await manager.shutdown()

        assert manager.active_topics == []

    @pytest.mark.asyncio
    async def test_last_client_leaving_stops_the_tap(self) -> None:
        factory = FakeSubscriberFactory()
        manager = StreamTapManager(factory)
        async with manager.client("T", mode=AUTO, max_columns=100):
            await asyncio.sleep(0)

        assert manager.active_topics == []
        assert factory.created[0].closed is True

    @pytest.mark.asyncio
    async def test_reopening_a_topic_creates_a_fresh_subscriber(self) -> None:
        factory = FakeSubscriberFactory()
        manager = StreamTapManager(factory)
        async with manager.client("T", mode=AUTO, max_columns=100):
            await asyncio.sleep(0)
        async with manager.client("T", mode=AUTO, max_columns=100):
            await asyncio.sleep(0)
        await manager.shutdown()

        assert len(factory.calls) == 2

    @pytest.mark.asyncio
    async def test_unknown_mode_is_refused(self) -> None:
        manager = StreamTapManager(FakeSubscriberFactory())
        with pytest.raises(StreamTapError, match="unknown stream mode"):
            async with manager.client("T", mode="waterfall", max_columns=100):
                pass

    @pytest.mark.asyncio
    async def test_empty_topic_is_refused(self) -> None:
        manager = StreamTapManager(FakeSubscriberFactory())
        with pytest.raises(StreamTapError, match="needs a topic"):
            async with manager.client("", mode=AUTO, max_columns=100):
                pass

    @pytest.mark.asyncio
    async def test_shutdown_stops_every_tap(self) -> None:
        factory = FakeSubscriberFactory()
        manager = StreamTapManager(factory)
        context_a = manager.client("A", mode=AUTO, max_columns=100)
        context_b = manager.client("B", mode=AUTO, max_columns=100)
        await context_a.__aenter__()
        await context_b.__aenter__()
        await asyncio.sleep(0)
        assert manager.active_topics == ["A", "B"]

        await manager.shutdown()

        assert manager.active_topics == []
        assert all(subscriber.closed for subscriber in factory.created)


class TestChannelOnlyStream:
    @pytest.mark.asyncio
    async def test_bare_channel_stream_advances_one_column_per_message(self) -> None:
        """No time axis and no positions: still plottable, x is message arrivals."""
        message = AxisArray(
            np.array([1.0, 2.0, 3.0, 4.0], dtype=np.float32),
            dims=["ch"],
            axes={},
            key="bare",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            description = tap.description
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            client.take_description()
            await feed(tap, factory, message, message)
            frame = client.take_frame()

        assert description is not None
        assert description.mode == SWEEP
        assert description.n_channels == 4
        assert description.sample_dim == ""
        # No sample rate to speak of, so the header offers no seconds -- the
        # client falls back to sample index rather than being handed a made-up
        # time axis.
        assert description.srate == 0.0

        assert frame is not None
        header, payload = frame
        assert header["t_start"] is None
        assert header["n_out"] == 2
        assert payload.shape == (2, 4, 2)
        np.testing.assert_allclose(payload[0, :, 0], [1.0, 2.0, 3.0, 4.0])


class TestNoAliasingOfBorrowedMessages:
    """`recv_zero_copy` lends the publisher's buffer; nothing may outlive it."""

    @pytest.mark.asyncio
    async def test_spectrum_frame_does_not_alias_the_message(self) -> None:
        message = spectrum(n_bins=8, n_channels=2)
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            stored = tap.read_latest(-1)
            assert stored is not None
            frame, _ = stored

            # Stand in for the publisher reusing its buffer after the lease.
            message.data[...] = -99.0

            np.testing.assert_allclose(frame, 1.0)

    @pytest.mark.asyncio
    async def test_scatter_frame_does_not_alias_the_message(self) -> None:
        message = positioned_channels(4)
        original = np.array(message.data, copy=True)
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            stored = tap.read_latest(-1)
            assert stored is not None
            frame, _ = stored

            message.data[...] = -99.0

            np.testing.assert_allclose(frame[0], original)

    @pytest.mark.asyncio
    async def test_sweep_ring_does_not_alias_the_message(self) -> None:
        message = timeseries(n_samples=4, n_channels=2)
        original = np.array(message.data, copy=True)
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            client.take_description()
            await feed(tap, factory, message)

            message.data[...] = -99.0
            frame = client.take_frame()

        assert frame is not None
        _, payload = frame
        np.testing.assert_allclose(payload[:, :, 0], original)


# -- foreign array payloads ------------------------------------------------

#: Looked up by name on the module defining a foreign array class, so these
#: stand in for `mlx.core.uint16` when a bfloat16 payload has to be reached
#: through its bits.
uint16 = np.dtype(np.uint16)


class FakeForeignDtype:
    """A dtype object that is not numpy's: no ``.str``, only a name.

    This is the shape of the reported failure -- ``mlx.core.Dtype`` has no
    ``.str`` -- reproduced without depending on MLX.
    """

    def __init__(self, name: str) -> None:
        self.name = name

    def __str__(self) -> str:
        return self.name


class FakeForeignArray:
    """Mimics a framework array: numpy-viewable unless its dtype says otherwise.

    ``convertible=False`` reproduces MLX's ``bfloat16``, which fails the buffer
    protocol and is only reachable by reinterpreting its raw bits.
    """

    def __init__(self, values: np.ndarray, dtype_name: str, *, convertible: bool = True) -> None:
        self._values = values
        self.dtype = FakeForeignDtype(dtype_name)
        self.convertible = convertible

    @property
    def shape(self) -> tuple[int, ...]:
        return self._values.shape

    @property
    def ndim(self) -> int:
        # AxisArray validates dims against ndim, and real framework arrays have
        # it; a fake without one fails construction rather than the code here.
        return self._values.ndim

    def __array__(self, dtype: Any = None, copy: Any = None) -> np.ndarray:
        if not self.convertible:
            raise TypeError(f"{self.dtype} arrays cannot be converted to NumPy.")
        return self._values if dtype is None else self._values.astype(dtype)

    def view(self, dtype: Any) -> Any:
        # Strict like MLX: only the framework's own dtype object is accepted.
        if dtype is not uint16:
            raise TypeError("view(): incompatible function arguments")
        # bfloat16 is the top half of a float32, so its bits are that half.
        bits = (self._values.view(np.uint32) >> 16).astype(np.uint16)
        return FakeForeignArray(bits, "uint16")


def bfloat16_array(values: np.ndarray) -> FakeForeignArray:
    """A fake bfloat16 array holding ``values`` truncated to bfloat16 precision."""
    truncated = ((values.astype(np.float32).view(np.uint32) >> 16) << 16).view(np.float32)
    return FakeForeignArray(truncated, "bfloat16", convertible=False)


def foreign_timeseries(dtype_name: str = "float32") -> AxisArray:
    values = np.tile(np.linspace(-1.0, 1.0, 8, dtype=np.float32)[:, None], (1, 2))
    data = bfloat16_array(values) if dtype_name == "bfloat16" else FakeForeignArray(values, dtype_name)
    return AxisArray(
        data,
        dims=["time", "ch"],
        axes={"time": AxisArray.TimeAxis(fs=100.0)},
        key="foreign",
    )


class TestForeignArrayPayloads:
    @pytest.mark.asyncio
    async def test_a_foreign_dtype_does_not_break_the_shape_signature(self) -> None:
        """The reported crash: only numpy dtypes have `.str`."""
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, foreign_timeseries())
            description, inspect_payload = tap.description, tap.inspect_payload()

        assert description is not None
        assert description.n_channels == 2
        assert inspect_payload["plottable"] is True

    @pytest.mark.asyncio
    async def test_a_numpy_viewable_foreign_array_plots(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, foreign_timeseries())
            # 8 samples at 100 Hz is 0.08 s, so ask for exactly that and get one
            # column per sample.
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=0.08)
            client.take_description()
            await feed(tap, factory, foreign_timeseries())
            frame = client.take_frame()

        assert frame is not None
        header, payload = frame
        assert header["n_channels"] == 2
        assert payload.shape == (8, 2, 2)

    @pytest.mark.asyncio
    async def test_bfloat16_is_read_through_its_bits(self) -> None:
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, foreign_timeseries("bfloat16"))
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=100, window_seconds=MIN_WINDOW_SECONDS)
            client.take_description()
            await feed(tap, factory, foreign_timeseries("bfloat16"))
            frame = client.take_frame()

        assert frame is not None
        _, payload = frame
        assert not np.isnan(payload).any()
        assert payload.min() == pytest.approx(-1.0, abs=0.01)
        assert payload.max() == pytest.approx(1.0, abs=0.01)

    @pytest.mark.asyncio
    async def test_an_unviewable_payload_reports_why_and_keeps_the_inspector(self) -> None:
        class Opaque:
            dtype = FakeForeignDtype("mystery")
            shape = (4, 2)
            ndim = 2

            def __array__(self, dtype: Any = None, copy: Any = None) -> np.ndarray:
                raise TypeError("nope")

        message = AxisArray(
            Opaque(),
            dims=["time", "ch"],
            axes={"time": AxisArray.TimeAxis(fs=100.0)},
            key="opaque",
        )
        factory = FakeSubscriberFactory()
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            description = tap.description
            payload = tap.inspect_payload()

        assert description is None
        assert payload["plottable"] is False
        assert "cannot be read as a numpy array" in payload["plot_error"]
        # The half that still works is the half worth keeping.
        assert payload["is_axisarray"] is True
        assert payload["dims"] == ["time", "ch"]
        assert payload["dtype"] == "mystery"


class TestAsNumpy:
    def test_a_numpy_array_is_passed_straight_through(self) -> None:
        values = np.zeros((3, 2), dtype=np.float32)
        assert tap_module.as_numpy(values) is values

    def test_a_viewable_foreign_array_is_not_copied(self) -> None:
        """np.asarray of an MLX array aliases its buffer; keep that property."""
        values = np.arange(6, dtype=np.float32)
        viewed = tap_module.as_numpy(FakeForeignArray(values, "float32"))
        assert np.shares_memory(viewed, values)

    def test_bfloat16_widens_exactly(self) -> None:
        """Moving the bits is exact -- there is nothing to round."""
        values = np.linspace(-3.0, 3.0, 65, dtype=np.float32)
        source = bfloat16_array(values)

        widened = tap_module.as_numpy(source)

        np.testing.assert_array_equal(widened, source._values)

    def test_something_with_no_array_interface_is_refused(self) -> None:
        with pytest.raises(tap_module.StreamTapError, match="cannot be read as a numpy array"):
            tap_module.as_numpy(object())


try:  # pragma: no cover - depends on the machine
    import mlx.core as mx

    MLX_AVAILABLE = True
except ImportError:  # pragma: no cover
    mx = None  # type: ignore[assignment]
    MLX_AVAILABLE = False


@pytest.mark.skipif(not MLX_AVAILABLE, reason="mlx is not installed (Apple silicon only)")
class TestRealMlxPayloads:
    """Checked against MLX itself, because the fake above can drift from it.

    MLX is not a dependency and is Apple-only, so these skip everywhere else.
    """

    def mlx_message(self, dtype: Any) -> AxisArray:
        values = np.tile(np.linspace(-1.0, 1.0, 64, dtype=np.float32)[:, None], (1, 3))
        return AxisArray(
            mx.array(values).astype(dtype),
            dims=["time", "ch"],
            axes={"time": AxisArray.TimeAxis(fs=1000.0)},
            attrs={"unit": "uV"},
            key="mlx",
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("dtype_name", ["float32", "float16", "bfloat16"])
    async def test_mlx_payloads_plot_with_their_values_intact(self, dtype_name: str) -> None:
        factory = FakeSubscriberFactory()
        message = self.mlx_message(getattr(mx, dtype_name))
        async with running_tap(factory) as tap:
            await feed(tap, factory, message)
            description = tap.description
            # 64 samples at 1 kHz is 0.064 s, so ask for exactly that and get
            # one column per sample.
            client = StreamTapClient(tap=tap, mode=AUTO, max_columns=200, window_seconds=0.064)
            client.take_description()
            await feed(tap, factory, message)
            frame = client.take_frame()

        assert description is not None
        assert description.n_channels == 3
        assert description.srate == pytest.approx(1000.0)
        assert frame is not None
        _, payload = frame
        assert payload.shape == (64, 3, 2)
        assert not np.isnan(payload).any()
        # bfloat16 keeps 8 mantissa bits, so this tolerance covers the worst case.
        assert payload.min() == pytest.approx(-1.0, abs=0.01)
        assert payload.max() == pytest.approx(1.0, abs=0.01)

    def test_np_asarray_of_an_mlx_array_is_a_view_not_a_copy(self) -> None:
        """The aliasing `as_numpy` documents, asserted against the real thing."""
        array = mx.array(np.arange(6, dtype=np.float32))
        first = tap_module.as_numpy(array)
        second = tap_module.as_numpy(array)
        assert np.shares_memory(first, second)

    def test_mlx_bfloat16_widens_to_the_same_values_a_cpu_cast_would(self) -> None:
        """The bits route must agree exactly with MLX's own correct answer.

        A GPU-stream `astype` is *not* used as the reference: on an array that
        arrived over ezmsg's transport it returns garbage near 2.5e38 rather
        than failing, which is the whole reason this path exists.
        """
        values = np.linspace(-3.0, 3.0, 129, dtype=np.float32)
        array = mx.array(values).astype(mx.bfloat16)

        widened = tap_module.as_numpy(array)

        np.testing.assert_array_equal(widened, np.asarray(array.astype(mx.float32, mx.cpu)))

    def test_direct_numpy_conversion_of_bfloat16_really_is_closed(self) -> None:
        """If this ever starts working, `_bfloat16_via_bits` is dead code."""
        array = mx.zeros((4, 2), dtype=mx.bfloat16)
        with pytest.raises(Exception):
            np.asarray(array)
        with pytest.raises(Exception):
            np.asarray(array, dtype=np.float32)
