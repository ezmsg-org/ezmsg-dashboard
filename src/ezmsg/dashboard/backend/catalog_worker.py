"""Class metadata inspection; never constructs a component or its settings."""

from __future__ import annotations

import dataclasses
import inspect
import json
import sys
from pathlib import Path
from typing import TypeVar, get_args, get_origin

from .catalog import registrations


def type_label(tp: object) -> str:
    if isinstance(tp, type):
        return f"{tp.__module__}.{tp.__qualname__}"
    return str(tp)


def type_bindings(cls: type) -> dict:
    bindings = {}

    def walk(base: type, inherited: dict) -> None:
        for parent in base.__dict__.get("__orig_bases__", base.__bases__):
            origin = get_origin(parent) or parent
            args = [inherited.get(arg, arg) for arg in get_args(parent)]
            local = {**inherited, **dict(zip(getattr(origin, "__parameters__", ()), args))}
            bindings.update(local)
            if isinstance(origin, type) and origin is not object:
                walk(origin, local)

    walk(cls, {})
    return bindings


def describe(cls: type) -> dict:
    import ezmsg.core as ez

    if not inspect.isclass(cls) or not issubclass(cls, (ez.Unit, ez.Collection)) or inspect.isabstract(cls):
        raise TypeError("Registration must reference a concrete ezmsg Unit or Collection class")
    bindings = type_bindings(cls)
    ports = []
    for name, stream in cls.__streams__.items():
        tp = bindings.get(stream.msg_type, stream.msg_type)
        direction = (
            "input"
            if isinstance(stream, (ez.InputStream, ez.InputTopic, ez.InputRelay))
            else "output"
            if isinstance(stream, (ez.OutputStream, ez.OutputTopic, ez.OutputRelay))
            else "unknown"
        )
        ports.append(
            {
                "name": name,
                "direction": direction,
                "message_type": type_label(tp),
                "type_resolved": not isinstance(tp, TypeVar),
                "settings": name == "INPUT_SETTINGS",
            }
        )
    settings_type = cls.__settings_type__
    fields = []
    if dataclasses.is_dataclass(settings_type):
        for field in dataclasses.fields(settings_type):
            required = field.default is dataclasses.MISSING and field.default_factory is dataclasses.MISSING
            item = {"name": field.name, "required": required, "type": type_label(field.type)}
            # Do not execute default factories just to populate the catalog.
            if field.default is not dataclasses.MISSING:
                try:
                    json.dumps(field.default, allow_nan=False)
                    item["default"] = field.default
                except (TypeError, ValueError):
                    pass
            fields.append(item)
    schema, schema_error = None, None
    try:
        from pydantic import TypeAdapter

        schema = TypeAdapter(settings_type).json_schema(mode="validation")
    except Exception as exc:
        schema_error = str(exc)
    return {
        "available": True,
        "kind": "collection" if issubclass(cls, ez.Collection) else "unit",
        "description": inspect.getdoc(cls) or "",
        "ports": ports,
        "settings_fields": fields,
        "json_schema": schema,
        "schema_error": schema_error,
    }


def main() -> None:
    try:
        matches = [ep for record, ep in registrations() if record["id"] == sys.argv[1]]
        if len(matches) != 1:
            raise ValueError("Registration is missing or ambiguous")
        result = describe(matches[0].load())
    except BaseException as exc:
        result = {"available": False, "error": f"{type(exc).__name__}: {exc}"}
    Path(sys.argv[2]).write_text(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
