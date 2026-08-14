from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

from fastapi.testclient import TestClient

from ezmsg.dashboard.backend.app import create_app


class FakeGraphService:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.raise_patch_error = False
        self.raise_trace_control_error = False
        self.last_patch_request: dict[str, object] | None = None
        self.last_trace_control_request: dict[str, object] | None = None

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

    async def set_profiling_trace_control(
        self,
        *,
        process_id: str,
        enabled: bool,
        publisher_endpoint_id: str | None,
        publisher_topic: str | None,
        subscriber_topic: str | None,
        metrics: list[str] | None,
        sample_mod: int,
        ttl_seconds: float | None,
        timeout: float,
    ) -> dict[str, object]:
        self.last_trace_control_request = {
            "process_id": process_id,
            "enabled": enabled,
            "publisher_endpoint_id": publisher_endpoint_id,
            "publisher_topic": publisher_topic,
            "subscriber_topic": subscriber_topic,
            "metrics": metrics,
            "sample_mod": sample_mod,
            "ttl_seconds": ttl_seconds,
            "timeout": timeout,
        }
        if self.raise_trace_control_error:
            raise RuntimeError("Process trace control rejected.")
        return {
            "process_id": process_id,
            "unit_address": "SYS/U_TRACE",
            "enabled": enabled,
            "control": {
                "publisher_endpoint_ids": [publisher_endpoint_id] if publisher_endpoint_id else [],
                "publisher_topics": [publisher_topic] if publisher_topic else [],
                "subscriber_topics": [subscriber_topic] if subscriber_topic else [],
                "metrics": metrics or [],
                "sample_mod": sample_mod,
                "ttl_seconds": ttl_seconds,
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


def test_frontend_index_route_serves_packaged_assets(tmp_path: Path) -> None:
    frontend_dir = tmp_path / "frontend"
    frontend_dir.mkdir()
    (frontend_dir / "index.html").write_text(
        "<!doctype html><html><body><div id='root'>dashboard</div></body></html>",
        encoding="utf-8",
    )

    app = create_app(FakeGraphService(), frontend_dir=frontend_dir)
    with TestClient(app) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "dashboard" in response.text


def test_frontend_static_assets_are_served_without_shadowing_api(tmp_path: Path) -> None:
    frontend_dir = tmp_path / "frontend"
    assets_dir = frontend_dir / "assets"
    assets_dir.mkdir(parents=True)
    (frontend_dir / "index.html").write_text(
        "<!doctype html><html><body><script src='/assets/app.js'></script></body></html>",
        encoding="utf-8",
    )
    (assets_dir / "app.js").write_text("console.log('dashboard');", encoding="utf-8")

    app = create_app(FakeGraphService(), frontend_dir=frontend_dir)
    with TestClient(app) as client:
        asset_response = client.get("/assets/app.js")
        api_response = client.get("/api/health")

    assert asset_response.status_code == 200
    assert "dashboard" in asset_response.text
    assert api_response.status_code == 200
    assert api_response.json()["status"] == "ok"


def test_frontend_fallback_does_not_mask_unknown_api_routes(tmp_path: Path) -> None:
    frontend_dir = tmp_path / "frontend"
    frontend_dir.mkdir()
    (frontend_dir / "index.html").write_text(
        "<!doctype html><html><body><div id='root'>dashboard</div></body></html>",
        encoding="utf-8",
    )

    app = create_app(FakeGraphService(), frontend_dir=frontend_dir)
    with TestClient(app) as client:
        response = client.get("/api/does-not-exist")

    assert response.status_code == 404


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


def test_profiling_trace_control_route_success() -> None:
    fake_service = FakeGraphService()
    app = create_app(fake_service)
    with TestClient(app) as client:
        response = client.post(
            "/api/profiling/trace-control",
            json={
                "process_id": "3b0ddec4-0000-0000-0000-000000000000",
                "enabled": True,
                "publisher_endpoint_id": "TOPIC:pub",
                "publisher_topic": "TOPIC",
                "subscriber_topic": "TOPIC",
                "metrics": ["publish_delta_ns", "lease_time_ns"],
                "sample_mod": 1,
                "ttl_seconds": 15.0,
                "timeout": 1.0,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["process_id"] == "3b0ddec4-0000-0000-0000-000000000000"
    assert payload["enabled"] is True
    assert response.headers["cache-control"].startswith("no-store")
    assert fake_service.last_trace_control_request == {
        "process_id": "3b0ddec4-0000-0000-0000-000000000000",
        "enabled": True,
        "publisher_endpoint_id": "TOPIC:pub",
        "publisher_topic": "TOPIC",
        "subscriber_topic": "TOPIC",
        "metrics": ["publish_delta_ns", "lease_time_ns"],
        "sample_mod": 1,
        "ttl_seconds": 15.0,
        "timeout": 1.0,
    }


def test_profiling_trace_control_route_error() -> None:
    fake_service = FakeGraphService()
    fake_service.raise_trace_control_error = True
    app = create_app(fake_service)
    with TestClient(app) as client:
        response = client.post(
            "/api/profiling/trace-control",
            json={
                "process_id": "3b0ddec4-0000-0000-0000-000000000000",
                "enabled": True,
            },
        )

    assert response.status_code == 422
    payload = response.json()
    assert "trace control" in payload["detail"].lower()
