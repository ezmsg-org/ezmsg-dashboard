from __future__ import annotations

import argparse
import asyncio

import pytest
from ezmsg.core.netprotocol import Address

from ezmsg.dashboard.server import (
    DASHBOARD_ADDR_ENV,
    DashboardGraphServerUnavailableError,
    _ensure_graph_server_available,
    _resolve_dashboard_bind,
    handle_dashboard,
    serve_dashboard,
)


def test_resolve_dashboard_bind_defaults_to_graph_port_plus_one(monkeypatch) -> None:
    monkeypatch.delenv("EZMSG_GRAPHSERVER_ADDR", raising=False)
    monkeypatch.delenv(DASHBOARD_ADDR_ENV, raising=False)

    address = _resolve_dashboard_bind(graph_address="127.0.0.1:25978")

    assert address == Address("127.0.0.1", 25979)


def test_resolve_dashboard_bind_uses_graph_env_when_graph_address_missing(monkeypatch) -> None:
    monkeypatch.setenv("EZMSG_GRAPHSERVER_ADDR", "0.0.0.0:30000")
    monkeypatch.delenv(DASHBOARD_ADDR_ENV, raising=False)

    address = _resolve_dashboard_bind()

    assert address == Address("0.0.0.0", 30001)


def test_resolve_dashboard_bind_respects_dashboard_env(monkeypatch) -> None:
    monkeypatch.setenv(DASHBOARD_ADDR_ENV, "127.0.0.1:41000")

    address = _resolve_dashboard_bind(graph_address="127.0.0.1:25978")

    assert address == Address("127.0.0.1", 41000)


def test_resolve_dashboard_bind_allows_port_override(monkeypatch) -> None:
    monkeypatch.delenv(DASHBOARD_ADDR_ENV, raising=False)

    address = _resolve_dashboard_bind(graph_address="127.0.0.1:25978", port=28000)

    assert address == Address("127.0.0.1", 28000)


def test_resolve_dashboard_bind_allows_host_override(monkeypatch) -> None:
    monkeypatch.delenv(DASHBOARD_ADDR_ENV, raising=False)

    address = _resolve_dashboard_bind(
        graph_address="127.0.0.1:25978",
        host="0.0.0.0",
    )

    assert address == Address("0.0.0.0", 25979)


def test_ensure_graph_server_available_reports_helpful_message(monkeypatch) -> None:
    def fail_connect(*args, **kwargs):
        raise ConnectionRefusedError(61, "Connection refused")

    monkeypatch.setattr("ezmsg.dashboard.server.socket.create_connection", fail_connect)

    with pytest.raises(DashboardGraphServerUnavailableError) as exc_info:
        _ensure_graph_server_available("127.0.0.1:25978")

    message = str(exc_info.value)
    assert "Could not connect to GraphServer at 127.0.0.1:25978." in message
    assert "`ezmsg serve`" in message
    assert "`ezmsg serve --dashboard`" in message
    assert "`ezmsg dashboard --graph-address HOST:PORT`" in message


def test_handle_dashboard_logs_helpful_message_when_graph_server_missing(monkeypatch, caplog) -> None:
    monkeypatch.setattr(
        "ezmsg.dashboard.server.serve_dashboard",
        lambda **kwargs: (_ for _ in ()).throw(
            DashboardGraphServerUnavailableError("Could not connect to GraphServer at 127.0.0.1:25978.")
        ),
    )

    args = argparse.Namespace(
        graph_address=None,
        host=None,
        port=None,
        log_level="info",
        open_browser=False,
    )

    with caplog.at_level("ERROR"):
        handle_dashboard(args)

    assert "Could not connect to GraphServer at 127.0.0.1:25978." in caplog.text


class _InterruptingServer:
    """Stand-in for uvicorn.Server that reproduces its Ctrl+C behavior.

    uvicorn shuts the application down gracefully on SIGINT and then re-raises
    the signal, so `Server.run()` raises out of an already-completed shutdown.
    """

    instances: list["_InterruptingServer"] = []

    def __init__(self, *, config, error: BaseException) -> None:
        self.config = config
        self._error = error
        self.ran = False
        _InterruptingServer.instances.append(self)

    def run(self) -> None:
        self.ran = True
        raise self._error


def _serve_with_interrupt(monkeypatch, error: BaseException) -> None:
    monkeypatch.setattr("ezmsg.dashboard.server._ensure_graph_server_available", lambda address: None)
    monkeypatch.setattr(
        "ezmsg.dashboard.server.uvicorn.Server",
        lambda *, config: _InterruptingServer(config=config, error=error),
    )
    serve_dashboard(graph_address="127.0.0.1:25978", port=0)


@pytest.mark.parametrize("error", [KeyboardInterrupt(), asyncio.CancelledError()])
def test_serve_dashboard_exits_quietly_on_interrupt(monkeypatch, caplog, error) -> None:
    _InterruptingServer.instances.clear()

    with caplog.at_level("INFO"):
        _serve_with_interrupt(monkeypatch, error)  # must not raise

    assert _InterruptingServer.instances[0].ran is True
    assert "Dashboard stopped." in caplog.text


def test_serve_dashboard_still_propagates_real_errors(monkeypatch) -> None:
    with pytest.raises(RuntimeError, match="port already in use"):
        _serve_with_interrupt(monkeypatch, RuntimeError("port already in use"))
