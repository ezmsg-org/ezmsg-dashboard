from __future__ import annotations

import numpy as np
import pytest

from ezmsg.dashboard.backend.stream_frames import (
    RingCursor,
    SampleRing,
    decode_binary_frame,
    encode_binary_frame,
    envelope_pairs,
    ring_capacity_for,
)


def ramp(start: int, count: int, n_channels: int = 1, width: int = 1) -> np.ndarray:
    """``(count, n_channels, width)`` where every element encodes its position."""
    values = np.arange(start, start + count, dtype=np.float32)
    block = np.repeat(values[:, None], n_channels, axis=1)
    return np.repeat(block[:, :, None], width, axis=2)


class TestSampleRing:
    def test_reads_back_what_was_written(self) -> None:
        ring = SampleRing(capacity=16, n_channels=2, width=1)
        cursor = RingCursor()
        ring.write(ramp(0, 5, n_channels=2))

        block, overflowed, first_index = ring.read(cursor)

        assert not overflowed
        assert first_index == 0
        assert block.shape == (5, 2, 1)
        np.testing.assert_array_equal(block[:, 0, 0], np.arange(5))

    def test_second_read_returns_only_new_samples(self) -> None:
        ring = SampleRing(capacity=16, n_channels=2, width=1)
        cursor = RingCursor()
        ring.write(ramp(0, 5, n_channels=2))
        ring.read(cursor)
        ring.write(ramp(5, 3, n_channels=2))

        block, overflowed, first_index = ring.read(cursor)

        assert not overflowed
        assert first_index == 5
        np.testing.assert_array_equal(block[:, 0, 0], np.arange(5, 8))

    def test_read_with_nothing_new_is_empty_but_well_shaped(self) -> None:
        ring = SampleRing(capacity=16, n_channels=3, width=2)
        cursor = RingCursor()

        block, overflowed, _ = ring.read(cursor)

        assert not overflowed
        assert block.shape == (0, 3, 2)

    def test_wraps_without_losing_order(self) -> None:
        ring = SampleRing(capacity=8, n_channels=1, width=1)
        cursor = RingCursor()
        # Straddle the wrap: 6 then 4 into a ring of 8.
        ring.write(ramp(0, 6))
        ring.read(cursor)
        ring.write(ramp(6, 4))

        block, overflowed, first_index = ring.read(cursor)

        assert not overflowed
        assert first_index == 6
        np.testing.assert_array_equal(block[:, 0, 0], np.arange(6, 10))

    def test_lapped_reader_is_told_it_lost_samples(self) -> None:
        """The property the whole design turns on: a gap is reported, not hidden."""
        ring = SampleRing(capacity=8, n_channels=1, width=1)
        cursor = RingCursor()
        ring.write(ramp(0, 20))

        block, overflowed, first_index = ring.read(cursor)

        assert overflowed
        # Only the newest capacity samples survive, and the reader is told where
        # it actually resumed rather than being handed a seamless-looking block.
        assert first_index == 12
        np.testing.assert_array_equal(block[:, 0, 0], np.arange(12, 20))

    def test_block_longer_than_ring_keeps_its_tail_and_counts_the_rest(self) -> None:
        ring = SampleRing(capacity=4, n_channels=1, width=1)
        cursor = RingCursor()
        ring.write(ramp(0, 10))

        assert ring.total_written == 10
        block, overflowed, first_index = ring.read(cursor)
        assert overflowed
        assert first_index == 6
        np.testing.assert_array_equal(block[:, 0, 0], np.arange(6, 10))

    def test_returned_block_is_not_a_view_of_the_ring(self) -> None:
        """A caller is about to await a socket write; the writer must not alias it."""
        ring = SampleRing(capacity=8, n_channels=1, width=1)
        cursor = RingCursor()
        ring.write(ramp(0, 4))
        block, _, _ = ring.read(cursor)

        ring.write(ramp(100, 4))

        np.testing.assert_array_equal(block[:, 0, 0], np.arange(4))

    def test_cursor_ahead_of_a_rebuilt_ring_is_pulled_back(self) -> None:
        """A shape change resets the ring under cursors that already read from it."""
        ring = SampleRing(capacity=8, n_channels=1, width=1)
        cursor = RingCursor(total_read=99)

        block, _, _ = ring.read(cursor)

        assert block.shape == (0, 1, 1)
        assert cursor.total_read == 0

    def test_rejects_a_block_of_the_wrong_shape(self) -> None:
        ring = SampleRing(capacity=8, n_channels=2, width=1)
        with pytest.raises(ValueError, match="does not match ring"):
            ring.write(np.zeros((4, 3, 1), dtype=np.float32))


