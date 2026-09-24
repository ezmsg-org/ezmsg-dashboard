"""Discover live, typed publishers without importing names advertised by peers."""

import asyncio

from ezmsg.core import GraphContext
from ezmsg.core.graphmeta import OutputStreamMetadata, OutputTopicMetadata
from ezmsg.core.netprotocol import Address


async def external_sources(graph_address: str, managed_root: str) -> list[dict]:
    async with GraphContext(Address.from_string(graph_address), auto_start=False) as context:
        snapshot, profiles = await asyncio.gather(context.snapshot(), context.profiling_snapshot_all())
    # Topic aliases have no publisher of their own. They are usable when a
    # live publisher reaches them through the graph's directed wiring.
    live = {
        p.topic
        for profile in profiles.values()
        for p in profile.publishers.values()
        if not p.topic.startswith(managed_root + "/")
    }
    pending = list(live)
    while pending:
        for target in snapshot.graph.get(pending.pop(), []):
            if target not in live and not target.startswith(managed_root + "/"):
                live.add(target)
                pending.append(target)
    types: dict[str, set[str]] = {}
    for session in snapshot.sessions.values():
        if session.metadata is None:
            continue
        for component in session.metadata.components.values():
            endpoints = {
                **getattr(component, "streams", {}),
                **getattr(component, "topics", {}),
                **getattr(component, "relays", {}),
            }
            for stream in endpoints.values():
                if isinstance(stream, (OutputStreamMetadata, OutputTopicMetadata)) and stream.address in live:
                    if not stream.address.startswith(managed_root + "/"):
                        types.setdefault(stream.address, set()).add(stream.msg_type)
    return [
        {"topic": topic, "message_type": next(iter(labels))}
        for topic, labels in sorted(types.items())
        if len(labels) == 1
    ]
