from __future__ import annotations

import asyncio
import json
import os
import time

import pytest
from ezmsg.core.graphserver import GraphService

from ezmsg.dashboard.backend.catalog import catalog_payload
from ezmsg.dashboard.backend.execution import ExecutionConflict, ExecutionSupervisor
from ezmsg.dashboard.backend.execution_document import GraphDocument, prepare_document


@pytest.fixture
def registered_units(tmp_path, monkeypatch):
    module = tmp_path / "builder_test_units.py"
    module.write_text("""
import asyncio
from pathlib import Path
from typing import Generic, TypeVar
import ezmsg.core as ez
T = TypeVar("T")

class SourceSettings(ez.Settings):
    value: int = 7

class GenericSource(ez.Unit, Generic[T]):
    SETTINGS = SourceSettings
    OUTPUT = ez.OutputStream(T)
    @ez.publisher(OUTPUT)
    async def produce(self):
        while True:
            yield self.OUTPUT, self.SETTINGS.value
            await asyncio.sleep(0.05)

class Source(GenericSource[int]):
    pass

class SourceCollection(ez.Collection):
    SETTINGS = SourceSettings
    OUTPUT = ez.OutputTopic(int)
    SOURCE = Source()
    def configure(self):
        self.SOURCE.apply_settings(self.SETTINGS)
    def network(self):
        return ((self.SOURCE.OUTPUT, self.OUTPUT),)

class SinkSettings(ez.Settings):
    path: str

class Sink(ez.Unit):
    SETTINGS = SinkSettings
    INPUT = ez.InputStream(int)
    @ez.subscriber(INPUT)
    async def receive(self, message):
        with Path(self.SETTINGS.path).open("a") as f:
            f.write(str(message) + "\\n")

class Forward(ez.Unit):
    INPUT = ez.InputStream(int)
    OUTPUT = ez.OutputStream(int)
    @ez.subscriber(INPUT)
    @ez.publisher(OUTPUT)
    async def forward(self, message):
        yield self.OUTPUT, message

class ChainSettings(ez.Settings):
    fail: bool = False

class Chain(ez.Collection):
    SETTINGS = ChainSettings
    INPUT = ez.InputTopic(int)
    OUTPUT = ez.OutputTopic(int)
    FIRST = Forward()
    SECOND = Forward()
    def configure(self):
        if self.SETTINGS.fail:
            raise ValueError("deliberate collection configuration failure")
    def network(self):
        return (
            (self.INPUT, self.FIRST.INPUT),
            (self.FIRST.OUTPUT, self.SECOND.INPUT),
            (self.SECOND.OUTPUT, self.OUTPUT),
        )
    def process_components(self):
        return (self.FIRST,)

class Broken(Source):
    async def initialize(self):
        raise RuntimeError("deliberate startup failure")
""")
    info = tmp_path / "builder_test-1.0.dist-info"
    info.mkdir()
    (info / "METADATA").write_text("Metadata-Version: 2.1\nName: builder-test\nVersion: 1.0\n")
    (info / "entry_points.txt").write_text(
        "[ezmsg.components]\ntest.Source = builder_test_units:Source\ntest.Sink = builder_test_units:Sink\n"
        "test.Broken = builder_test_units:Broken\ntest.Chain = builder_test_units:Chain\n"
        "test.SourceCollection = builder_test_units:SourceCollection\n"
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setenv("PYTHONPATH", str(tmp_path) + os.pathsep + os.environ.get("PYTHONPATH", ""))
    return {r["name"]: r for r in catalog_payload()["components"] if r["distribution"] == "builder-test"}


def document(registrations, output):
    return {
        "version": 1,
        "nodes": [
            {"id": "draft:source", "component": registrations["test.Source"], "settings": {"value": 7}},
            {"id": "draft:sink", "component": registrations["test.Sink"], "settings": {"path": str(output)}},
        ],
        "edges": [
            {
                "id": "edge",
                "source": "draft:source",
                "sourceHandle": "OUTPUT",
                "target": "draft:sink",
                "targetHandle": "INPUT",
            }
        ],
    }


def wait_for_value(path, value):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if path.exists() and str(value) in path.read_text().splitlines():
            return
        time.sleep(0.05)
    pytest.fail(f"Did not receive {value} at {path}")


def test_validate_against_installed_classes(registered_units, tmp_path):
    doc = document(registered_units, tmp_path / "output")
    prepare_document(doc)
    doc["nodes"][0]["settings"]["unknown"] = True
    with pytest.raises(ValueError, match="unknown settings"):
        prepare_document(doc)
    del doc["nodes"][0]["settings"]["unknown"]
    doc["edges"][0]["sourceHandle"] = "MADE_UP"
    with pytest.raises(ValueError, match="declared output"):
        prepare_document(doc)


def test_reject_cycles_and_version_mismatch(registered_units, tmp_path):
    doc = document(registered_units, tmp_path / "output")
    doc["nodes"][0]["component"] = {**doc["nodes"][0]["component"], "version": "missing"}
    with pytest.raises(ValueError, match="version differs"):
        prepare_document(doc)
    doc["edges"][0]["target"] = "draft:source"
    with pytest.raises(ValueError, match="cycles"):
        GraphDocument.model_validate(doc)


def test_real_run_apply_stop_preserves_external_group(registered_units, tmp_path):
    service = GraphService(("127.0.0.1", 0))
    server = service.create_server()
    external, managed = ExecutionSupervisor(), ExecutionSupervisor()
    try:
        external_output, output = tmp_path / "external.txt", tmp_path / "managed.txt"
        external.deploy(document(registered_units, external_output), str(service.address), 0)
        doc = document(registered_units, output)
        doc["nodes"][0]["name"] = "Acquisition"
        started = managed.deploy(doc, str(service.address), 0)
        assert started["state"] == "running", started
        wait_for_value(output, 7)
        wait_for_value(external_output, 7)
        invalid = json.loads(json.dumps(doc))
        invalid["nodes"][0]["settings"]["value"] = "not an integer"
        with pytest.raises(ValueError):
            managed.deploy(invalid, str(service.address), started["revision"], apply=True)
        assert managed.status()["state"] == "running"
        doc = json.loads(json.dumps(doc))
        doc["nodes"][0]["settings"]["value"] = 9
        doc["nodes"][0]["name"] = "RenamedAcquisition"
        applied = managed.deploy(doc, str(service.address), started["revision"], apply=True)
        assert applied["state"] == "running", applied
        assert started["runtime_addresses"]["draft:source"].endswith("/Acquisition")
        assert applied["runtime_addresses"]["draft:source"].endswith("/RenamedAcquisition")
        assert applied["runtime_addresses"]["draft:sink"] == started["runtime_addresses"]["draft:sink"]
        wait_for_value(output, 9)
        with pytest.raises(ExecutionConflict):
            managed.stop(started["revision"])
        stopped = managed.stop(applied["revision"])
        assert stopped["state"] == "stopped"
        before = external_output.stat().st_size
        time.sleep(0.2)
        assert external_output.stat().st_size > before
        assert external.status()["state"] == "running"
        # GraphService remains usable after stopping the managed group.
        asyncio.run(service.sync(timeout=2))
    finally:
        managed.close()
        external.close()
        server.stop()
        server.join()


def test_startup_failure_is_reported(registered_units, tmp_path):
    service = GraphService(("127.0.0.1", 0))
    server = service.create_server()
    managed = ExecutionSupervisor()
    try:
        doc = document(registered_units, tmp_path / "output")
        doc["nodes"][0]["component"] = registered_units["test.Broken"]
        result = managed.deploy(doc, str(service.address), 0)
        assert result["state"] == "failed"
        assert result["error"]
        assert managed._process is None
    finally:
        managed.close()
        server.stop()
        server.join()


def test_execution_api_revision_and_validation():
    from fastapi.testclient import TestClient

    from ezmsg.dashboard.backend.app import create_app

    class Service:
        async def startup(self):
            pass

        async def shutdown(self):
            pass

        async def health_payload(self):
            return {"graph_address": "127.0.0.1:25978"}

    with TestClient(create_app(graph_service=Service())) as client:
        assert client.get("/api/execution").json()["state"] == "stopped"
        assert client.post("/api/execution/stop", json={"expected_revision": 0}).status_code == 200
        assert client.post("/api/execution/stop", json={"expected_revision": 0}).status_code == 409
        result = client.post(
            "/api/execution/run",
            json={
                "expected_revision": 1,
                "document": {"version": 1, "nodes": [], "edges": []},
            },
        )
        assert result.status_code == 422
        assert client.get("/api/execution").json()["revision"] == 1


@pytest.mark.parametrize("collection_source", [False, True])
def test_external_binding_to_multiprocess_collection(registered_units, tmp_path, collection_source):
    from ezmsg.core import GraphContext

    from ezmsg.dashboard.backend.external_sources import external_sources

    service = GraphService(("127.0.0.1", 0))
    server = service.create_server()
    external, managed = ExecutionSupervisor(), ExecutionSupervisor()

    async def snapshot():
        async with GraphContext(service.address, auto_start=False) as context:
            return await context.snapshot()

    try:
        external_output, output = tmp_path / "external", tmp_path / "managed"
        external_doc = document(registered_units, external_output)
        if collection_source:
            external_doc["nodes"][0]["component"] = registered_units["test.SourceCollection"]
        ext = external.deploy(external_doc, str(service.address), 0)
        assert ext["state"] == "running", ext
        topic = ext["runtime_addresses"]["draft:source"] + "/OUTPUT"
        sources = asyncio.run(external_sources(str(service.address), managed.status()["root_name"]))
        assert {"topic": topic, "message_type": "builtins.int"} in sources
        doc = document(registered_units, output)
        doc["nodes"][0]["component"] = registered_units["test.Chain"]
        doc["nodes"][0]["settings"] = {}
        doc["external_inputs"] = [{"id": "external", "topic": topic, "target": "draft:source", "targetHandle": "INPUT"}]
        started = managed.deploy(doc, str(service.address), 0)
        assert started["state"] == "running", started
        wait_for_value(output, 7)
        snap = asyncio.run(snapshot())
        assert sum(any(u.startswith(started["root_name"] + "/") for u in p.units) for p in snap.processes.values()) == 2
        own_topics = asyncio.run(external_sources(str(service.address), started["root_name"]))
        assert all(not s["topic"].startswith(started["root_name"] + "/") for s in own_topics)
        invalid = json.loads(json.dumps(doc))
        invalid["external_inputs"][0]["topic"] = "missing/OUTPUT"
        with pytest.raises(ValueError, match="publisher unavailable"):
            managed.deploy(invalid, str(service.address), started["revision"], apply=True)
        invalid = json.loads(json.dumps(doc))
        invalid["nodes"][0]["settings"] = {"fail": True}
        with pytest.raises(ValueError, match="configuration failure"):
            managed.deploy(invalid, str(service.address), started["revision"], apply=True)
        assert managed.status()["revision"] == started["revision"]
        replacement_output = tmp_path / "replacement"
        doc["nodes"][1]["settings"]["path"] = str(replacement_output)
        applied = managed.deploy(doc, str(service.address), started["revision"], apply=True)
        assert applied["state"] == "running", applied
        wait_for_value(replacement_output, 7)
        managed.stop(applied["revision"])
        after = asyncio.run(snapshot())
        assert all(not target.startswith(started["root_name"] + "/") for edge in after.edge_owners for target in edge)
        assert all(
            edge in after.edge_owners
            for edge in snap.edge_owners
            if all(t.startswith(ext["root_name"] + "/") for t in edge)
        )
        before = external_output.stat().st_size
        time.sleep(0.2)
        assert external_output.stat().st_size > before
        assert external.status()["state"] == "running"
    finally:
        managed.close()
        external.close()
        server.stop()
        server.join()


def test_external_bindings_validate_saved_structure_and_live_type(registered_units, tmp_path):
    doc = document(registered_units, tmp_path / "output")
    binding = {"id": "external", "topic": "external/OUTPUT", "target": "draft:sink", "targetHandle": "INPUT"}
    doc["external_inputs"] = [binding]
    with pytest.raises(ValueError, match="type.*does not match"):
        prepare_document(doc, [{"topic": binding["topic"], "message_type": "builtins.str"}])
    prepare_document(doc, [{"topic": binding["topic"], "message_type": "builtins.int"}])
    doc["external_inputs"].append(dict(binding))
    with pytest.raises(ValueError, match="Duplicate external"):
        GraphDocument.model_validate(doc)


@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group cleanup")
def test_termination_distinguishes_completed_and_unexpected_exit(tmp_path, monkeypatch):
    from types import SimpleNamespace

    status = tmp_path / "status.json"
    process = SimpleNamespace(pid=123, returncode=0, poll=lambda: 0, wait=lambda timeout: 0)
    signalled = []
    monkeypatch.setattr(os, "killpg", lambda pid, sig: signalled.append(pid))
    status.write_text(json.dumps({"state": "stopped"}))
    ExecutionSupervisor._terminate(process, status)
    assert signalled == []
    # Exit code zero alone is insufficient: a worker that disappears while
    # marked running may have left children behind.
    status.write_text(json.dumps({"state": "running"}))
    ExecutionSupervisor._terminate(process, status)
    assert signalled == [123]


def test_component_names_are_valid_and_unique_including_legacy_names(registered_units, tmp_path):
    from ezmsg.dashboard.backend.execution_document import runtime_name

    doc = document(registered_units, tmp_path / "output")
    doc["nodes"][1]["name"] = runtime_name(doc["nodes"][0]["id"])
    with pytest.raises(ValueError, match="Duplicate component names"):
        GraphDocument.model_validate(doc)
    doc["nodes"][0]["name"] = "Filter"
    doc["nodes"][1]["name"] = "Filter"
    with pytest.raises(ValueError, match="Duplicate component names"):
        GraphDocument.model_validate(doc)
    doc["nodes"][1]["name"] = "filter"
    GraphDocument.model_validate(doc)  # Names are case-sensitive.
    for invalid in ("", "two words", "root/child", "1filter", "a" * 65):
        doc["nodes"][1]["name"] = invalid
        with pytest.raises(ValueError):
            GraphDocument.model_validate(doc)