class TestRingCapacity:
    def test_sizes_from_duration_when_memory_allows(self) -> None:
        capacity = ring_capacity_for(srate=1000.0, n_channels=4, width=1, seconds=2.0, max_bytes=32 * 1024 * 1024)
        assert capacity == 2000

    def test_memory_ceiling_wins_for_a_wide_fast_stream(self) -> None:
        capacity = ring_capacity_for(srate=30_000.0, n_channels=256, width=1, seconds=2.0, max_bytes=1024 * 1024)
        assert capacity == 1024 * 1024 // (256 * 4)
        assert capacity < 30_000 * 2

    def test_a_stream_with_no_rate_still_gets_a_usable_ring(self) -> None:
        capacity = ring_capacity_for(srate=0.0, n_channels=1, width=1, seconds=2.0, max_bytes=1024 * 1024, minimum=256)
        assert capacity == 256


class TestEnvelopePairs:
    def test_short_block_passes_through_as_degenerate_pairs(self) -> None:
        block = ramp(0, 4, n_channels=2)
        pairs = envelope_pairs(block, max_columns=100)

        # (n_out, n_channels, components) -- the RG32F texel layout.
        assert pairs.shape == (4, 2, 2)
        np.testing.assert_array_equal(pairs[:, :, 0], pairs[:, :, 1])

    def test_decimation_keeps_the_extremes(self) -> None:
        """Subsampling would drop the spikes; min/max is why this exists."""
        samples = np.zeros((100, 1, 1), dtype=np.float32)
        samples[37, 0, 0] = 5.0
        samples[38, 0, 0] = -3.0

        pairs = envelope_pairs(samples, max_columns=10)

        assert pairs.shape == (10, 1, 2)
        assert pairs[:, 0, 1].max() == pytest.approx(5.0)
        assert pairs[:, 0, 0].min() == pytest.approx(-3.0)

    def test_native_minmax_input_reduces_per_component(self) -> None:
        block = np.zeros((100, 1, 2), dtype=np.float32)
        block[:, 0, 0] = -1.0  # mins
        block[:, 0, 1] = 1.0  # maxes
        block[50, 0, 0] = -9.0
        block[50, 0, 1] = 9.0

        pairs = envelope_pairs(block, max_columns=5)

        assert pairs[:, 0, 0].min() == pytest.approx(-9.0)
        assert pairs[:, 0, 1].max() == pytest.approx(9.0)
        # Mins never leak into the max component or vice versa.
        assert pairs[:, 0, 1].min() == pytest.approx(1.0)

    def test_empty_block_keeps_its_channel_count(self) -> None:
        pairs = envelope_pairs(np.empty((0, 7, 1), dtype=np.float32), max_columns=50)
        assert pairs.shape == (0, 7, 2)

    def test_output_never_exceeds_the_column_budget(self) -> None:
        for n_samples in (101, 999, 30_000):
            pairs = envelope_pairs(ramp(0, n_samples, n_channels=3), max_columns=64)
            assert pairs.shape == (64, 3, 2)


class TestBinaryFraming:
    def test_roundtrip(self) -> None:
        payload = np.arange(12, dtype=np.float32).reshape(2, 3, 2)
        header = {"kind": "stream.data", "n_out": 2, "overflow": False}

        decoded_header, decoded_payload = decode_binary_frame(encode_binary_frame(header, payload))

        assert decoded_header == header
        np.testing.assert_array_equal(decoded_payload, payload.ravel())

    def test_payload_is_little_endian_float32_regardless_of_input_dtype(self) -> None:
        """The browser reads with its own byte order, so the encoder must pin ours."""
        payload = np.arange(4, dtype=">f8")
        frame = encode_binary_frame({"kind": "stream.data"}, payload)

        _, decoded = decode_binary_frame(frame)

        assert decoded.dtype == np.dtype("<f4")
        np.testing.assert_allclose(decoded, [0.0, 1.0, 2.0, 3.0])

    def test_non_finite_header_value_is_refused_rather_than_sent_as_nan(self) -> None:
        """`NaN` is not JSON; letting it through would produce a frame no browser parses."""
        with pytest.raises(ValueError):
            encode_binary_frame({"kind": "stream.data", "t_start": float("nan")}, np.zeros(1))

    def test_truncated_frame_is_rejected(self) -> None:
        frame = encode_binary_frame({"kind": "stream.data"}, np.zeros(4, dtype=np.float32))
        with pytest.raises(ValueError):
            decode_binary_frame(frame[:2])
