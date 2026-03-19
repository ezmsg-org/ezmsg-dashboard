from __future__ import annotations

import asyncio
import contextlib
import time
from typing import Any, AsyncIterator, Callable, Protocol

from ezmsg.core.graphcontext import GraphContext
from ezmsg.core.graphmeta import GraphSnapshot, ProfilingStreamControl

from ..models.events import (
    EventEnvelopeModel,
    ProfilingTraceEnvelope,
    SettingsChangedEnvelope,
    SystemErrorEnvelope,
    SystemHeartbeatEnvelope,
    SystemReadyEnvelope,
    TopologyChangedEnvelope,
)
from .adapters import (
    adapt_graph_snapshot,
    adapt_profiling_snapshot,
    adapt_profiling_trace_batch,
    adapt_settings_value,
    adapt_settings_event,
    adapt_settings_snapshot,
    adapt_topology_event,
)


class GraphServiceUnavailableError(RuntimeError):
    """Raised when GraphContext lifecycle service is not currently active."""


class SettingsPatchError(RuntimeError):
    """Raised when a settings patch request fails in GraphContext."""


class GraphServiceProtocol(Protocol):
    async def startup(self) -> None: ...

    async def shutdown(self) -> None: ...

    async def health_payload(self) -> dict[str, Any]: ...

    async def snapshot_payload(self) -> dict[str, Any]: ...

    async def settings_payload(self) -> dict[str, Any]: ...

    async def update_setting_field(
        self,
        *,
        component_address: str,
        field_path: str,
        value: Any,
        timeout: float,
    ) -> dict[str, Any]: ...

    async def event_envelopes(
        self,
        *,
        topology_after_seq: int,
        settings_after_seq: int,
        profiling_interval: float,
        profiling_max_samples: int,
    ) -> AsyncIterator[dict[str, Any]]: ...


