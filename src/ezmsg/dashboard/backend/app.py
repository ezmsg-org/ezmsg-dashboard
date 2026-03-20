from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .models.events import SystemErrorEnvelope
from .services import GraphContextLifecycleService, GraphServiceProtocol
from .services.graph_context_service import (
    GraphServiceUnavailableError,
    ProfilingTraceControlError,
    SettingsPatchError,
)

NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


def get_graph_service(request: Request) -> GraphServiceProtocol:
    service = getattr(request.app.state, "graph_service", None)
    if service is None:
        raise RuntimeError("Graph service is not configured.")
    return service


GraphServiceDependency = Annotated[GraphServiceProtocol, Depends(get_graph_service)]


class SettingsFieldPatchRequest(BaseModel):
    field_path: str = Field(min_length=1)
    value: Any
    timeout: float = Field(default=2.0, gt=0.0)


class ProfilingTraceControlRequest(BaseModel):
    process_id: str = Field(min_length=1)
    enabled: bool = True
    publisher_endpoint_id: str | None = None
    publisher_topic: str | None = None
    subscriber_topic: str | None = None
    metrics: list[str] | None = None
    sample_mod: int = Field(default=1, ge=1)
    ttl_seconds: float | None = Field(default=30.0, gt=0.0)
    timeout: float = Field(default=2.0, gt=0.0)


def create_app(graph_service: GraphServiceProtocol | None = None) -> FastAPI:
    service = graph_service or GraphContextLifecycleService()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.graph_service = service
        await service.startup()
        try:
            yield
        finally:
            await service.shutdown()

    app = FastAPI(title="ezmsg Dashboard Backend", lifespan=lifespan)

    @app.get("/api/health")
    async def api_health(graph_service: GraphServiceDependency) -> JSONResponse:
        payload = await graph_service.health_payload()
        return JSONResponse(content=payload, headers=NO_CACHE_HEADERS)

    @app.get("/api/snapshot")
    async def api_snapshot(graph_service: GraphServiceDependency) -> JSONResponse:
        try:
            payload = await graph_service.snapshot_payload()
        except GraphServiceUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return JSONResponse(content=payload, headers=NO_CACHE_HEADERS)

    @app.get("/api/settings")
    async def api_settings(graph_service: GraphServiceDependency) -> JSONResponse:
        try:
            payload = await graph_service.settings_payload()
        except GraphServiceUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return JSONResponse(content=payload, headers=NO_CACHE_HEADERS)

    @app.post("/api/settings/{component_address:path}/field")
    async def api_patch_setting_field(
        component_address: str,
        body: SettingsFieldPatchRequest,
        graph_service: GraphServiceDependency,
    ) -> JSONResponse:
        try:
            payload = await graph_service.update_setting_field(
                component_address=component_address,
                field_path=body.field_path,
                value=body.value,
                timeout=body.timeout,
            )
        except GraphServiceUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except (SettingsPatchError, RuntimeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return JSONResponse(content=payload, headers=NO_CACHE_HEADERS)

    @app.post("/api/profiling/trace-control")
    async def api_profiling_trace_control(
        body: ProfilingTraceControlRequest,
        graph_service: GraphServiceDependency,
    ) -> JSONResponse:
        try:
            payload = await graph_service.set_profiling_trace_control(
                process_id=body.process_id,
                enabled=body.enabled,
                publisher_endpoint_id=body.publisher_endpoint_id,
                publisher_topic=body.publisher_topic,
                subscriber_topic=body.subscriber_topic,
                metrics=body.metrics,
                sample_mod=body.sample_mod,
                ttl_seconds=body.ttl_seconds,
                timeout=body.timeout,
            )
        except GraphServiceUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except (ProfilingTraceControlError, RuntimeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return JSONResponse(content=payload, headers=NO_CACHE_HEADERS)

    @app.websocket("/ws/events")
    async def ws_events(
        websocket: WebSocket,
        topology_after_seq: Annotated[int, Query(ge=0)] = 0,
        settings_after_seq: Annotated[int, Query(ge=0)] = 0,
        profiling_interval: Annotated[float, Query(gt=0.0)] = 0.05,
        profiling_max_samples: Annotated[int, Query(gt=0)] = 5000,
    ) -> None:
        await websocket.accept()
        graph_service = app.state.graph_service
        try:
            async for envelope in graph_service.event_envelopes(
                topology_after_seq=topology_after_seq,
                settings_after_seq=settings_after_seq,
                profiling_interval=profiling_interval,
                profiling_max_samples=profiling_max_samples,
            ):
                await websocket.send_json(envelope)
        except WebSocketDisconnect:
            return
        except RuntimeError as exc:
            error = SystemErrorEnvelope(
                kind="system.error",
                data={"timestamp": 0.0, "message": str(exc)},
            )
            await websocket.send_json(error.model_dump(mode="json"))
            await websocket.close(code=1011)
        except Exception:
            await websocket.close(code=1011)

    return app


app = create_app()
