from __future__ import annotations

import asyncio
import contextlib
import json
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# StaticFiles raises Starlette's HTTPException, which FastAPI's subclasses.
from starlette.exceptions import HTTPException as StarletteHTTPException

from .json_encoding import sanitize_json_value
from .models.events import SystemErrorEnvelope
from .services import GraphContextLifecycleService, GraphServiceProtocol
from .services.graph_context_service import (
    GraphServiceUnavailableError,
    ProfilingTraceControlError,
    SettingsPatchError,
)
from .services.stream_tap import (
    AUTO,
    CLIENT_MODES,
    DEFAULT_WINDOW_SECONDS,
    MAX_COLUMNS,
    MAX_WINDOW_SECONDS,
    MIN_WINDOW_SECONDS,
    StreamTapError,
)
from .stream_frames import encode_binary_frame

#: How often a stream socket reports tap health and message-inspector state,
#: independently of the data frame rate. Slow enough to be free on a busy
#: stream, quick enough that "nothing is arriving" shows up as a fact rather
#: than as a plot that simply is not moving.
STREAM_STATUS_INTERVAL_SECONDS = 0.5

NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}

# Vite emits content-hashed filenames under assets/, so a given URL there always
# names the same bytes and can be cached for as long as the browser likes.
IMMUTABLE_ASSET_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}

PACKAGE_FRONTEND_DIR = Path(__file__).resolve().parents[1] / "_web"


class DashboardJSONResponse(JSONResponse):
    """JSONResponse that encodes non-finite floats instead of failing on them.

    ``JSONResponse.render`` renders with ``allow_nan=False``, so a single ``inf``
    anywhere in a payload turns the whole request into a 500. Payloads assembled
    by the adapters are already encoded; this is the backstop for everything
    else (request echoes, future routes). Re-rendering only on failure keeps the
    common path free of an extra walk over large snapshot payloads.
    """

    def render(self, content: Any) -> bytes:
        try:
            return super().render(content)
        except ValueError:
            return super().render(sanitize_json_value(content))


class DashboardStaticFiles(StaticFiles):
    """Serves the built frontend, and caches it the way Vite builds it.

    The shell names the content-hashed bundles, so a cached copy pins the
    browser to whichever bundle it was built against: a rebuilt dashboard keeps
    serving the old app until someone hard-reloads. It is therefore never
    cached. The hashed assets it names can be cached forever by the same logic.

    Missing paths that look like client-side routes fall back to the shell.
    """

    def _shell_response(self) -> FileResponse | None:
        index_path = Path(self.directory or "") / "index.html"
        if not index_path.is_file():
            return None
        return FileResponse(index_path, headers=NO_CACHE_HEADERS)

    @staticmethod
    def cache_headers_for(path: str) -> dict[str, str] | None:
        """Cache headers for a file StaticFiles resolved, if it wants any.

        ``path`` arrives normalized for the host OS, so it is separated by
        backslashes on Windows. Rewrite them rather than going through ``Path``,
        which only reads a backslash as a separator when running on Windows.
        """
        relative_path = path.replace("\\", "/")
        if relative_path in (".", "", "index.html") or relative_path.endswith("/index.html"):
            return NO_CACHE_HEADERS
        if relative_path.startswith("assets/"):
            return IMMUTABLE_ASSET_HEADERS
        return None

    @staticmethod
    def _wants_shell_fallback(scope: dict[str, Any]) -> bool:
        request_path = scope.get("path", "")
        if request_path == "/api" or request_path.startswith("/api/"):
            return False
        if request_path == "/ws" or request_path.startswith("/ws/"):
            return False
        # A missing file, rather than a client-side route.
        return "." not in Path(request_path).name

    async def get_response(self, path: str, scope: dict[str, Any]) -> Response:
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            # StaticFiles signals a miss by raising, not by returning a 404.
            if exc.status_code != 404 or not self._wants_shell_fallback(scope):
                raise
            shell = self._shell_response()
            if shell is None:
                raise
            return shell

        if response.status_code >= 400:
            return response
        headers = self.cache_headers_for(path)
        if headers is not None:
            response.headers.update(headers)
        return response


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


