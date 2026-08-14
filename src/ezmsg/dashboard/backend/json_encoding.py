"""Wire encoding for values JSON cannot represent natively.

JSON has no literal for ``inf``, ``-inf`` or ``nan``, and the two transports the
dashboard uses disagree about what to do with them: ``JSONResponse`` renders
with ``allow_nan=False`` and raises, while pydantic's ``model_dump(mode="json")``
silently rewrites them to ``null``. Settings classes are free to hold such
values (``clip_max: float = np.inf`` is perfectly reasonable), so the dashboard
encodes them as the string tokens below on the way out and decodes them again on
the way in.

The tokens are spelled the way JavaScript spells them, so the frontend can
recover the value with ``Number(token)``.
"""

from __future__ import annotations

import math
from typing import Any

INFINITY_TOKEN = "Infinity"
NEGATIVE_INFINITY_TOKEN = "-Infinity"
NAN_TOKEN = "NaN"

NON_FINITE_TOKENS = (INFINITY_TOKEN, NEGATIVE_INFINITY_TOKEN, NAN_TOKEN)


def encode_float(value: float) -> float | str:
    """Return ``value`` unchanged, or its token if it is not finite."""
    if math.isfinite(value):
        return value
    if math.isnan(value):
        return NAN_TOKEN
    return INFINITY_TOKEN if value > 0 else NEGATIVE_INFINITY_TOKEN


def decode_float_token(value: Any) -> float | None:
    """Return the float a token stands for, or ``None`` if it is not a token."""
    if not isinstance(value, str):
        return None
    if value == INFINITY_TOKEN:
        return math.inf
    if value == NEGATIVE_INFINITY_TOKEN:
        return -math.inf
    if value == NAN_TOKEN:
        return math.nan
    return None


def is_non_finite_token(value: Any) -> bool:
    return isinstance(value, str) and value in NON_FINITE_TOKENS


def sanitize_json_value(value: Any) -> Any:
    """Recursively encode non-finite floats anywhere in an already-JSON-safe payload.

    Applied to whole responses as a backstop; payloads built by
    :mod:`~ezmsg.dashboard.backend.services.adapters` are already encoded.
    """
    if isinstance(value, float):
        return encode_float(value)

    if isinstance(value, dict):
        return {key: sanitize_json_value(item) for key, item in value.items()}

    if isinstance(value, (list, tuple)):
        return [sanitize_json_value(item) for item in value]

    return value
