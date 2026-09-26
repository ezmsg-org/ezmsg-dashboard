"""Disposable validation process or owned graph runner process."""

from __future__ import annotations

import asyncio
import json
import signal
import sys
import threading
from pathlib import Path

from .execution_document import construct_graph
from .external_sources import external_sources


def write_status(path: Path, **payload):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload))
    temporary.replace(path)


def check_main_threads(component):
    if getattr(component, "__main__", None):
        raise ValueError("Main-thread Units require a dedicated execution policy")
    for child in getattr(component, "components", {}).values():
        check_main_threads(child)


def main():
    mode, request_path, status_path = sys.argv[1:]
    status_path = Path(status_path)
    runner = None
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    try:
        request = json.loads(Path(request_path).read_text())
        from ezmsg.core.backend import ExecutionContext, GraphRunner
        from ezmsg.core.netprotocol import Address

        sources = (
            asyncio.run(external_sources(request["graph_address"], request["root_name"]))
            if request["document"].get("external_inputs")
            else []
        )
        components, connections = construct_graph(request["document"], sources)
        if mode == "validate":
            context = ExecutionContext.setup(components, root_name=request["root_name"], connections=connections)
            if context is None:
                raise ValueError("The graph contains no executable Units or relays")
            # Collection internals must follow the same main-thread policy as Units.
            for component in components.values():
                check_main_threads(component)
            write_status(status_path, state="valid")
            return
        runner = GraphRunner(
            components=components,
            connections=connections,
            root_name=request["root_name"],
            graph_address=Address.from_string(request["graph_address"]),
            auto_start=False,
        )
        runner.start()
        write_status(status_path, state="running")
        while not stopped.wait(0.1):
            if status_path.with_suffix(".stop").exists():
                break
            if any(not process.is_alive() for process in runner.processes):
                raise RuntimeError("A managed process exited; the processing group has stopped")
        runner.stop()
        runner = None
        write_status(status_path, state="stopped")
    except BaseException as exc:
        write_status(status_path, state="failed", error=f"{type(exc).__name__}: {exc}")
    finally:
        if runner is not None and runner.running:
            runner.stop()


if __name__ == "__main__":
    main()
