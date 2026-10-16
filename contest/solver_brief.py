"""Rival Solver user brief.

Discipline text lives in solver_brief.txt. Only the challenge block is
filled from list/start. This module does not mention reap, retire, or FGS.
"""

from __future__ import annotations

import os
from pathlib import Path

TEMPLATE_PATH = Path(__file__).with_name("solver_brief.txt")

_TOKENS = (
    ("@@UNIQUE_CODE@@", "unique_code"),
    ("@@DIFFICULTY@@", "difficulty"),
    ("@@LEVEL@@", "level"),
    ("@@SCORE@@", "score"),
    ("@@FLAG_COUNT@@", "flag_count"),
    ("@@TARGET@@", "target"),
    ("@@BUDGET_MIN@@", "budget_min"),
    ("@@DESCRIPTION@@", "description"),
)


def _plain(value, default: str = "unknown") -> str:
    if value is None:
        return default
    if isinstance(value, dict):
        for key in ("name", "label", "id", "value"):
            inner = value.get(key)
            if inner is not None and str(inner).strip():
                return str(inner).strip()
        return default
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value).strip()
    return text if text else default


def _first(source: dict, keys: tuple[str, ...]):
    for key in keys:
        if key not in source:
            continue
        value = source.get(key)
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        return value
    return None


def challenge_budget_min(challenge: dict | None = None) -> str:
    source = challenge or {}
    found = _first(source, ("time_budget_min", "budget_min", "time_limit_min", "budget"))
    if found is not None:
        return _plain(found)
    raw = os.environ.get("CONTEST_CHALLENGE_BUDGET_MIN", "60").strip() or "60"
    return raw


def challenge_fields(
    challenge: dict | None,
    addrs: list[str] | None,
    unique_code: str,
    *,
    target: str | None = None,
) -> dict[str, str]:
    """Fields the Solver brief and the workspace meta file share."""
    source = challenge if isinstance(challenge, dict) else {}
    flag_count = _first(source, ("total_flag_count", "flag_count"))
    score = _first(source, ("total_score", "score", "points"))
    return {
        "unique_code": _plain(unique_code, default="unknown"),
        "difficulty": _plain(_first(source, ("difficulty", "difficulty_name"))),
        "level": _plain(_first(source, ("level", "difficulty_level", "rank"))),
        "score": _plain(score),
        "flag_count": _plain(flag_count),
        "total_flag_count": _plain(flag_count),
        "target": target if target else "unknown",
        "budget_min": challenge_budget_min(source),
        "description": _plain(source.get("description"), default=""),
    }


def render_solver_brief(fields: dict[str, str], template: str | None = None) -> str:
    text = template if template is not None else TEMPLATE_PATH.read_text(encoding="utf-8")
    if not text.endswith("\n"):
        text += "\n"
    for token, key in _TOKENS:
        text = text.replace(token, fields.get(key, "unknown"))
    return text
