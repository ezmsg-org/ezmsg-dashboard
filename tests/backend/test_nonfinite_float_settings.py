"""Regression tests for https://github.com/ezmsg-org/ezmsg-dashboard/issues/4

A ``Settings`` dataclass may hold non-finite floats (``clip_max: float = np.inf``
is perfectly reasonable), and JSON has no literal for them. Left alone they broke
both transports in different ways: ``JSONResponse`` renders with
``allow_nan=False`` and turned ``/api/settings`` into a 500, while the websocket
envelopes went through pydantic's ``model_dump(mode="json")``, whose default
``ser_json_inf_nan="null"`` silently replaced the values with ``null``.

The dashboard now encodes them as the string tokens ``"Infinity"``,
``"-Infinity"`` and ``"NaN"`` on the way out, and decodes them again on the way
in (see :mod:`ezmsg.dashboard.backend.json_encoding`).
"""

from __future__ import annotations

import json
import math
from collections.abc import AsyncIterator
from typing import Any

import ezmsg.core as ez
import pytest
from ezmsg.core.graphmeta import SettingsSnapshotValue
from ezmsg.core.settingsmeta import (
    settings_repr_value,
    settings_schema_from_value,
    settings_structured_value,
)
from fastapi.testclient import TestClient

from ezmsg.dashboard.backend.app import DashboardJSONResponse, create_app
from ezmsg.dashboard.backend.json_encoding import decode_float_token, encode_float
from ezmsg.dashboard.backend.models.events import SettingsChangedEnvelope
from ezmsg.dashboard.backend.services.adapters import (
    adapt_settings_snapshot,
    adapt_settings_value,
)

COMPONENT_ADDRESS = "SYSTEM/NOISY"


class NonFiniteSettings(ez.Settings):
    """The kind of settings class users actually write."""

    gain: float = 1.0
    clip_max: float = float("inf")
    clip_min: float = float("-inf")
    last_value: float = float("nan")


def _settings_snapshot_value() -> SettingsSnapshotValue:
    """Build a snapshot value exactly the way an ezmsg process would."""
    settings = NonFiniteSettings()
    return SettingsSnapshotValue(
        serialized=None,
        repr_value=settings_repr_value(settings),
        structured_value=settings_structured_value(settings),
        settings_schema=settings_schema_from_value(settings),
    )


def _settings_changed_envelope() -> SettingsChangedEnvelope:
    """Build the envelope the graph service pushes over ``/ws/events``."""
    return SettingsChangedEnvelope(
        kind="settings.changed",
        data={
            "seq": 1,
            "event_type": "INITIAL_SETTINGS",
            "component_address": COMPONENT_ADDRESS,
            "timestamp": 0.0,
            "source_session_id": None,
            "source_process_id": None,
            "value": adapt_settings_value(_settings_snapshot_value()),
        },
    )


def _reject_constant(name: str) -> Any:
    raise AssertionError(f"payload contains non-standard JSON literal {name!r}")


def _loads_strict(text: str) -> Any:
    """Parse like a browser: ``NaN``/``Infinity`` are not valid JSON."""
    return json.loads(text, parse_constant=_reject_constant)


class NonFiniteSettingsService:
    """Graph service stub that only serves the settings of interest."""

    def __init__(self) -> None:
        self._settings = adapt_settings_snapshot({COMPONENT_ADDRESS: _settings_snapshot_value()})

    async def startup(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None

    async def health_payload(self) -> dict[str, Any]:
        return {"status": "ok", "graph_session_active": True, "graph_address": None}

    async def snapshot_payload(self) -> dict[str, Any]:
        return {
            "snapshot": {"graph": {}, "edge_owners": [], "sessions": {}, "processes": {}},
            "settings": self._settings,
            "profiling": {},
        }

    async def settings_payload(self) -> dict[str, Any]:
        return {"settings": self._settings}

    async def update_setting_field(self, **kwargs: Any) -> dict[str, Any]:
        raise NotImplementedError

    async def set_profiling_trace_control(self, **kwargs: Any) -> dict[str, Any]:
        raise NotImplementedError

    async def event_envelopes(self, **kwargs: Any) -> AsyncIterator[dict[str, Any]]:
        # GraphContextLifecycleService serializes envelopes exactly this way.
        yield _settings_changed_envelope().model_dump(mode="json")


def test_encode_float_round_trips_through_tokens() -> None:
    assert encode_float(1.5) == 1.5
    assert encode_float(math.inf) == "Infinity"
    assert encode_float(-math.inf) == "-Infinity"
    assert encode_float(math.nan) == "NaN"

    assert decode_float_token("Infinity") == math.inf
    assert decode_float_token("-Infinity") == -math.inf
    assert math.isnan(decode_float_token("NaN"))
    assert decode_float_token("infinity") is None
    assert decode_float_token(1.5) is None


def test_adapter_encodes_nonfinite_settings_values() -> None:
    adapted = adapt_settings_value(_settings_snapshot_value())

    assert adapted["structured_value"] == {
        "gain": 1.0,
        "clip_max": "Infinity",
        "clip_min": "-Infinity",
        "last_value": "NaN",
    }
    assert adapted["repr_value"] == adapted["structured_value"]

    defaults = {
        field["name"]: field["default"] for field in adapted["settings_schema"]["fields"]
    }
    assert defaults == {
        "gain": 1.0,
        "clip_max": "Infinity",
        "clip_min": "-Infinity",
        "last_value": "NaN",
    }

    json.dumps(adapted, allow_nan=False)  # would raise before the fix


def test_settings_route_serves_nonfinite_floats() -> None:
    with TestClient(create_app(NonFiniteSettingsService())) as client:
        response = client.get("/api/settings")

    assert response.status_code == 200
    structured = _loads_strict(response.text)["settings"][COMPONENT_ADDRESS]["structured_value"]
    assert structured["gain"] == 1.0
    assert structured["clip_max"] == "Infinity"
    assert structured["clip_min"] == "-Infinity"
    assert structured["last_value"] == "NaN"


def test_snapshot_route_serves_nonfinite_floats() -> None:
    with TestClient(create_app(NonFiniteSettingsService())) as client:
        response = client.get("/api/snapshot")

    assert response.status_code == 200
    structured = _loads_strict(response.text)["settings"][COMPONENT_ADDRESS]["structured_value"]
    assert structured["clip_max"] == "Infinity"


def test_events_websocket_preserves_nonfinite_floats() -> None:
    with (
        TestClient(create_app(NonFiniteSettingsService())) as client,
        client.websocket_connect("/ws/events") as websocket,
    ):
        text = websocket.receive_text()

    envelope = _loads_strict(text)
    assert envelope["kind"] == "settings.changed"

    structured = envelope["data"]["value"]["structured_value"]
    assert structured["gain"] == 1.0
    assert structured["clip_max"] == "Infinity"
    assert structured["clip_min"] == "-Infinity"
    assert structured["last_value"] == "NaN"


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"value": math.inf}, {"value": "Infinity"}),
        ({"nested": {"values": [1.0, math.nan]}}, {"nested": {"values": [1.0, "NaN"]}}),
        ({"finite": 2.5, "flag": True, "text": "x"}, {"finite": 2.5, "flag": True, "text": "x"}),
    ],
)
def test_response_class_encodes_payloads_that_bypass_the_adapters(
    payload: dict[str, Any],
    expected: dict[str, Any],
) -> None:
    """Backstop for payloads assembled outside the adapters (e.g. request echoes)."""
    rendered = DashboardJSONResponse(content=payload).body

    assert _loads_strict(rendered.decode()) == expected
