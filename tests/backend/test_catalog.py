import dataclasses
import importlib.metadata as metadata
import subprocess
from types import SimpleNamespace

import ezmsg.core as ez
import pytest
from fastapi.testclient import TestClient

from ezmsg.dashboard.backend import catalog
from ezmsg.dashboard.backend.app import create_app
from ezmsg.dashboard.backend.catalog_worker import describe


class Config(ez.Settings):
    required: int
    enabled: bool = True


class Parent(ez.Unit):
    INPUT = ez.InputStream(int)


class Child(Parent):
    SETTINGS = Config
    OUTPUT = ez.OutputStream(int)

    def __init__(self, *args, **kwargs):
        raise AssertionError("Catalog must not construct a Unit")


def fake_distribution(name, target):
    return SimpleNamespace(
        metadata={"Name": name},
        version="1.0",
        entry_points=[metadata.EntryPoint(name="example.Child", value=target, group=catalog.GROUP)],
    )


def test_enumeration_preserves_collisions_without_loading(monkeypatch):
    monkeypatch.setattr(
        metadata,
        "distributions",
        lambda: [fake_distribution("one", "missing.one:Child"), fake_distribution("two", "missing.two:Child")],
    )
    records = catalog.catalog_payload()["components"]
    assert len(records) == 2
    assert records[0]["id"] != records[1]["id"]
    assert records[0]["name"] == records[1]["name"]
    assert records == catalog.catalog_payload()["components"]


def test_inspection_inherits_ports_without_constructing_required_settings():
    details = describe(Child)
    assert {p["name"] for p in details["ports"]} == {"INPUT", "OUTPUT"}
    assert details["settings_fields"][0]["required"] is True
    assert details["json_schema"]["required"] == ["required"]


def test_default_factory_not_called():
    def fail():
        raise AssertionError("must not call factory")

    class FactoryConfig(ez.Settings):
        value: list = dataclasses.field(default_factory=fail)

    class FactoryUnit(ez.Unit):
        SETTINGS = FactoryConfig

    assert describe(FactoryUnit)["settings_fields"] == [{"name": "value", "required": False, "type": "builtins.list"}]


def test_timeout_keeps_registration_visible(monkeypatch):
    monkeypatch.setattr(metadata, "distributions", lambda: [fake_distribution("one", "missing:Child")])
    item = catalog.catalog_payload()["components"][0]

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("worker", 30)

    monkeypatch.setattr(subprocess, "run", timeout)
    result = catalog.component_details(item["id"])
    assert result["available"] is False
    assert result["name"] == item["name"]
    assert "timed out" in result["error"]


def test_catalog_routes_do_not_need_graph_connection(monkeypatch):
    monkeypatch.setattr(metadata, "distributions", lambda: [fake_distribution("one", "missing:Child")])
    client = TestClient(create_app())
    response = client.get("/api/components")
    assert response.status_code == 200
    assert len(response.json()["components"]) == 1
    assert client.get("/api/components/not-installed").status_code == 404


def test_wrong_registration_type_rejected():
    with pytest.raises(TypeError, match="concrete"):
        describe(str)
