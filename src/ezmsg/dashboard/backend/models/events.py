from __future__ import annotations

from typing import Any, Literal, TypeAlias

from pydantic import BaseModel


class TopologyChangedPayload(BaseModel):
    seq: int
    event_type: str
    timestamp: float
    changed_topics: list[str]
    source_session_id: str | None = None
    source_process_id: str | None = None


class SettingsValuePayload(BaseModel):
    repr_value: dict[str, Any] | str
    structured_value: dict[str, Any] | None = None
    settings_schema: dict[str, Any] | None = None
    serialized_present: bool = False


class SettingsChangedPayload(BaseModel):
    seq: int
    event_type: str
    component_address: str
    timestamp: float
    source_session_id: str | None = None
    source_process_id: str | None = None
    value: SettingsValuePayload


class ProfilingTracePayload(BaseModel):
    timestamp: float
    batches: dict[str, dict[str, Any]]


class SystemReadyPayload(BaseModel):
    timestamp: float
    message: str


class SystemHeartbeatPayload(BaseModel):
    timestamp: float


class SystemErrorPayload(BaseModel):
    timestamp: float
    message: str


class TopologyChangedEnvelope(BaseModel):
    kind: Literal["topology.changed"]
    data: TopologyChangedPayload


class SettingsChangedEnvelope(BaseModel):
    kind: Literal["settings.changed"]
    data: SettingsChangedPayload


class ProfilingTraceEnvelope(BaseModel):
    kind: Literal["profiling.trace"]
    data: ProfilingTracePayload


class SystemReadyEnvelope(BaseModel):
    kind: Literal["system.ready"]
    data: SystemReadyPayload


class SystemHeartbeatEnvelope(BaseModel):
    kind: Literal["system.heartbeat"]
    data: SystemHeartbeatPayload


class SystemErrorEnvelope(BaseModel):
    kind: Literal["system.error"]
    data: SystemErrorPayload


EventEnvelopeModel: TypeAlias = (
    TopologyChangedEnvelope
    | SettingsChangedEnvelope
    | ProfilingTraceEnvelope
    | SystemReadyEnvelope
    | SystemHeartbeatEnvelope
    | SystemErrorEnvelope
)
