"""End-to-end check for https://github.com/ezmsg-org/ezmsg-dashboard/issues/4

Runs a one-unit ezmsg system whose ``Settings`` dataclass holds non-finite
floats (``inf`` / ``-inf`` / ``nan``), points a real dashboard server at it, and
probes both transports.

Before the fix, ``GET /api/settings`` and ``/api/snapshot`` returned 500
(``JSONResponse`` renders with ``allow_nan=False``) while ``/ws/events`` quietly
reported those fields as ``null`` (pydantic's ``ser_json_inf_nan="null"``). Both
now carry the values as the tokens ``"Infinity"``, ``"-Infinity"`` and ``"NaN"``.

Usage::

    uv run python examples/nonfinite_float_settings.py           # headless probe
    uv run python examples/nonfinite_float_settings.py --serve   # leave system + dashboard up for a browser
"""

from __future__ import annotations

import argparse
import asyncio
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import ezmsg.core as ez
from ezmsg.core.netprotocol import Address

from ezmsg.dashboard.server import start_dashboard_server

GRAPH_HOST = "127.0.0.1"
GRAPH_PORT = 26078
GRAPH_ADDRESS = f"{GRAPH_HOST}:{GRAPH_PORT}"
DASHBOARD_PORT = GRAPH_PORT + 1
UNIT_NAME = "NOISY"


class NonFiniteSettings(ez.Settings):
    """Settings of the kind described in the issue: plain ``float`` fields."""

    gain: float = 1.0
    clip_max: float = float("inf")
    clip_min: float = float("-inf")
    last_value: float = float("nan")


class NonFiniteUnit(ez.Unit):
    SETTINGS = NonFiniteSettings

    OUTPUT_SIGNAL = ez.OutputStream(float)

    @ez.publisher(OUTPUT_SIGNAL)
    async def pub(self):
        while True:
            await asyncio.sleep(0.5)
            yield self.OUTPUT_SIGNAL, self.SETTINGS.gain


def run_system() -> None:
    """Child-process entry point: an ezmsg system with its own graph server."""
    ez.run(**{UNIT_NAME: NonFiniteUnit()}, graph_address=Address(GRAPH_HOST, GRAPH_PORT))


def _wait_for_port(host: str, port: int, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"Nothing listening on {host}:{port} after {timeout}s")


def _reject_constant(name: str) -> object:
    raise ValueError(f"non-standard JSON literal {name!r} (browser JSON.parse would throw here)")


def probe_rest(dashboard_url: str) -> None:
    for route in ("/api/settings", "/api/snapshot"):
        print(f"\n--- GET {dashboard_url}{route} ---")
        try:
            with urllib.request.urlopen(f"{dashboard_url}{route}", timeout=10) as response:
                body = response.read().decode()
                print(f"status: {response.status}")
        except urllib.error.HTTPError as exc:
            print(f"status: {exc.code} {exc.reason}   <-- FAILED")
            continue
        payload = json.loads(body, parse_constant=_reject_constant)
        settings = payload["settings"][UNIT_NAME]["structured_value"]
        print(f"structured_value: {settings}")


def probe_websocket(host: str, port: int) -> None:
    print(f"\n--- ws://{host}:{port}/ws/events ---")
    try:
        from websockets.sync.client import connect
    except ImportError:
        print("skipped: install `websockets` to probe the event stream")
        return

    with connect(f"ws://{host}:{port}/ws/events", open_timeout=10) as websocket:
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            try:
                frame = websocket.recv(timeout=max(0.1, deadline - time.monotonic()))
            except TimeoutError:
                break
            if isinstance(frame, bytes):
                frame = frame.decode()
            envelope = json.loads(frame, parse_constant=_reject_constant)
            if envelope.get("kind") != "settings.changed":
                continue
            if envelope["data"]["component_address"] != UNIT_NAME:
                continue
            print(f"structured_value: {envelope['data']['value']['structured_value']}")
            return
        print(f"no settings.changed frame for {UNIT_NAME} observed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--system",
        action="store_true",
        help="internal: run only the ezmsg system (used for the child process)",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="leave the system and dashboard running so the failure can be seen in a browser",
    )
    args = parser.parse_args()

    if args.system:
        run_system()
        return

    graph_server = subprocess.Popen([sys.executable, "-m", "ezmsg.core", "serve", "--address", GRAPH_ADDRESS])
    system: subprocess.Popen | None = None
    try:
        _wait_for_port(GRAPH_HOST, GRAPH_PORT)
        system = subprocess.Popen([sys.executable, __file__, "--system"])
        time.sleep(3.0)  # let the unit publish its initial settings to the graph server

        dashboard = start_dashboard_server(
            graph_address=GRAPH_ADDRESS,
            host=GRAPH_HOST,
            port=DASHBOARD_PORT,
            log_level="error",
        )
        try:
            print(f"dashboard: {dashboard.url}  (graph server: {GRAPH_ADDRESS})")
            if args.serve:
                print("Open the dashboard in a browser; Ctrl-C to stop.")
                while True:
                    time.sleep(1.0)
            probe_rest(dashboard.url)
            probe_websocket(GRAPH_HOST, DASHBOARD_PORT)
        finally:
            dashboard.stop()
    except KeyboardInterrupt:
        pass
    finally:
        for child in (system, graph_server):
            if child is None:
                continue
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()


if __name__ == "__main__":
    main()
