from __future__ import annotations

import argparse
import logging
import threading
import time
import webbrowser
from dataclasses import dataclass
from typing import Any

import uvicorn
from ezmsg.core.netprotocol import Address

from .backend.app import create_app
from .backend.services import GraphContextLifecycleService

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
STARTUP_TIMEOUT_SECONDS = 10.0

logger = logging.getLogger("ezmsg.dashboard")


def _normalize_graph_address(graph_address: str | Address | None) -> str | None:
    if graph_address is None:
        return None
    if isinstance(graph_address, Address):
        return str(graph_address)
    return graph_address


def _browser_host(host: str) -> str:
    if host in {"0.0.0.0", "::"}:
        return "127.0.0.1"
    return host


def dashboard_url(host: str, port: int) -> str:
    return f"http://{_browser_host(host)}:{port}"


def create_dashboard_app(*, graph_address: str | Address | None = None):
    return create_app(
        GraphContextLifecycleService(
            graph_address=_normalize_graph_address(graph_address),
            auto_start=False,
        )
    )


@dataclass(slots=True)
class DashboardServerHandle:
    server: uvicorn.Server
    thread: threading.Thread
    host: str
    port: int

    @property
    def url(self) -> str:
        return dashboard_url(self.host, self.port)

    def stop(self, *, timeout: float = 10.0) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=timeout)


def _resolve_bound_port(server: uvicorn.Server, fallback_port: int) -> int:
    servers = getattr(server, "servers", None)
    if not servers:
        return fallback_port
    for item in servers:
        sockets = getattr(item, "sockets", None) or []
        if sockets:
            sockname = sockets[0].getsockname()
            return int(sockname[1])
    return fallback_port


def start_dashboard_server(
    *,
    graph_address: str | Address | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    log_level: str = "info",
) -> DashboardServerHandle:
    app = create_dashboard_app(graph_address=graph_address)
    config = uvicorn.Config(app=app, host=host, port=port, log_level=log_level)
    server = uvicorn.Server(config=config)
    thread = threading.Thread(
        target=server.run,
        daemon=True,
        name="ezmsg-dashboard-server",
    )
    thread.start()

    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while not getattr(server, "started", False):
        if not thread.is_alive():
            raise RuntimeError("Dashboard server stopped before startup completed.")
        if time.monotonic() >= deadline:
            raise RuntimeError("Timed out while waiting for dashboard server startup.")
        time.sleep(0.05)

    bound_port = _resolve_bound_port(server, port)
    return DashboardServerHandle(server=server, thread=thread, host=host, port=bound_port)


def serve_dashboard(
    *,
    graph_address: str | Address | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    log_level: str = "info",
    open_browser: bool = False,
) -> None:
    url = dashboard_url(host, port)
    if open_browser:
        timer = threading.Timer(0.5, lambda: webbrowser.open(url))
        timer.daemon = True
        timer.start()

    app = create_dashboard_app(graph_address=graph_address)
    config = uvicorn.Config(app=app, host=host, port=port, log_level=log_level)
    server = uvicorn.Server(config=config)
    logger.info("Dashboard listening on %s", url)
    server.run()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ezmsg-dashboard",
        description="Launch the ezmsg dashboard server.",
    )
    parser.add_argument("--graph-address", default=None, help="Address of the ezmsg graph server.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="HTTP bind host for the dashboard.")
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help="HTTP bind port for the dashboard.",
    )
    parser.add_argument(
        "--open-browser",
        action="store_true",
        help="Open the dashboard in a browser after startup.",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        help="Uvicorn log verbosity.",
    )
    return parser


def cmdline(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    serve_dashboard(
        graph_address=args.graph_address,
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        open_browser=args.open_browser,
    )


__all__ = [
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "DashboardServerHandle",
    "cmdline",
    "create_dashboard_app",
    "dashboard_url",
    "serve_dashboard",
    "start_dashboard_server",
]
