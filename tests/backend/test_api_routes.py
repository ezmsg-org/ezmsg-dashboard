from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi.testclient import TestClient

from ezmsg.dashboard.backend.app import create_app


class FakeGraphService:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.raise_patch_error = False
        self.last_patch_request: dict[str, object] | None = None

    async def startup(self) -> None:
        self.started = True

    async def shutdown(self) -> None:
        self.stopped = True

    async def health_payload(self) -> dict[str, object]:
        return {
            "status": "ok",
            "graph_session_active": self.started and not self.stopped,
            "graph_address": "tcp://127.0.0.1:12345",
        }

    async def snapshot_payload(self) -> dict[str, object]:
        return {
            "snapshot": {"graph": {"a": ["b"]}, "edge_owners": [], "sessions": {}, "processes": {}},
            "settings": {
                "unit.alpha": {
                    "repr_value": {"enabled": True},
                    "structured_value": {"enabled": True},
                    "settings_schema": None,
                    "serialized_present": True,
                }
            },
            "profiling": {},
        }

    async def settings_payload(self) -> dict[str, object]:
        return {
            "settings": {
                "unit.alpha": {
                    "repr_value": {"enabled": True},
                    "structured_value": {"enabled": True},
                    "settings_schema": None,
                    "serialized_present": True,
                }
            }
        }

    async def update_setting_field(
        self,
        *,
        component_address: str,
        field_path: str,
        value: object,
        timeout: float,
    ) -> dict[str, object]:
        self.last_patch_request = {
            "component_address": component_address,
            "field_path": field_path,
            "value": value,
            "timeout": timeout,
        }
        if self.raise_patch_error:
            raise RuntimeError("Invalid field path: not_a_real_field")
        return {
            "component_address": component_address,
            "field_path": field_path,
            "updated_value": {
                "repr_value": {"enabled": value},
                "structured_value": {"enabled": value},
                "settings_schema": None,
                "serialized_present": True,
            },
        }

    async def event_envelopes(
        self,
        *,
        topology_after_seq: int,
        settings_after_seq: int,
        profiling_interval: float,
        profiling_max_samples: int,
    ) -> AsyncIterator[dict[str, object]]:
        _ = (
            topology_after_seq,
            settings_after_seq,
            profiling_interval,
            profiling_max_samples,
        )
        yield {
            "kind": "system.ready",
            "data": {"timestamp": 1.0, "message": "Subscriptions active."},
        }
        yield {
            "kind": "topology.changed",
            "data": {
                "seq": 5,
                "event_type": "GRAPH_CHANGED",
                "timestamp": 2.0,
                "changed_topics": ["topic/demo"],
                "source_session_id": None,
                "source_process_id": None,
            },
        }


def test_health_route() -> None:
    fake_service = FakeGraphService()
    app = create_app(fake_service)

    with TestClient(app) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["graph_session_active"] is True
    assert response.headers["cache-control"].startswith("no-store")
    assert fake_service.started is True
    assert fake_service.stopped is True


def test_snapshot_route() -> None:
    app = create_app(FakeGraphService())
    with TestClient(app) as client:
        response = client.get("/api/snapshot")

    assert response.status_code == 200
    payload = response.json()
    assert "snapshot" in payload
    assert "settings" in payload
    assert "profiling" in payload
    assert response.headers["cache-control"].startswith("no-store")
    assert payload["settings"]["unit.alpha"]["serialized_present"] is True


def test_settings_route() -> None:
    app = create_app(FakeGraphService())
    with TestClient(app) as client:
        response = client.get("/api/settings")

    assert response.status_code == 200
    payload = response.json()
    assert response.headers["cache-control"].startswith("no-store")
    assert payload["settings"]["unit.alpha"]["repr_value"]["enabled"] is True


def test_events_websocket_route() -> None:
    app = create_app(FakeGraphService())
    with TestClient(app) as client:
        with client.websocket_connect("/ws/events") as websocket:
            first = websocket.receive_json()
            second = websocket.receive_json()

    assert first["kind"] == "system.ready"
    assert second["kind"] == "topology.changed"


def test_patch_settings_route_success() -> None:
    fake_service = FakeGraphService()
    app = create_app(fake_service)
    with TestClient(app) as client:
        response = client.post(
            "/api/settings/unit.alpha/field",
            json={
                "field_path": "enabled",
                "value": False,
                "timeout": 1.5,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert response.headers["cache-control"].startswith("no-store")
    assert payload["component_address"] == "unit.alpha"
    assert payload["field_path"] == "enabled"
    assert payload["updated_value"]["structured_value"]["enabled"] is False
    assert fake_service.last_patch_request == {
        "component_address": "unit.alpha",
        "field_path": "enabled",
        "value": False,
        "timeout": 1.5,
    }


def test_patch_settings_route_invalid_field_path() -> None:
    fake_service = FakeGraphService()
    fake_service.raise_patch_error = True
    app = create_app(fake_service)
    with TestClient(app) as client:
        response = client.post(
            "/api/settings/unit.alpha/field",
            json={
                "field_path": "does.not.exist",
                "value": 123,
            },
        )

    assert response.status_code == 422
    payload = response.json()
    assert "Invalid field path" in payload["detail"]
