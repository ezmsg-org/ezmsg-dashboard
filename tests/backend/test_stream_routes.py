from __future__ import annotations

import contextlib
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from ezmsg.dashboard.backend.app import create_app
from ezmsg.dashboard.backend.services.stream_tap import StreamTapError, availability_payload
from ezmsg.dashboard.backend.stream_frames import decode_binary_frame


class FakeTap:
    def __init__(self) -> None:
        self.status = {"topic": "T", "status": "live", "rate_hz": 12.0, "watchers": 1}
        self.inspect = {"type_name": "AxisArray", "is_axisarray": True, "plottable": True}

    def status_payload(self) -> dict[str, Any]:
        return dict(self.status)

    def inspect_payload(self) -> dict[str, Any]:
        return dict(self.inspect)


class FakeTapClient:
    def __init__(self, max_columns: int, mode: str, window_seconds: float) -> None:
        self.tap = FakeTap()
        self.mode = mode
        self.max_columns = max_columns
        self.window_seconds = window_seconds
        self.descriptions: list[dict[str, Any]] = [{"mode": "sweep", "n_channels": 2, "generation": 1}]
        self.frames: list[tuple[dict[str, Any], np.ndarray]] = [
            ({"kind": "stream.data", "mode": "sweep", "n_out": 2, "n_channels": 2}, np.arange(8, dtype=np.float32))
        ]

    def set_max_columns(self, max_columns: int) -> None:
        self.max_columns = max_columns

    def set_window_seconds(self, window_seconds: float) -> None:
        self.window_seconds = window_seconds

    def take_description(self) -> dict[str, Any] | None:
        return self.descriptions.pop(0) if self.descriptions else None

    def take_frame(self) -> tuple[dict[str, Any], np.ndarray] | None:
        return self.frames.pop(0) if self.frames else None


class FakeStreamService:
    """Minimal GraphServiceProtocol implementation for the stream route."""

    def __init__(self) -> None:
        self.opened: list[tuple[str, str, int, float]] = []
        self.clients: list[FakeTapClient] = []
        self.raise_on_open: Exception | None = None

    async def startup(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None

    async def health_payload(self) -> dict[str, Any]:
        return {"status": "ok", "graph_session_active": True, "graph_address": "127.0.0.1:25978"}

    def stream_tap(self, *, topic: str, mode: str, max_columns: int, window_seconds: float):
        if self.raise_on_open is not None:
            raise self.raise_on_open
        self.opened.append((topic, mode, max_columns, window_seconds))

        @contextlib.asynccontextmanager
        async def _client():
            client = FakeTapClient(max_columns=max_columns, mode=mode, window_seconds=window_seconds)
            self.clients.append(client)
            yield client

        return _client()


@pytest.fixture
def service() -> FakeStreamService:
    return FakeStreamService()


@pytest.fixture
def client(service: FakeStreamService):
    # Entered, not just constructed: `app.state.graph_service` is set by the
    # lifespan handler, which TestClient only runs inside its context.
    with TestClient(create_app(service, frontend_dir=None)) as test_client:
        yield test_client


def read_until(websocket: Any, predicate, limit: int = 40) -> Any:
    """Pull frames until one matches, so tests do not depend on pump ordering."""
    for _ in range(limit):
        message = websocket.receive()
        if message.get("type") == "websocket.close":
            raise AssertionError(f"socket closed early: {message}")
        if predicate(message):
            return message
    raise AssertionError("expected frame never arrived")


def is_text_kind(kind: str):
    def check(message: dict[str, Any]) -> bool:
        text = message.get("text")
        return bool(text) and f'"{kind}"' in text

    return check


class TestStreamRoute:
    def test_reports_status_immediately_so_a_silent_topic_is_distinguishable(
        self, client: TestClient, service: FakeStreamService
    ) -> None:
        with client.websocket_connect("/ws/stream?topic=SOURCE/OUTPUT&hz=120") as websocket:
            first = websocket.receive_json()

        assert first["kind"] == "stream.status"
        assert first["data"]["status"] == "live"
        assert service.opened == [("SOURCE/OUTPUT", "auto", 1200, 2.0)]

    def test_sends_the_description_before_any_data(self, client: TestClient) -> None:
        """A frame naming a generation must never outrun the generation itself."""
        with client.websocket_connect("/ws/stream?topic=T&hz=120") as websocket:
            websocket.receive_json()  # opening status
            meta = read_until(websocket, is_text_kind("stream.meta"))
            data = read_until(websocket, lambda message: message.get("bytes") is not None)

        assert '"stream.meta"' in meta["text"]
        header, payload = decode_binary_frame(data["bytes"])
        assert header["kind"] == "stream.data"
        assert header["mode"] == "sweep"
        np.testing.assert_array_equal(payload, np.arange(8, dtype=np.float32))

    def test_periodic_status_and_inspect_frames_arrive(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/stream?topic=T&hz=120") as websocket:
            websocket.receive_json()
            inspect_frame = read_until(websocket, is_text_kind("stream.inspect"), limit=200)

        assert '"is_axisarray":true' in inspect_frame["text"].replace(" ", "")

    def test_client_can_change_its_column_budget_and_window(
        self, client: TestClient, service: FakeStreamService
    ) -> None:
        with client.websocket_connect("/ws/stream?topic=T&hz=120&columns=900&window=1.0") as websocket:
            websocket.receive_json()
            websocket.send_json({"kind": "stream.config", "columns": 250, "window_seconds": 5.0})
            read_until(websocket, is_text_kind("stream.inspect"), limit=200)

        assert service.opened[0][3] == 1.0
        assert service.clients[0].max_columns == 250
        assert service.clients[0].window_seconds == 5.0

    def test_out_of_range_window_is_rejected(self, client: TestClient) -> None:
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/stream?topic=T&window=9999"):
                pass

    def test_garbage_from_the_client_is_ignored_not_fatal(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/stream?topic=T&hz=120") as websocket:
            websocket.receive_json()
            websocket.send_text("not json at all")
            websocket.send_json({"kind": "something.else"})
            read_until(websocket, is_text_kind("stream.inspect"), limit=200)

    def test_inspect_mode_is_passed_through(self, client: TestClient, service: FakeStreamService) -> None:
        with client.websocket_connect("/ws/stream?topic=T&mode=inspect&hz=120") as websocket:
            websocket.receive_json()

        assert service.opened == [("T", "inspect", 1200, 2.0)]

    def test_a_refused_tap_explains_itself_before_closing(self, client: TestClient, service: FakeStreamService) -> None:
        service.raise_on_open = StreamTapError("unknown stream mode 'waterfall'")

        with client.websocket_connect("/ws/stream?topic=T") as websocket:
            error = websocket.receive_json()

        assert error["kind"] == "stream.error"
        assert "waterfall" in error["data"]["message"]

    def test_missing_topic_is_rejected(self, client: TestClient) -> None:
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/stream"):
                pass

    def test_column_budget_is_bounded_by_the_server(self, client: TestClient) -> None:
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/stream?topic=T&columns=999999"):
                pass


class TestAvailability:
    def test_inspector_is_available_even_without_the_viz_extra(self) -> None:
        """The frontend gates its UI on this, so the split has to be explicit."""
        payload = availability_payload()

        assert payload["inspector"] is True
        assert isinstance(payload["plotting"], bool)
        assert payload["max_drawn_channels"] > 0
        assert payload["max_columns"] > 0
        if payload["plotting"]:
            assert payload["reason"] is None
        else:
            assert "ezmsg-tools" in payload["reason"]
