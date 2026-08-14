from __future__ import annotations

import argparse
import logging
import os
import socket
import threading
import time
import webbrowser
from dataclasses import dataclass

import uvicorn
from ezmsg.core.netprotocol import (
    DEFAULT_HOST as EZMSG_DEFAULT_HOST,
)
from ezmsg.core.netprotocol import (
    GRAPHSERVER_ADDR_ENV,
    GRAPHSERVER_PORT_DEFAULT,
    Address,
)

from .backend.app import create_app
from .backend.services import GraphContextLifecycleService

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
STARTUP_TIMEOUT_SECONDS = 10.0
DASHBOARD_ADDR_ENV = "EZMSG_DASHBOARD_ADDR"

logger = logging.getLogger("ezmsg.dashboard")


def _normalize_graph_address(graph_address: str | Address | None) -> str | None:
    if graph_address is None:
        return None
    if isinstance(graph_address, Address):
        return str(graph_address)
    return graph_address


class DashboardGraphServerUnavailableError(RuntimeError):
    pass


def _default_graph_address() -> Address:
    address_str = os.environ.get(GRAPHSERVER_ADDR_ENV, f"{EZMSG_DEFAULT_HOST}:{GRAPHSERVER_PORT_DEFAULT}")
    return Address.from_string(address_str)


def _resolve_graph_server_address(graph_address: str | Address | None = None) -> Address:
    normalized_graph_address = _normalize_graph_address(graph_address)
    if normalized_graph_address is None:
        return _default_graph_address()
    return Address.from_string(normalized_graph_address)


def _graph_server_unavailable_message(graph_address: Address) -> str:
    return (
        f"Could not connect to GraphServer at {graph_address}. "
        "Start one with `ezmsg serve` or `ezmsg serve --dashboard`, "
        "or specify a running GraphServer with `ezmsg dashboard --graph-address HOST:PORT`."
    )


def _ensure_graph_server_available(graph_address: str | Address | None = None) -> Address:
    resolved_graph_address = _resolve_graph_server_address(graph_address)
    try:
        with socket.create_connection(
            (resolved_graph_address.host, resolved_graph_address.port),
            timeout=1.0,
        ):
            pass
    except OSError as exc:
        raise DashboardGraphServerUnavailableError(_graph_server_unavailable_message(resolved_graph_address)) from exc
    return resolved_graph_address


def _resolve_dashboard_bind(
    *,
    graph_address: str | Address | None = None,
    host: str | None = None,
    port: int | None = None,
) -> Address:
    if DASHBOARD_ADDR_ENV in os.environ:
        resolved = Address.from_string(os.environ[DASHBOARD_ADDR_ENV])
    else:
        normalized_graph_address = _normalize_graph_address(graph_address)
        base_graph_address = (
            Address.from_string(normalized_graph_address)
            if normalized_graph_address is not None
            else _default_graph_address()
        )
        resolved = Address(base_graph_address.host, base_graph_address.port + 1)

    return Address(
        resolved.host if host is None else host,
        resolved.port if port is None else port,
    )


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
    host: str | None = None,
    port: int | None = None,
    log_level: str = "info",
    open_browser: bool = False,
) -> None:
    _ensure_graph_server_available(graph_address)
    bind_address = _resolve_dashboard_bind(
        graph_address=graph_address,
        host=host,
        port=port,
    )
    url = dashboard_url(bind_address.host, bind_address.port)
    if open_browser:
        timer = threading.Timer(0.5, lambda: webbrowser.open(url))
        timer.daemon = True
        timer.start()

    app = create_dashboard_app(graph_address=graph_address)
    config = uvicorn.Config(
        app=app,
        host=bind_address.host,
        port=bind_address.port,
        log_level=log_level,
    )
    server = uvicorn.Server(config=config)
    logger.info("Dashboard listening on %s", url)
    server.run()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ezmsg dashboard",
        description="Launch the ezmsg dashboard server.",
    )
    _add_dashboard_arguments(parser)
    return parser


def _add_dashboard_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--graph-address", default=None, help="Address of the ezmsg graph server.")
    parser.add_argument(
        "--host",
        default=None,
        help="HTTP bind host for the dashboard. Defaults to the dashboard env host or graph host.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="HTTP bind port for the dashboard. Defaults to the dashboard env port or graph port + 1.",
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


def handle_dashboard(args: argparse.Namespace) -> None:
    try:
        serve_dashboard(
            graph_address=args.graph_address,
            host=args.host,
            port=args.port,
            log_level=args.log_level,
            open_browser=args.open_browser,
        )
    except DashboardGraphServerUnavailableError as exc:
        logger.error("%s", exc)


def setup_dashboard_cmdline(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "dashboard",
        description="Launch the ezmsg dashboard server.",
        help="launch the optional ezmsg dashboard server",
    )
    _add_dashboard_arguments(parser)
    parser.set_defaults(_handler=handle_dashboard)


def cmdline(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    handle_dashboard(args)


__all__ = [
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "DashboardServerHandle",
    "DASHBOARD_ADDR_ENV",
    "DashboardGraphServerUnavailableError",
    "cmdline",
    "create_dashboard_app",
    "dashboard_url",
    "handle_dashboard",
    "_graph_server_unavailable_message",
    "_ensure_graph_server_available",
    "_resolve_dashboard_bind",
    "serve_dashboard",
    "setup_dashboard_cmdline",
    "start_dashboard_server",
]
