from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from .models.events import SystemErrorEnvelope
from .services import GraphContextLifecycleService, GraphServiceProtocol


def get_graph_service(request: Request) -> GraphServiceProtocol:
    service = getattr(request.app.state, "graph_service", None)
    if service is None:
        raise RuntimeError("Graph service is not configured.")
    return service


GraphServiceDependency = Annotated[GraphServiceProtocol, Depends(get_graph_service)]


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
    async def api_health(graph_service: GraphServiceDependency) -> dict[str, object]:
        return await graph_service.health_payload()

    @app.get("/api/snapshot")
    async def api_snapshot(graph_service: GraphServiceDependency) -> dict[str, object]:
        try:
            return await graph_service.snapshot_payload()
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.get("/api/settings")
    async def api_settings(graph_service: GraphServiceDependency) -> dict[str, object]:
        try:
            return await graph_service.settings_payload()
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.websocket("/ws/events")
    async def ws_events(
        websocket: WebSocket,
        topology_after_seq: Annotated[int, Query(ge=0)] = 0,
        settings_after_seq: Annotated[int, Query(ge=0)] = 0,
        profiling_interval: Annotated[float, Query(gt=0.0)] = 0.2,
        profiling_max_samples: Annotated[int, Query(gt=0)] = 1000,
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
