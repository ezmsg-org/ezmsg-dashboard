from __future__ import annotations

import dataclasses
import enum
from typing import Any, Mapping
from uuid import UUID

from ezmsg.core.graphmeta import (
    GraphSnapshot,
    ProcessProfilingSnapshot,
    ProfilingTraceStreamBatch,
    SettingsChangedEvent,
    SettingsSnapshotValue,
    TopologyChangedEvent,
)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value

    if isinstance(value, UUID):
        return str(value)

    if isinstance(value, enum.Enum):
        return value.value

    if isinstance(value, bytes):
        # Keep the browser protocol free from pickled payloads.
        return None

    if dataclasses.is_dataclass(value):
        return {
            field.name: _json_safe(getattr(value, field.name))
            for field in dataclasses.fields(value)
        }

    if isinstance(value, Mapping):
        return {str(_json_safe(k)): _json_safe(v) for k, v in value.items()}

    if isinstance(value, tuple) and hasattr(value, "_fields"):
        return {
            field_name: _json_safe(getattr(value, field_name))
            for field_name in value._fields
        }

    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]

    return value


def adapt_graph_snapshot(snapshot: GraphSnapshot) -> dict[str, Any]:
    edge_owners = [
        {
            "edge": {
                "from_topic": edge.from_topic,
                "to_topic": edge.to_topic,
            },
            "owner_session_ids": owners,
        }
        for edge, owners in snapshot.edge_owners.items()
    ]

    sessions = {
        session_id: {
            "edges": [
                {
                    "from_topic": edge.from_topic,
                    "to_topic": edge.to_topic,
                }
                for edge in session.edges
            ],
            "metadata": _json_safe(session.metadata),
        }
        for session_id, session in snapshot.sessions.items()
    }

    processes = {
        str(process_id): _json_safe(process)
        for process_id, process in snapshot.processes.items()
    }

    return {
        "graph": _json_safe(snapshot.graph),
        "edge_owners": edge_owners,
        "sessions": sessions,
        "processes": processes,
    }


def adapt_settings_value(value: SettingsSnapshotValue) -> dict[str, Any]:
    return {
        "repr_value": _json_safe(value.repr_value),
        "structured_value": _json_safe(value.structured_value),
        "settings_schema": _json_safe(value.settings_schema),
        "serialized_present": value.serialized is not None,
    }


def adapt_settings_snapshot(
    snapshot: Mapping[str, SettingsSnapshotValue],
) -> dict[str, dict[str, Any]]:
    return {
        component_address: adapt_settings_value(value)
        for component_address, value in snapshot.items()
    }


def adapt_profiling_snapshot(
    snapshot: Mapping[UUID, ProcessProfilingSnapshot],
) -> dict[str, Any]:
    return {str(process_id): _json_safe(value) for process_id, value in snapshot.items()}


def adapt_topology_event(event: TopologyChangedEvent) -> dict[str, Any]:
    return {
        "seq": event.seq,
        "event_type": event.event_type.value,
        "timestamp": event.timestamp,
        "changed_topics": list(event.changed_topics),
        "source_session_id": event.source_session_id,
        "source_process_id": (
            str(event.source_process_id) if event.source_process_id is not None else None
        ),
    }


def adapt_settings_event(event: SettingsChangedEvent) -> dict[str, Any]:
    return {
        "seq": event.seq,
        "event_type": event.event_type.value,
        "component_address": event.component_address,
        "timestamp": event.timestamp,
        "source_session_id": event.source_session_id,
        "source_process_id": (
            str(event.source_process_id) if event.source_process_id is not None else None
        ),
        "value": adapt_settings_value(event.value),
    }


def adapt_profiling_trace_batch(batch: ProfilingTraceStreamBatch) -> dict[str, Any]:
    return {
        "timestamp": batch.timestamp,
        "batches": {str(process_id): _json_safe(data) for process_id, data in batch.batches.items()},
    }