async def run_until_first_completed(*tasks: asyncio.Task[None]) -> None:
    """Await the first task to finish, cancel the rest, re-raise what it raised.

    Every websocket route here is the same shape: a task that produces messages
    and a task that watches for the client going away. Whichever finishes first
    decides the socket's fate, and the loser must be cancelled *and awaited* --
    leaving it pending would keep the tap it holds alive past the socket that
    opened it.
    """
    done, pending = await asyncio.wait(set(tasks), return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    for task in pending:
        with contextlib.suppress(asyncio.CancelledError):
            await task
    for task in tasks:
        if task in done:
            # Surfaces the winner's exception, if it had one.
            task.result()
            return


async def wait_for_websocket_disconnect(websocket: WebSocket) -> None:
    """Return once the peer goes away, ignoring anything it says first."""
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return


def get_packaged_frontend_dir() -> Path | None:
    index_path = PACKAGE_FRONTEND_DIR / "index.html"
    if index_path.is_file():
        return PACKAGE_FRONTEND_DIR
    return None


def create_app(
    graph_service: GraphServiceProtocol | None = None,
    *,
    frontend_dir: Path | None = None,
) -> FastAPI:
    service = graph_service or GraphContextLifecycleService()
    resolved_frontend_dir = frontend_dir if frontend_dir is not None else get_packaged_frontend_dir()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.graph_service = service
        app.state.frontend_dir = resolved_frontend_dir
        await service.startup()
        try:
            yield
        finally:
            await service.shutdown()

    app = FastAPI(title="ezmsg Dashboard Backend", lifespan=lifespan)

    @app.get("/api/health")
    async def api_health(graph_service: GraphServiceDependency) -> JSONResponse:
        payload = await graph_service.health_payload()
        return DashboardJSONResponse(content=payload, headers=NO_CACHE_HEADERS)

    @app.get("/api/snapshot")
    async def api_snapshot(graph_service: GraphServiceDependency) -> JSONResponse:
        try:
            payload = await graph_service.snapshot_payload()
        except GraphServiceUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return DashboardJSONResponse(content=payload, headers=NO_CACHE_HEADERS)

    @app.get("/api/settings")
    async def api_settings(graph_service: GraphServiceDependency) -> JSONResponse:
        try:
            payload = await graph_service.settings_payload()
        except GraphServiceUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return DashboardJSONResponse(content=payload, headers=NO_CACHE_HEADERS)

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
        return DashboardJSONResponse(content=payload, headers=NO_CACHE_HEADERS)

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
        return DashboardJSONResponse(content=payload, headers=NO_CACHE_HEADERS)

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

        async def pump_envelopes() -> None:
            async for envelope in graph_service.event_envelopes(
                topology_after_seq=topology_after_seq,
                settings_after_seq=settings_after_seq,
                profiling_interval=profiling_interval,
                profiling_max_samples=profiling_max_samples,
            ):
                await websocket.send_json(envelope)

        # The client is not expected to send anything, so watching for the
        # disconnect separately is what keeps a quiet stream from holding
        # shutdown open until the next heartbeat, which is long enough that
        # Ctrl+C looks hung.
        pump_task = asyncio.create_task(pump_envelopes(), name="dashboard-ws-pump")
        disconnect_task = asyncio.create_task(wait_for_websocket_disconnect(websocket), name="dashboard-ws-disconnect")
        try:
            await run_until_first_completed(pump_task, disconnect_task)
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

    @app.websocket("/ws/stream")
    async def ws_stream(
        websocket: WebSocket,
        topic: Annotated[str, Query(min_length=1)],
        mode: Annotated[str, Query()] = AUTO,
        columns: Annotated[int, Query(ge=1, le=MAX_COLUMNS)] = 1200,
        hz: Annotated[float, Query(gt=0.0, le=120.0)] = 30.0,
        window: Annotated[float, Query(ge=MIN_WINDOW_SECONDS, le=MAX_WINDOW_SECONDS)] = DEFAULT_WINDOW_SECONDS,
    ) -> None:
        """Live sample data from one topic, as binary frames.

        Data goes out as ``[u32 header_len][JSON header][float32 payload]``
        rather than JSON, because the payload is nearly all of the traffic and
        the browser can wrap it in a ``Float32Array`` without touching a single
        number. Metadata, tap health and the message inspector travel as text
        frames on the same socket, so the client needs one connection per panel
        and never has to correlate two.

        ``columns`` is the client's pixel budget and ``window`` is how many
        seconds that budget spans. Together they set how many samples a column
        stands for, which is what keeps a 30 kHz stream affordable: the wire
        cost follows the plot's width and time base, not the publisher's rate.
        """
        await websocket.accept()
        graph_service = app.state.graph_service

        try:
            tap_context = graph_service.stream_tap(topic=topic, mode=mode, max_columns=columns, window_seconds=window)
        except (StreamTapError, GraphServiceUnavailableError, RuntimeError) as exc:
            await websocket.send_json({"kind": "stream.error", "data": {"message": str(exc)}})
            await websocket.close(code=1011)
            return

        async def pump_frames(client: Any) -> None:
            interval = 1.0 / hz
            # Report once up front so a topic that is connected but silent says
            # so immediately, instead of looking identical to a broken socket
            # for the first status period.
            await websocket.send_json({"kind": "stream.status", "data": client.tap.status_payload()})
            last_status = time.monotonic()
            while True:
                await asyncio.sleep(interval)

                # Description first, always: a data frame names the generation
                # it belongs to, and one that arrived before its description
                # would be drawn on the previous stream's axes.
                description = client.take_description()
                if description is not None:
                    await websocket.send_json({"kind": "stream.meta", "data": description})

                frame = client.take_frame()
                if frame is not None:
                    header, payload = frame
                    await websocket.send_bytes(encode_binary_frame(header, payload))

                now = time.monotonic()
                if now - last_status >= STREAM_STATUS_INTERVAL_SECONDS:
                    last_status = now
                    await websocket.send_json({"kind": "stream.status", "data": client.tap.status_payload()})
                    await websocket.send_json({"kind": "stream.inspect", "data": client.tap.inspect_payload()})

        async def receive_config(client: Any) -> None:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    return
                text = message.get("text")
                if not text:
                    continue
                try:
                    payload = json.loads(text)
                except ValueError:
                    continue
                if not isinstance(payload, dict) or payload.get("kind") != "stream.config":
                    continue
                requested_columns = payload.get("columns")
                if isinstance(requested_columns, (int, float)) and not isinstance(requested_columns, bool):
                    client.set_max_columns(int(requested_columns))
                requested_window = payload.get("window_seconds")
                if isinstance(requested_window, (int, float)) and not isinstance(requested_window, bool):
                    client.set_window_seconds(float(requested_window))
                requested_mode = payload.get("mode")
                if requested_mode in CLIENT_MODES:
                    client.mode = requested_mode

        try:
            async with tap_context as client:
                pump_task = asyncio.create_task(pump_frames(client), name=f"dashboard-stream-pump:{topic}")
                config_task = asyncio.create_task(receive_config(client), name=f"dashboard-stream-config:{topic}")
                await run_until_first_completed(pump_task, config_task)
        except WebSocketDisconnect:
            return
        except StreamTapError as exc:
            with contextlib.suppress(Exception):
                await websocket.send_json({"kind": "stream.error", "data": {"message": str(exc)}})
                await websocket.close(code=1011)
        except Exception:
            with contextlib.suppress(Exception):
                await websocket.close(code=1011)

    if resolved_frontend_dir is not None:
        app.mount(
            "/",
            DashboardStaticFiles(directory=str(resolved_frontend_dir), html=True),
            name="dashboard-frontend",
        )

    return app


app = create_app()
