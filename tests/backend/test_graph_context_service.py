from __future__ import annotations

from types import SimpleNamespace

import pytest

from ezmsg.dashboard.backend.services.graph_context_service import (
    GraphContextLifecycleService,
    SettingsPatchError,
)


class FakeContext:
    def __init__(self) -> None:
        self.update_calls: list[dict[str, object]] = []
        self._snapshot = SimpleNamespace(
            sessions={
                "session-a": SimpleNamespace(
                    metadata=SimpleNamespace(
                        components={
                            "unit.read_only": SimpleNamespace(
                                dynamic_settings=SimpleNamespace(enabled=False)
                            ),
                            "unit.patchable": SimpleNamespace(
                                dynamic_settings=SimpleNamespace(enabled=True)
                            ),
                        }
                    )
                )
            }
        )

    async def snapshot(self):
        return self._snapshot

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
