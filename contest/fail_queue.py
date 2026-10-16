"""Fail-then-FGS queue.

New challenges stay on the baseline profile. A challenge enters this queue
only under the narrow fail rule (dead worker, deferred past grace, or an
optional budget retire). Disk state lives under ``$RUN/queue`` so a later
tick can dispatch one FGS pass without touching other workers.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from supervisor.core import (
    SupervisorError,
    challenge_code,
    is_completed,
    parse_utc_prefix,
    utc_now,
)

MODES = ("on_fail", "after_sec", "off")
_SAFE_CODE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
_SNAPSHOT_SKIP = frozenset({"node_modules", ".git"})
_MAX_SNAPSHOT_BYTES = 512 * 1024


def fgs_mode() -> str:
    """``on_fail`` (default), ``after_sec`` (PR#12 wall clock), or ``off``."""
    raw = os.environ.get("CONTEST_FGS_MODE", "on_fail").strip().lower() or "on_fail"
    aliases = {
        "fail": "on_fail",
        "on-fail": "on_fail",
        "after-sec": "after_sec",
        "wall": "after_sec",
        "legacy": "after_sec",
    }
    mode = aliases.get(raw, raw)
    if mode not in MODES:
        raise SupervisorError(
            f"CONTEST_FGS_MODE must be on_fail, after_sec, or off: {raw}"
        )
    return mode


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    text = str(raw).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    raise SupervisorError(f"{name} is not a boolean: {raw}")


def env_int_default(name: str, default: int, *, minimum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise SupervisorError(f"{name} is not an integer: {raw}") from exc
    if value < minimum:
        raise SupervisorError(f"{name} must be >= {minimum}: {raw}")
    return value


def fgs_max_active() -> int:
    return env_int_default("CONTEST_FGS_MAX_ACTIVE", 1, minimum=1)


def fgs_retry_last() -> bool:
    """True: never start FGS while a new challenge is still unattempted."""
    return env_bool("CONTEST_FGS_RETRY_LAST", True)


def fgs_max_retries() -> int:
    """How many FGS passes one challenge may start. ``0`` dispatches none."""
    return env_int_default("CONTEST_FGS_MAX_RETRIES", 1, minimum=0)


def fail_on_budget() -> bool:
    """Optional. Default off so a slow baseline worker is not retired."""
    return env_bool("CONTEST_FAIL_ON_BUDGET", False)


def stamp_utc(now: datetime | None = None) -> str:
    current = now or utc_now()
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def safe_code(code: str) -> str:
    text = str(code or "").strip()
    if not _SAFE_CODE.fullmatch(text) or text in (".", ".."):
        raise SupervisorError(f"unsafe challenge code for queue path: {code!r}")
    return text


def queue_root(run: Path) -> Path:
    return Path(run) / "queue"


def _marker(run: Path, bucket: str, code: str) -> Path:
    return queue_root(run) / bucket / safe_code(code)


def _touch_marker(path: Path, body: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(body, encoding="utf-8")


def mark_first_pass_started(run: Path, code: str) -> None:
    _touch_marker(_marker(run, "first_pass_started", code), code + "\n")


def first_pass_started(run: Path, code: str) -> bool:
    try:
        return _marker(run, "first_pass_started", code).is_file()
    except SupervisorError:
        return False


def mark_first_pass_done(run: Path, code: str) -> None:
    _touch_marker(_marker(run, "first_pass_done", code), code + "\n")


def first_pass_done(run: Path, code: str) -> bool:
    try:
        return _marker(run, "first_pass_done", code).is_file()
    except SupervisorError:
        return False


def fgs_done(run: Path, code: str) -> bool:
    try:
        return _marker(run, "fgs_done", code).is_file()
    except SupervisorError:
        return False


def mark_fgs_done(run: Path, code: str) -> None:
    _touch_marker(_marker(run, "fgs_done", code), code + "\n")


def fail_path(run: Path, code: str) -> Path:
    return queue_root(run) / "failed" / f"{safe_code(code)}.json"


def load_fail(run: Path, code: str) -> dict | None:
    path = fail_path(run, code)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _write_fail(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def register_fail(
    run: Path,
    *,
    unique_code: str,
    reason: str,
    artifact_dir: str,
    attempt: int = 1,
    problem_id: str = "",
    now: datetime | None = None,
) -> dict:
    """Create the fail record. A second call keeps the original ``failed_at``."""
    code = safe_code(unique_code)
    path = fail_path(run, code)
    existing = load_fail(run, code)
    if existing is not None:
        return existing
    record = {
        "unique_code": code,
        "failed_at": stamp_utc(now),
        "reason": str(reason or "reap"),
        "artifact_dir": str(artifact_dir or ""),
        "attempt": int(attempt),
        "problem_id": problem_id or "",
        "fgs_attempts": 0,
    }
    _write_fail(path, record)
    return record


def list_fails(run: Path) -> list[dict]:
    root = queue_root(run) / "failed"
    if not root.is_dir():
        return []
    found = []
    for path in sorted(root.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and data.get("unique_code"):
            found.append(data)
    found.sort(key=lambda item: (str(item.get("failed_at") or ""), str(item.get("unique_code") or "")))
    return found


def note_fgs_dispatch(run: Path, code: str, max_retries: int, *, now: datetime | None = None) -> dict:
    """Count one FGS launch. At the cap, write ``fgs_done`` so it cannot loop."""
    record = load_fail(run, code)
    if record is None:
        raise SupervisorError(f"FGS dispatch without a fail record: {code}")
    attempts = int(record.get("fgs_attempts") or 0) + 1
    record["fgs_attempts"] = attempts
    record["last_fgs_at"] = stamp_utc(now)
    _write_fail(fail_path(run, code), record)
    if attempts >= max_retries:
        mark_fgs_done(run, code)
    return record


def bump_failed_at(run: Path, code: str, *, now: datetime | None = None) -> None:
    """Move a retriable fail to the back of the FIFO."""
    record = load_fail(run, code)
    if record is None:
        return
    record["failed_at"] = stamp_utc(now)
    _write_fail(fail_path(run, code), record)


def snapshot_artifacts(src: Path | None, dest: Path) -> str:
    """Copy a baseline workspace. Keep the first snapshot if one already exists."""
    if dest.exists():
        return str(dest)
    if src is None or not Path(src).is_dir():
        return ""
    source = Path(src)
    dest.mkdir(parents=True, exist_ok=True)
    for item in source.rglob("*"):
        rel = item.relative_to(source)
        if any(part in _SNAPSHOT_SKIP for part in rel.parts):
            continue
        target = dest / rel
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if not item.is_file():
            continue
        try:
            if item.stat().st_size > _MAX_SNAPSHOT_BYTES:
                continue
        except OSError:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(item, target)
        except OSError:
            continue
    return str(dest)


def failure_reason(
    *,
    completed: bool,
    alive: bool,
    launched: bool,
    meta_state: str | None,
    deferred_past_grace: bool,
    budget_past: bool,
    fail_on_budget: bool,
    transport_glitch: bool,
) -> str | None:
    """Narrow fail rule. ``None`` means do not enqueue FGS.

    A platform list/close glitch is not a fail. A live worker is not a fail,
    including when flags are still missing. ``is_completed`` / meta ``solved``
    is a solved archive, never a fail.
    """
    if transport_glitch:
        return None
    state = str(meta_state or "").strip().lower()
    if completed or state == "solved":
        return None
    if state == "deferred" and deferred_past_grace:
        return "deferred"
    if fail_on_budget and budget_past:
        return "budget"
    if alive:
        return None
    if launched:
        return "reap"
    return None


def _challenge_map(challenges) -> dict[str, dict]:
    found = {}
    for item in challenges or []:
        if not isinstance(item, dict) or is_completed(item):
            continue
        code = challenge_code(item)
        if code:
            found[code] = item
    return found


def queue_new(challenges, *, run: Path, inflight: set[str], blocked: set[str]) -> list:
    """Challenges whose first pass has not started and that are not running."""
    failed_codes = {
        str(record.get("unique_code") or "").strip()
        for record in list_fails(run)
    }
    queue = []
    for item in challenges or []:
        if not isinstance(item, dict) or is_completed(item):
            continue
        code = challenge_code(item)
        if not code or code in inflight or code in blocked or code in failed_codes:
            continue
        try:
            if first_pass_started(run, code) or first_pass_done(run, code):
                continue
        except SupervisorError:
            continue
        queue.append(item)
    return queue


def queue_fgs(
    challenges,
    *,
    run: Path,
    inflight: set[str],
    blocked: set[str],
    max_retries: int,
) -> list[dict]:
    """Oldest fail first. Completed, inflight, and exhausted codes are out."""
    by_code = _challenge_map(challenges)
    chosen = []
    for record in list_fails(run):
        code = str(record.get("unique_code") or "").strip()
        if not code or code not in by_code or code in inflight or code in blocked:
            continue
        try:
            if fgs_done(run, code):
                continue
        except SupervisorError:
            continue
        if int(record.get("fgs_attempts") or 0) >= max_retries:
            continue
        chosen.append({"challenge": by_code[code], "record": record, "code": code})
    return chosen


def select_dispatch(
    challenges,
    *,
    run: Path,
    inflight: set[str],
    blocked: set[str],
    fgs_inflight: int,
    alive: int,
    active: int,
    cap: int,
    retry_last: bool,
    fgs_max_active: int,
    max_retries: int,
    list_failed: bool,
) -> list[dict]:
    """Pick this tick's visits.

    ``retry_last`` fills every free slot with new baseline work first. FGS
    starts only when that queue is empty, and at most ``fgs_max_active`` FGS
    workers run at once. ``retry_last`` false may take an FGS slot beside new
    work, still inside the same caps.
    """
    if list_failed:
        return []
    new_q = queue_new(challenges, run=run, inflight=inflight, blocked=blocked)
    fgs_q = queue_fgs(
        challenges,
        run=run,
        inflight=inflight,
        blocked=blocked,
        max_retries=max_retries,
    )
    fgs_room = max(0, int(fgs_max_active) - int(fgs_inflight))
    if retry_last and new_q:
        demand = len(new_q)
        take_fgs = 0
    elif retry_last:
        demand = len(fgs_q) if fgs_room else 0
        take_fgs = min(fgs_room, len(fgs_q))
    else:
        take_fgs = min(fgs_room, len(fgs_q))
        demand = len(new_q) + take_fgs
    from supervisor.core import dispatch_budget

    budget = dispatch_budget(alive, active, cap, demand)
    if budget <= 0:
        return []
    chosen = []
    if retry_last:
        if new_q:
            for item in new_q[:budget]:
                chosen.append({
                    "challenge": item,
                    "pass_kind": "first",
                    "code": challenge_code(item),
                    "record": None,
                })
            return chosen
        for item in fgs_q[: min(budget, take_fgs)]:
            chosen.append({
                "challenge": item["challenge"],
                "pass_kind": "fgs",
                "code": item["code"],
                "record": item["record"],
            })
        return chosen
    fgs_take = min(take_fgs, budget)
    new_take = min(len(new_q), budget - fgs_take)
    for item in new_q[:new_take]:
        chosen.append({
            "challenge": item,
            "pass_kind": "first",
            "code": challenge_code(item),
            "record": None,
        })
    for item in fgs_q[:fgs_take]:
        chosen.append({
            "challenge": item["challenge"],
            "pass_kind": "fgs",
            "code": item["code"],
            "record": item["record"],
        })
    return chosen


def plan_budget_retire(workers, challenges, *, now: datetime, enabled: bool) -> list[dict]:
    """Force-retire a live worker that outlived its budget. Default caller is off.

    Deferred and solved workers stay on ``plan_retire``. A challenge the
    platform already completed is not a budget fail.
    """
    if not enabled:
        return []
    completed = set()
    for item in challenges or []:
        if isinstance(item, dict) and is_completed(item):
            code = challenge_code(item)
            if code:
                completed.add(code)
    actions = []
    for worker in workers or []:
        if not worker.get("alive"):
            continue
        code = str(worker.get("code") or "").strip()
        if not code or code in completed:
            continue
        state = str(worker.get("meta_state") or "").strip().lower()
        if state in ("deferred", "solved"):
            continue
        try:
            minutes = float(worker.get("budget_min"))
        except (TypeError, ValueError):
            continue
        if minutes <= 0:
            continue
        started = parse_utc_prefix(str(worker.get("started_at") or ""))
        if started is None:
            continue
        elapsed = (now - started).total_seconds()
        if elapsed < minutes * 60:
            continue
        actions.append({
            "op": "retire",
            "code": code,
            "state": "budget",
            "pid": worker.get("pid"),
            "dir": worker.get("dir"),
            "archive": False,
            "remaining": 0,
            "grace": int(minutes * 60),
            "reason": "budget",
        })
    return actions


def _park_path(run: Path, code: str) -> Path:
    return queue_root(run) / "pending_classify" / f"{safe_code(code)}.json"


def park_unclassified(run: Path, code: str, info: dict) -> None:
    """Remember a finished worker while list/close is a transport glitch."""
    path = _park_path(run, code)
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(info, ensure_ascii=False) + "\n", encoding="utf-8")


def list_unclassified(run: Path) -> list[dict]:
    root = queue_root(run) / "pending_classify"
    if not root.is_dir():
        return []
    found = []
    for path in sorted(root.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and data.get("unique_code"):
            data["_path"] = str(path)
            found.append(data)
    return found


def discard_unclassified(run: Path, code: str) -> None:
    path = _park_path(run, code)
    try:
        path.unlink()
    except OSError:
        return