class GraphContextLifecycleService:
    def __init__(
        self,
        *,
        graph_address: Any = None,
        auto_start: bool | None = None,
        heartbeat_seconds: float = 10.0,
        queue_size: int = 512,
        graph_context_factory: Callable[..., GraphContext] = GraphContext,
    ) -> None:
        self._graph_address = graph_address
        self._auto_start = auto_start
        self._heartbeat_seconds = heartbeat_seconds
        self._queue_size = queue_size
        self._graph_context_factory = graph_context_factory
        self._startup_lock = asyncio.Lock()
        self._shutdown_lock = asyncio.Lock()
        self._context: GraphContext | None = None

    @property
    def is_started(self) -> bool:
        return self._context is not None

    async def startup(self) -> None:
        async with self._startup_lock:
            if self._context is not None:
                return
            context = self._graph_context_factory(
                graph_address=self._graph_address,
                auto_start=self._auto_start,
            )
            await context.__aenter__()
            self._context = context

    async def shutdown(self) -> None:
        async with self._shutdown_lock:
            context = self._context
            if context is None:
                return
            self._context = None
            await context.__aexit__(None, None, None)

    def _require_context(self) -> GraphContext:
        if self._context is None:
            raise GraphServiceUnavailableError("GraphContext is not active.")
        return self._context

    async def health_payload(self) -> dict[str, Any]:
        context = self._context
        return {
            "status": "ok",
            "graph_session_active": context is not None,
            "graph_address": str(context.graph_address) if context is not None else None,
        }

    async def snapshot_payload(self) -> dict[str, Any]:
        context = self._require_context()
        graph_snapshot, settings_snapshot, profiling_snapshot = await asyncio.gather(
            context.snapshot(),
            context.settings_snapshot(),
            context.profiling_snapshot_all(),
        )
        settings_with_patchability = self._settings_with_patchability(
            settings_snapshot=settings_snapshot,
            graph_snapshot=graph_snapshot,
        )
        return {
            "snapshot": adapt_graph_snapshot(graph_snapshot),
            "settings": settings_with_patchability,
            "profiling": adapt_profiling_snapshot(profiling_snapshot),
        }

    async def settings_payload(self) -> dict[str, Any]:
        context = self._require_context()
        settings_snapshot, graph_snapshot = await asyncio.gather(
            context.settings_snapshot(),
            context.snapshot(),
        )
        settings_with_patchability = self._settings_with_patchability(
            settings_snapshot=settings_snapshot,
            graph_snapshot=graph_snapshot,
        )
        return {"settings": settings_with_patchability}

    async def update_setting_field(
        self,
        *,
        component_address: str,
        field_path: str,
        value: Any,
        timeout: float = 2.0,
    ) -> dict[str, Any]:
        context = self._require_context()
        graph_snapshot = await context.snapshot()
        if not self._component_is_patchable(graph_snapshot, component_address):
            raise SettingsPatchError(
                f"Component '{component_address}' does not support dynamic settings patches."
            )
        try:
            updated_value = await context.update_setting(
                component_address=component_address,
                field_path=field_path,
                value=value,
                timeout=timeout,
            )
        except Exception as exc:
            raise SettingsPatchError(str(exc)) from exc

        return {
            "component_address": component_address,
            "field_path": field_path,
            "updated_value": adapt_settings_value(updated_value),
        }

    def _settings_with_patchability(
        self,
        *,
        settings_snapshot: dict[str, Any],
        graph_snapshot: GraphSnapshot,
    ) -> dict[str, dict[str, Any]]:
        patchability = self._patchability_by_component(graph_snapshot)
        adapted = adapt_settings_snapshot(settings_snapshot)
        out: dict[str, dict[str, Any]] = {}
        for component_address, value in adapted.items():
            patchable = patchability.get(component_address, False)
            out[component_address] = {
                **value,
                "patchable": patchable,
                "patch_error": (
                    None
                    if patchable
                    else "Read-only: component does not expose dynamic settings."
                ),
            }
        return out

    def _component_is_patchable(
        self,
        graph_snapshot: GraphSnapshot,
        component_address: str,
    ) -> bool:
        return self._patchability_by_component(graph_snapshot).get(component_address, False)

    def _patchability_by_component(
        self,
        graph_snapshot: GraphSnapshot,
    ) -> dict[str, bool]:
        patchability: dict[str, bool] = {}
        for session in graph_snapshot.sessions.values():
            metadata = session.metadata
            if metadata is None:
                continue
            for component_address, component in metadata.components.items():
                dynamic_settings = getattr(component, "dynamic_settings", None)
                enabled = bool(
                    dynamic_settings is not None
                    and getattr(dynamic_settings, "enabled", False)
                )
                patchability[component_address] = patchability.get(component_address, False) or enabled
        return patchability

    async def event_envelopes(
        self,
        *,
        topology_after_seq: int = 0,
        settings_after_seq: int = 0,
        profiling_interval: float = 0.2,
        profiling_max_samples: int = 1000,
    ) -> AsyncIterator[dict[str, Any]]:
        context = self._require_context()
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._queue_size)

        async def enqueue(item: EventEnvelopeModel) -> None:
            payload = item.model_dump(mode="json")
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                queue.put_nowait(payload)

        async def topology_worker() -> None:
            try:
                async for event in context.subscribe_topology_events(after_seq=topology_after_seq):
                    await enqueue(
                        TopologyChangedEnvelope(
                            kind="topology.changed",
                            data=adapt_topology_event(event),
                        )
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await enqueue_error(f"topology stream stopped: {exc}")

        async def settings_worker() -> None:
            try:
                async for event in context.subscribe_settings_events(after_seq=settings_after_seq):
                    await enqueue(
                        SettingsChangedEnvelope(
                            kind="settings.changed",
                            data=adapt_settings_event(event),
                        )
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await enqueue_error(f"settings stream stopped: {exc}")

        async def profiling_worker() -> None:
            control = ProfilingStreamControl(
                interval=profiling_interval,
                max_samples=profiling_max_samples,
            )
            try:
                async for batch in context.subscribe_profiling_trace(control):
                    await enqueue(
                        ProfilingTraceEnvelope(
                            kind="profiling.trace",
                            data=adapt_profiling_trace_batch(batch),
                        )
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await enqueue_error(f"profiling stream stopped: {exc}")

        async def enqueue_error(message: str) -> None:
            await enqueue(
                SystemErrorEnvelope(
                    kind="system.error",
                    data={"timestamp": time.time(), "message": message},
                )
            )

        workers = [
            asyncio.create_task(topology_worker(), name="dashboard-topology-events"),
            asyncio.create_task(settings_worker(), name="dashboard-settings-events"),
            asyncio.create_task(profiling_worker(), name="dashboard-profiling-events"),
        ]

        try:
            yield SystemReadyEnvelope(
                kind="system.ready",
                data={
                    "timestamp": time.time(),
                    "message": "Subscriptions active.",
                },
            ).model_dump(mode="json")

            while True:
                try:
                    message = await asyncio.wait_for(
                        queue.get(),
                        timeout=self._heartbeat_seconds,
                    )
                    yield message
                except TimeoutError:
                    heartbeat = SystemHeartbeatEnvelope(
                        kind="system.heartbeat",
                        data={"timestamp": time.time()},
                    )
                    yield heartbeat.model_dump(mode="json")
        finally:
            for worker in workers:
                worker.cancel()
            for worker in workers:
                with contextlib.suppress(asyncio.CancelledError):
                    await worker
