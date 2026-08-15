from __future__ import annotations

import math
from types import SimpleNamespace
from uuid import UUID

import pytest
from ezmsg.core.netprotocol import Address

from ezmsg.dashboard.backend.services.graph_context_service import (
    GraphContextLifecycleService,
    SettingsPatchError,
)


class FakeContext:
    def __init__(self) -> None:
        self.update_calls: list[dict[str, object]] = []
        self.trace_control_calls: list[dict[str, object]] = []
        self.graph_address: str | None = None
        self._profiling_snapshot: dict[UUID, object] = {}
        self._snapshot = SimpleNamespace(
            graph={},
            processes={
                UUID("00000000-0000-0000-0000-000000000123"): SimpleNamespace(units=["unit.patchable"]),
                UUID("00000000-0000-0000-0000-000000000456"): SimpleNamespace(units=["unit.remote"]),
            },
            sessions={
                "session-a": SimpleNamespace(
                    metadata=SimpleNamespace(
                        components={
                            "unit.read_only": SimpleNamespace(dynamic_settings=SimpleNamespace(enabled=False)),
                            "unit.patchable": SimpleNamespace(dynamic_settings=SimpleNamespace(enabled=True)),
                        }
                    )
                )
            },
        )

        self._settings_snapshot = {
            "unit.patchable": SimpleNamespace(
                serialized=None,
                repr_value={"gain": 1.0, "label": "alpha", "filter": {"cutoff": 30.0}},
                structured_value={"gain": 1.0, "label": "alpha", "filter": {"cutoff": 30.0}},
                settings_schema=None,
            )
        }

    async def snapshot(self):
        return self._snapshot

    async def settings_snapshot(self):
        return self._settings_snapshot

    async def profiling_snapshot_all(self, *, timeout_per_process: float):
        _ = timeout_per_process
        return self._profiling_snapshot

    async def update_setting(
        self,
        *,
        component_address: str,
        field_path: str,
        value: object,
        timeout: float,
    ):
        self.update_calls.append(
            {
                "component_address": component_address,
                "field_path": field_path,
                "value": value,
                "timeout": timeout,
            }
        )
        return SimpleNamespace(
            serialized=b"bytes",
            repr_value={"enabled": value},
            structured_value={"enabled": value},
            settings_schema=None,
        )

    async def process_set_profiling_trace(
        self,
        unit_address: str,
        control,
        *,
        timeout: float,
    ):
        self.trace_control_calls.append(
            {
                "unit_address": unit_address,
                "enabled": bool(getattr(control, "enabled", False)),
                "publisher_endpoint_ids": list(getattr(control, "publisher_endpoint_ids", []) or []),
                "publisher_topics": list(getattr(control, "publisher_topics", []) or []),
                "subscriber_topics": list(getattr(control, "subscriber_topics", []) or []),
                "metrics": list(getattr(control, "metrics", []) or []),
                "sample_mod": int(getattr(control, "sample_mod", 0)),
                "ttl_seconds": getattr(control, "ttl_seconds", None),
                "timeout": timeout,
            }
        )
        return SimpleNamespace(ok=True, error=None)


class FakeContextFactory:
    def __init__(self, graph_address=None, auto_start=None) -> None:
        self.graph_address = graph_address
        self.auto_start = auto_start

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None


@pytest.mark.asyncio
async def test_health_payload_defaults_to_canonical_graph_address() -> None:
    service = GraphContextLifecycleService()

    payload = await service.health_payload()

    assert payload["status"] == "ok"
    assert payload["graph_session_active"] is False
    assert payload["graph_address"] == "127.0.0.1:25978"


@pytest.mark.asyncio
async def test_health_payload_prefers_context_graph_address() -> None:
    service = GraphContextLifecycleService(graph_address="10.10.0.1:30000")
    fake_context = FakeContext()
    fake_context.graph_address = "192.168.1.50:25978"
    service._context = fake_context  # controlled test context

    payload = await service.health_payload()

    assert payload["graph_session_active"] is True
    assert payload["graph_address"] == "192.168.1.50:25978"


@pytest.mark.asyncio
async def test_startup_normalizes_string_graph_address_for_graphcontext() -> None:
    captured: dict[str, object] = {}

    def factory(*, graph_address, auto_start):
        captured["graph_address"] = graph_address
        captured["auto_start"] = auto_start
        return FakeContextFactory(graph_address=graph_address, auto_start=auto_start)

    service = GraphContextLifecycleService(
        graph_address="10.10.0.1:30000",
        auto_start=False,
        graph_context_factory=factory,
    )

    await service.startup()
    await service.shutdown()

    assert captured == {
        "graph_address": Address("10.10.0.1", 30000),
        "auto_start": False,
    }


