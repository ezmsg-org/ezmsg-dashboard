"""Installed component discovery, independent of a live GraphService connection.

Enumeration never loads entry points. Details are inspected in a disposable
interpreter so a broken import cannot terminate or hang the dashboard server.
"""

from __future__ import annotations

import hashlib
import importlib.metadata as metadata
import json
import subprocess
import sys
import tempfile
from pathlib import Path

GROUP = "ezmsg.components"


def registrations() -> list[tuple[dict, metadata.EntryPoint]]:
    result = []
    for dist in metadata.distributions():
        for ep in dist.entry_points:
            if ep.group != GROUP:
                continue
            package = dist.metadata.get("Name", "unknown")
            identity = f"{package.lower()}:{ep.name}:{ep.value}"
            result.append(
                (
                    {
                        "id": hashlib.sha256(identity.encode()).hexdigest(),
                        "name": ep.name,
                        "value": ep.value,
                        "distribution": package,
                        "version": dist.version,
                    },
                    ep,
                )
            )
    return sorted(result, key=lambda item: (item[0]["name"], item[0]["distribution"], item[0]["value"]))


def catalog_payload() -> dict:
    return {
        "interpreter": sys.executable,
        "components": [record for record, _ in registrations()],
    }


def component_details(component_id: str) -> dict:
    matches = [(record, ep) for record, ep in registrations() if record["id"] == component_id]
    if not matches:
        raise KeyError(component_id)
    record, _ = matches[0]
    if len(matches) != 1:
        return {**record, "available": False, "error": "Duplicate installed registration"}
    with tempfile.TemporaryDirectory(prefix="ezmsg-component-") as directory:
        output = Path(directory) / "details.json"
        try:
            completed = subprocess.run(
                [sys.executable, "-m", "ezmsg.dashboard.backend.catalog_worker", component_id, str(output)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
                check=False,
            )
            if completed.returncode or not output.exists():
                raise RuntimeError(f"Component inspection exited with status {completed.returncode}")
            return {**record, **json.loads(output.read_text())}
        except (subprocess.TimeoutExpired, RuntimeError, ValueError, OSError) as exc:
            return {**record, "available": False, "error": str(exc)}
