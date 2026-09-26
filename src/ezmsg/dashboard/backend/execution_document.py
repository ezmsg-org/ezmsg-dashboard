"""Validate saved definitions against installed classes, never saved port metadata."""

from __future__ import annotations

import hashlib
import inspect
import types
from typing import Any, Literal, TypeVar, Union, get_args, get_origin

import ezmsg.core as ez
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from .catalog import registrations
from .catalog_worker import type_bindings, type_label


class Registration(BaseModel):
    id: str
    name: str
    value: str
    distribution: str
    version: str


class NodeDefinition(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(pattern=r"^draft:.+", max_length=200)
    name: str | None = Field(default=None, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$", min_length=1, max_length=64)
    component: Registration
    settings: dict[str, Any]


class EdgeDefinition(BaseModel):
    id: str
    source: str
    sourceHandle: str
    target: str
    targetHandle: str


class ExternalInput(BaseModel):
    id: str
    topic: str = Field(min_length=1, max_length=2000)
    target: str
    targetHandle: str


class GraphDocument(BaseModel):
    model_config = ConfigDict(extra="ignore")
    version: Literal[1]
    nodes: list[NodeDefinition] = Field(min_length=1, max_length=1000)
    edges: list[EdgeDefinition] = Field(max_length=10000)

    external_inputs: list[ExternalInput] = Field(default_factory=list, max_length=10000)

    @model_validator(mode="after")
    def check_graph(self):
        ids = {node.id for node in self.nodes}
        if len(ids) != len(self.nodes):
            raise ValueError("Duplicate node IDs")
        names = [runtime_name(node.id, node.name) for node in self.nodes]
        if len(set(names)) != len(names):
            raise ValueError("Duplicate component names in managed graph")
        edge_ids, connections = set(), set()
        downstream = {node_id: [] for node_id in ids}
        incoming = dict.fromkeys(ids, 0)
        for edge in self.edges:
            if edge.source not in ids or edge.target not in ids:
                raise ValueError("Connection references a missing node")
            key = (edge.source, edge.sourceHandle, edge.target, edge.targetHandle)
            if edge.id in edge_ids or key in connections:
                raise ValueError("Duplicate connection")
            edge_ids.add(edge.id)
            connections.add(key)
            downstream[edge.source].append(edge.target)
            incoming[edge.target] += 1
        for binding in self.external_inputs:
            key = (binding.topic, binding.target, binding.targetHandle)
            if binding.target not in ids:
                raise ValueError("External connection references a missing node")
            if binding.id in edge_ids or key in connections:
                raise ValueError("Duplicate external connection")
            edge_ids.add(binding.id)
            connections.add(key)
        pending = [node for node in ids if not incoming[node]]
        visited = 0
        while pending:
            node = pending.pop()
            visited += 1
            for target in downstream[node]:
                incoming[target] -= 1
                if not incoming[target]:
                    pending.append(target)
        if visited != len(ids):
            raise ValueError("Connections must not contain cycles")
        return self


def runtime_name(node_id: str, name: str | None = None) -> str:
    if name is not None:
        return name
    return "node_" + hashlib.sha256(node_id.encode()).hexdigest()[:16]


def compatible(source, target) -> bool:
    # Conservative: unresolved generics require an explicit adapter before running.
    if isinstance(source, TypeVar) or isinstance(target, TypeVar):
        return False
    if target is Any or target is object:
        return True
    if source == target:
        return True
    if get_origin(source) in (Union, types.UnionType):
        # None is used by producer units to mean "no publication".
        args = [arg for arg in get_args(source) if arg is not type(None)]
        return bool(args) and all(compatible(arg, target) for arg in args)
    if get_origin(target) in (Union, types.UnionType):
        return any(compatible(source, arg) for arg in get_args(target))
    return isinstance(source, type) and isinstance(target, type) and issubclass(source, target)


def prepare_document(raw: dict, sources: list[dict] | None = None) -> tuple[GraphDocument, dict, dict]:
    document = GraphDocument.model_validate(raw)
    installed = {}
    for record, ep in registrations():
        installed.setdefault(record["id"], []).append((record, ep))
    classes, settings = {}, {}
    for node in document.nodes:
        matches = installed.get(node.component.id, [])
        if len(matches) != 1:
            raise ValueError(f"{node.component.name}: registration missing or ambiguous")
        record, ep = matches[0]
        if any(getattr(node.component, key) != record[key] for key in ("name", "value", "distribution", "version")):
            raise ValueError(f"{node.component.name}: installed registration/version differs from the saved document")
        cls = ep.load()
        if not inspect.isclass(cls) or not issubclass(cls, (ez.Unit, ez.Collection)) or inspect.isabstract(cls):
            raise ValueError(f"{node.component.name}: registration must be a concrete Unit or Collection")
        if getattr(cls, "__main__", None):
            raise ValueError(f"{node.component.name}: main-thread Units require a dedicated execution policy")
        settings_type = cls.__settings_type__
        adapter = TypeAdapter(settings_type)
        known = set(getattr(settings_type, "__dataclass_fields__", getattr(settings_type, "model_fields", {})))
        unknown = set(node.settings) - known
        if unknown:
            raise ValueError(f"{node.component.name}: unknown settings: {', '.join(sorted(unknown))}")
        try:
            settings[node.id] = adapter.validate_python(node.settings)
        except Exception as exc:
            raise ValueError(f"{node.component.name}: {exc}") from exc
        classes[node.id] = cls
    for edge in document.edges:
        source_cls, target_cls = classes[edge.source], classes[edge.target]
        source = source_cls.__streams__.get(edge.sourceHandle)
        target = target_cls.__streams__.get(edge.targetHandle)
        if not isinstance(source, (ez.OutputStream, ez.OutputTopic, ez.OutputRelay)) or not isinstance(
            target, (ez.InputStream, ez.InputTopic, ez.InputRelay)
        ):
            raise ValueError("Connections must join declared output and input streams")
        if edge.targetHandle == "INPUT_SETTINGS":
            raise ValueError("Settings channels cannot be wired by the graph builder")
        source_type = type_bindings(source_cls).get(source.msg_type, source.msg_type)
        target_type = type_bindings(target_cls).get(target.msg_type, target.msg_type)
        if not compatible(source_type, target_type):
            raise ValueError(f"Incompatible stream types: {source_type} → {target_type}")
    live = {source["topic"]: source["message_type"] for source in sources or []}
    for binding in document.external_inputs:
        if binding.topic not in live:
            raise ValueError(f"External publisher unavailable or untyped: {binding.topic}")
        cls = classes[binding.target]
        target = cls.__streams__.get(binding.targetHandle)
        if (
            not isinstance(target, (ez.InputStream, ez.InputTopic, ez.InputRelay))
            or binding.targetHandle == "INPUT_SETTINGS"
        ):
            raise ValueError("External connections must target declared data inputs")
        target_type = type_bindings(cls).get(target.msg_type, target.msg_type)
        # Remote metadata contains names, not Python types. Never import/eval these
        # names. Require exact declared types (or an explicitly universal input).
        if target_type not in (Any, object) and live[binding.topic] != type_label(target_type):
            raise ValueError(f"External publisher type {live[binding.topic]} does not match {type_label(target_type)}")
    return document, classes, settings


def construct_graph(raw: dict, sources: list[dict] | None = None):
    document, classes, settings = prepare_document(raw, sources)
    units = {node.id: classes[node.id](settings=settings[node.id]) for node in document.nodes}
    components = {runtime_name(node.id, node.name): units[node.id] for node in document.nodes}
    connections = [
        (units[e.source].streams[e.sourceHandle], units[e.target].streams[e.targetHandle]) for e in document.edges
    ]
    connections.extend((b.topic, units[b.target].streams[b.targetHandle]) for b in document.external_inputs)
    return components, connections