@pytest.mark.asyncio
async def test_update_setting_field_rejects_non_patchable_component() -> None:
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    service._context = fake_context  # controlled test context

    with pytest.raises(SettingsPatchError, match="does not support dynamic settings patches"):
        await service.update_setting_field(
            component_address="unit.read_only",
            field_path="enabled",
            value=True,
            timeout=1.0,
        )

    assert fake_context.update_calls == []


@pytest.mark.asyncio
async def test_update_setting_field_calls_graphcontext_for_patchable_component() -> None:
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    service._context = fake_context  # controlled test context

    payload = await service.update_setting_field(
        component_address="unit.patchable",
        field_path="enabled",
        value=False,
        timeout=1.5,
    )

    assert payload["component_address"] == "unit.patchable"
    assert payload["field_path"] == "enabled"
    assert payload["updated_value"]["structured_value"]["enabled"] is False
    assert fake_context.update_calls == [
        {
            "component_address": "unit.patchable",
            "field_path": "enabled",
            "value": False,
            "timeout": 1.5,
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("token", "expected"),
    [("Infinity", math.inf), ("-Infinity", -math.inf)],
)
async def test_update_setting_field_decodes_non_finite_token_for_numeric_field(
    token: str,
    expected: float,
) -> None:
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    service._context = fake_context  # controlled test context

    await service.update_setting_field(
        component_address="unit.patchable",
        field_path="gain",
        value=token,
        timeout=1.0,
    )

    assert fake_context.update_calls[0]["value"] == expected


@pytest.mark.asyncio
async def test_update_setting_field_decodes_nan_token_for_numeric_field() -> None:
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    service._context = fake_context  # controlled test context

    await service.update_setting_field(
        component_address="unit.patchable",
        field_path="gain",
        value="NaN",
        timeout=1.0,
    )

    assert math.isnan(fake_context.update_calls[0]["value"])


@pytest.mark.asyncio
async def test_update_setting_field_decodes_non_finite_token_for_nested_field() -> None:
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    service._context = fake_context  # controlled test context

    await service.update_setting_field(
        component_address="unit.patchable",
        field_path="filter.cutoff",
        value="Infinity",
        timeout=1.0,
    )

    assert fake_context.update_calls[0]["value"] == math.inf


@pytest.mark.asyncio
async def test_update_setting_field_keeps_token_shaped_string_for_text_field() -> None:
    """A str field set to the literal text "Infinity" must stay a string."""
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    service._context = fake_context  # controlled test context

    with pytest.raises(SettingsPatchError, match="does not currently hold a number"):
        await service.update_setting_field(
            component_address="unit.patchable",
            field_path="label",
            value="Infinity",
            timeout=1.0,
        )

    assert fake_context.update_calls == []


@pytest.mark.asyncio
async def test_update_setting_field_rejects_non_finite_token_for_unknown_field() -> None:
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    service._context = fake_context  # controlled test context

    with pytest.raises(SettingsPatchError, match="does not currently hold a number"):
        await service.update_setting_field(
            component_address="unit.patchable",
            field_path="not_a_field",
            value="NaN",
            timeout=1.0,
        )

    assert fake_context.update_calls == []


@pytest.mark.asyncio
async def test_update_setting_field_skips_settings_lookup_for_ordinary_values() -> None:
    """The extra snapshot round-trip is only paid when a token is being applied."""
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    fake_context.settings_snapshot = None  # would raise if called
    service._context = fake_context  # controlled test context

    await service.update_setting_field(
        component_address="unit.patchable",
        field_path="gain",
        value=2.5,
        timeout=1.0,
    )

    assert fake_context.update_calls[0]["value"] == 2.5


@pytest.mark.asyncio
async def test_set_profiling_trace_control_routes_to_process_unit() -> None:
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    service._context = fake_context  # controlled test context

    payload = await service.set_profiling_trace_control(
        process_id="00000000-0000-0000-0000-000000000123",
        enabled=True,
        publisher_endpoint_id="TOPIC:pub",
        publisher_topic="TOPIC",
        subscriber_topic="TOPIC",
        metrics=["publish_delta_ns", "lease_time_ns"],
        sample_mod=1,
        ttl_seconds=12.0,
        timeout=1.25,
    )

    assert payload["process_id"] == "00000000-0000-0000-0000-000000000123"
    assert payload["unit_address"] == "unit.patchable"
    assert payload["enabled"] is True
    assert fake_context.trace_control_calls == [
        {
            "unit_address": "unit.patchable",
            "enabled": True,
            "publisher_endpoint_ids": ["TOPIC:pub"],
            "publisher_topics": ["TOPIC"],
            "subscriber_topics": ["TOPIC"],
            "metrics": ["publish_delta_ns", "lease_time_ns"],
            "sample_mod": 1,
            "ttl_seconds": 12.0,
            "timeout": 1.25,
        }
    ]


@pytest.mark.asyncio
async def test_set_profiling_trace_control_without_subscriber_topic_has_no_filter() -> None:
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    service._context = fake_context  # controlled test context

    payload = await service.set_profiling_trace_control(
        process_id="00000000-0000-0000-0000-000000000123",
        enabled=True,
        publisher_endpoint_id="TOPIC:pub",
        publisher_topic="TOPIC",
        subscriber_topic=None,
        metrics=["publish_delta_ns", "lease_time_ns"],
        sample_mod=1,
        ttl_seconds=12.0,
        timeout=1.25,
    )

    assert payload["process_id"] == "00000000-0000-0000-0000-000000000123"
    assert fake_context.trace_control_calls == [
        {
            "unit_address": "unit.patchable",
            "enabled": True,
            "publisher_endpoint_ids": ["TOPIC:pub"],
            "publisher_topics": ["TOPIC"],
            "subscriber_topics": [],
            "metrics": ["publish_delta_ns", "lease_time_ns"],
            "sample_mod": 1,
            "ttl_seconds": 12.0,
            "timeout": 1.25,
        }
    ]


@pytest.mark.asyncio
async def test_set_profiling_trace_control_fans_out_subscriber_metrics_across_processes() -> None:
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    fake_context._profiling_snapshot = {
        UUID("00000000-0000-0000-0000-000000000123"): SimpleNamespace(subscribers={}),
        UUID("00000000-0000-0000-0000-000000000456"): SimpleNamespace(
            subscribers={
                "sub.remote": SimpleNamespace(topic="TOPIC"),
            }
        ),
    }
    service._context = fake_context  # controlled test context

    payload = await service.set_profiling_trace_control(
        process_id="00000000-0000-0000-0000-000000000123",
        enabled=True,
        publisher_endpoint_id="TOPIC:pub",
        publisher_topic="TOPIC",
        subscriber_topic=None,
        metrics=[
            "publish_delta_ns",
            "lease_time_ns",
            "user_span_ns",
        ],
        sample_mod=1,
        ttl_seconds=12.0,
        timeout=1.25,
    )

    assert payload["process_id"] == "00000000-0000-0000-0000-000000000123"
    assert set(payload["unit_addresses"]) == {"unit.patchable", "unit.remote"}
    calls_by_unit = {call["unit_address"]: call for call in fake_context.trace_control_calls}
    assert set(calls_by_unit.keys()) == {"unit.patchable", "unit.remote"}
    assert calls_by_unit["unit.patchable"] == {
        "unit_address": "unit.patchable",
        "enabled": True,
        "publisher_endpoint_ids": ["TOPIC:pub"],
        "publisher_topics": ["TOPIC"],
        "subscriber_topics": [],
        "metrics": [
            "publish_delta_ns",
            "lease_time_ns",
            "user_span_ns",
        ],
        "sample_mod": 1,
        "ttl_seconds": 12.0,
        "timeout": 1.25,
    }
    assert calls_by_unit["unit.remote"] == {
        "unit_address": "unit.remote",
        "enabled": True,
        "publisher_endpoint_ids": [],
        "publisher_topics": [],
        "subscriber_topics": ["TOPIC"],
        "metrics": ["lease_time_ns", "user_span_ns"],
        "sample_mod": 1,
        "ttl_seconds": 12.0,
        "timeout": 1.25,
    }


@pytest.mark.asyncio
async def test_set_profiling_trace_control_disable_disables_all_active_route_units() -> None:
    service = GraphContextLifecycleService()
    fake_context = FakeContext()
    fake_context._profiling_snapshot = {
        UUID("00000000-0000-0000-0000-000000000456"): SimpleNamespace(
            subscribers={
                "sub.remote": SimpleNamespace(topic="TOPIC"),
            }
        ),
    }
    service._context = fake_context  # controlled test context

    await service.set_profiling_trace_control(
        process_id="00000000-0000-0000-0000-000000000123",
        enabled=True,
        publisher_endpoint_id="TOPIC:pub",
        publisher_topic="TOPIC",
        subscriber_topic=None,
        metrics=[
            "publish_delta_ns",
            "lease_time_ns",
            "user_span_ns",
        ],
        sample_mod=1,
        ttl_seconds=12.0,
        timeout=1.25,
    )
    fake_context.trace_control_calls.clear()

    payload = await service.set_profiling_trace_control(
        process_id="00000000-0000-0000-0000-000000000123",
        enabled=False,
        publisher_endpoint_id=None,
        publisher_topic=None,
        subscriber_topic=None,
        metrics=None,
        sample_mod=1,
        ttl_seconds=12.0,
        timeout=1.25,
    )

    assert payload["enabled"] is False
    assert set(payload["unit_addresses"]) == {"unit.patchable", "unit.remote"}
    assert len(fake_context.trace_control_calls) == 2
    assert {call["unit_address"] for call in fake_context.trace_control_calls} == {
        "unit.patchable",
        "unit.remote",
    }
    for call in fake_context.trace_control_calls:
        assert call["enabled"] is False
