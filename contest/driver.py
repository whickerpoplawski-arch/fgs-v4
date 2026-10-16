#!/usr/bin/env python3
"""TSecBench hosted contest driver (P0 skeleton).

One agent container runs a multi-challenge queue. Max active challenges is
about 3 (platform cap). Per visit, before any model turn:

  list → start → mkdir workdir/<id> → (FGS profile only) bootstrap → solver brief → dsh

``contest-baseline`` does not load the FGS bundle and does not pre-seed a graph.
The default mode (``CONTEST_FGS_MODE=on_fail``) keeps every new challenge on
that baseline. A challenge gets profile ``contest`` only on a later FGS pass,
after the narrow fail rule puts it on the FIFO retry queue. ``after_sec`` keeps
the old wall-clock switch (``CONTEST_FGS_AFTER_SEC``) and does not retry.
The choice is per new worker. A running worker is not hot-swapped and is not
killed to change profiles.

`dsh` is not vendored here. Unless CONTEST_DSH_LAUNCH=1 and `dsh` is on PATH,
the launch step records a stub under `.fgs/dsh-launch.json`.

Each solver gets ``FGS_UNIQUE_CODE`` set to that challenge's unique_code (the
same id used for start/close). ``BENCHMARK_*`` are copied through unchanged.

VPN (optional): CONTEST_VPN=1 requires CONTEST_VPN_CONFIG and CONTEST_VPN_EXEC.
Hosted sandbox VPN presence is ambiguous (integration docs vs upload page);
the default leaves VPN off and does not block pre-seed.

SOLVER_GATEWAY=1 rewrites model base URLs only: env vars such as
DEEPSEEK_BASE_URL / OPENAI_BASE_URL, and a contest profile's baseURL field,
become `http://<host>.tsecbench.gw/...` (https becomes http). It must not
rewrite BENCHMARK_BASE_URL, BENCHMARK_TOKEN, or Challenges API URLs.
BENCHMARK_BASE_URL is opaque platform injection and is used as given, even
when the platform already supplies a `.tsecbench.gw` host. Contest profiles
use stock DeepSeek Messages (``deepseek-official`` + ``https://api.deepseek.com/anthropic``).
Do not patch that provider id to openai-completions.

Offline fixture (no platform): CONTEST_FIXTURE=/path/to.json
  { "challenges": [ { "unique_code", "description", "is_completed", "container_addr": [] } ] }

CONTEST_SUPERVISOR defaults on. The loop lives in this process: reap containers
whose worker died, retire deferred/solved workers after grace, and start the
next visit only when both alive workers and active containers are under
CONTEST_MAX_ACTIVE. It does not exec contest/supervisor/autosup.sh (that is a
second scheduler for the worker-directory layout).

A platform list/start/close timeout or a dropped connection is logged and the
loop keeps ticking. Close is retried on a later tick and is not recorded as
done. ``CONTEST_HTTP_TIMEOUT`` bounds each call. A close timeout is not a lost
score; an uncaught one stops launch and submit for the rest of the run.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from fail_graph import collect_enrich
from fail_queue import (
    bump_failed_at,
    discard_unclassified,
    fail_on_budget,
    failure_reason,
    fgs_done,
    fgs_max_active,
    fgs_max_retries,
    fgs_mode,
    fgs_retry_last,
    list_unclassified,
    mark_first_pass_done,
    mark_first_pass_started,
    note_fgs_dispatch,
    park_unclassified,
    plan_budget_retire,
    queue_fgs,
    queue_new,
    register_fail,
    safe_code,
    select_dispatch,
    snapshot_artifacts,
    stamp_utc,
)
from solver_brief import challenge_fields, render_solver_brief
from supervisor.core import (
    PlatformTransportError,
    SupervisorError,
    acquire_lock,
    append_log,
    archive_worker,
    challenge_url,
    count_active,
    dispatch_budget,
    grace_settings,
    http_timeout,
    injected_platform_hosts,
    list_samplers,
    load_closed_set,
    mark_retired,
    perform_close,
    plan_gc_samplers,
    plan_reap,
    plan_retire,
    read_project_meta,
    release_lock,
    request_json,
    solver_child_env,
    terminate_pid,
    utc_now,
)

ROOT = Path(__file__).resolve().parent.parent
BOOTSTRAP = ROOT / "tools" / "bootstrap_project.mjs"
APPLY_ENRICH = ROOT / "tools" / "apply_enrich.mjs"
DEFAULT_CRITERION = "取得有效 flag 并 submit correct=true"
# Explicit allowlist. Do not scan os.environ for http(s) values: BENCHMARK_BASE_URL
# is opaque platform injection and may already be a *.tsecbench.gw host.
MODEL_URL_ENVS = (
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "SOLVER_BASE_URL",
    "DEEPSEEK_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "LLM_BASE_URL",
)
PROTECTED_ENVS = (
    "BENCHMARK_BASE_URL",
    "BENCHMARK_TOKEN",
    "PLATFORM_BASE_URL",
    "BENCHMARK_API_PREFIX",
)
PROFILE_URL_KEYS = ("baseURL", "baseUrl", "base_url")
MAX_ACTIVE = 3
_DRIVER_STARTED_MONO: float | None = None


class DriverError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"contest: {message}", file=sys.stderr)


def mark_driver_started() -> float:
    """Clock for ``CONTEST_FGS_AFTER_SEC``. Process start, not first visit."""
    global _DRIVER_STARTED_MONO
    _DRIVER_STARTED_MONO = time.monotonic()
    return _DRIVER_STARTED_MONO


def driver_elapsed(now: float | None = None) -> float:
    if _DRIVER_STARTED_MONO is None:
        mark_driver_started()
    current = time.monotonic() if now is None else now
    assert _DRIVER_STARTED_MONO is not None
    return max(0.0, current - _DRIVER_STARTED_MONO)


def baseline_profile_name() -> str:
    return os.environ.get("CONTEST_DSH_PROFILE", "contest-baseline").strip() or "contest-baseline"


def fgs_profile_name() -> str:
    return os.environ.get("CONTEST_DSH_PROFILE_FGS", "contest").strip() or "contest"


def profile_has_fgs(profile: str) -> bool:
    """True when this worker's profile name is the FGS profile.

    Running workers are not rewritten. Callers only use this for a worker
    that is about to start.
    """
    return profile == fgs_profile_name()


def fgs_after_sec() -> float | None:
    """Seconds from driver start before new workers use the FGS profile.

    Read only when ``CONTEST_FGS_MODE=after_sec``. ``on_fail`` (the default)
    ignores this knob. ``0`` selects the FGS profile immediately. A negative
    number, or ``off`` / ``never`` / ``false`` / ``no``, keeps the baseline
    profile for every new worker. The default number is 7200.
    """
    raw = os.environ.get("CONTEST_FGS_AFTER_SEC", "7200").strip() or "7200"
    if raw.lower() in ("off", "never", "false", "no"):
        return None
    try:
        value = float(raw)
    except ValueError as exc:
        raise DriverError(f"CONTEST_FGS_AFTER_SEC is not a number: {raw}") from exc
    if value < 0:
        return None
    return value


def _fmt_after(value: float | None) -> str:
    if value is None:
        return "off"
    if value.is_integer():
        return str(int(value))
    return f"{value:g}"


def profile_for_now(*, elapsed: float | None = None, now: float | None = None) -> str:
    """Wall-clock profile. Only ``CONTEST_FGS_MODE=after_sec`` honors the deadline.

    ``on_fail`` and ``off`` always return the baseline profile here. FGS is
    chosen by ``profile_for_visit(pass_kind="fgs")``, not by elapsed time.
    Resolved on every call. This does not signal any pid.
    """
    if elapsed is None:
        elapsed = driver_elapsed(now)
    mode = fgs_mode()
    if mode != "after_sec":
        selected = baseline_profile_name()
        after = "ignored" if mode == "on_fail" else "off"
        log(
            f"dsh profile select: elapsed={elapsed:.1f} FGS_AFTER={after} mode={mode} "
            f"→ {selected} (FGS off)"
        )
        return selected
    after = fgs_after_sec()
    if after is None or elapsed < after:
        selected = baseline_profile_name()
    else:
        selected = fgs_profile_name()
    flag = "FGS on" if profile_has_fgs(selected) else "FGS off"
    log(
        f"dsh profile select: elapsed={elapsed:.1f} FGS_AFTER={_fmt_after(after)} "
        f"→ {selected} ({flag})"
    )
    return selected


def profile_for_visit(pass_kind: str, *, elapsed: float | None = None, now: float | None = None) -> str:
    """Profile for one visit. ``first`` is baseline unless mode is ``after_sec``.

    ``fgs`` selects the FGS profile only in ``on_fail`` (and in ``after_sec``
    if the wall clock has already passed). ``off`` never selects it.
    """
    kind = "fgs" if str(pass_kind or "").strip().lower() == "fgs" else "first"
    mode = fgs_mode()
    if kind == "first" and mode != "after_sec":
        if elapsed is None:
            elapsed = driver_elapsed(now)
        selected = baseline_profile_name()
        after = "ignored" if mode == "on_fail" else "off"
        log(
            f"dsh profile select: pass=first elapsed={elapsed:.1f} FGS_AFTER={after} "
            f"mode={mode} → {selected} (FGS off)"
        )
        return selected
    if kind == "fgs" and mode == "on_fail":
        selected = fgs_profile_name()
        log(f"dsh profile select: pass=fgs mode=on_fail → {selected} (FGS on)")
        return selected
    if kind == "fgs" and mode == "off":
        selected = baseline_profile_name()
        log(f"dsh profile select: pass=fgs mode=off → {selected} (FGS off)")
        return selected
    return profile_for_now(elapsed=elapsed, now=now)


def should_seed_fgs(profile: str) -> bool:
    """``CONTEST_SKIP_FGS_SEED=auto`` seeds only the FGS profile."""
    raw = os.environ.get("CONTEST_SKIP_FGS_SEED", "auto").strip().lower() or "auto"
    if raw in ("1", "true", "yes", "on"):
        return False
    if raw in ("0", "false", "no", "off"):
        return True
    return profile_has_fgs(profile)


def display_target(addrs: list[str]) -> str:
    """Rival briefs show ``IP:port`` without a scheme."""
    shown: list[str] = []
    for raw in addrs:
        text = str(raw or "").strip()
        if not text:
            continue
        if "://" not in text:
            shown.append(text)
            continue
        parts = urllib.parse.urlsplit(text)
        host = parts.hostname or ""
        if host and parts.port:
            shown.append(f"{host}:{parts.port}")
        elif host:
            path = parts.path or ""
            shown.append(host if path in ("", "/") else f"{host}{path}")
        else:
            shown.append(text)
    return ", ".join(shown) if shown else "unknown"


def normalize_problem_id(raw: str) -> str:
    """Match ProjectRegistry.normalizeId: lower-case, illegal chars to `_`, max 64."""
    text = str(raw or "").strip().lower()
    return re.sub(r"[^a-z0-9_-]", "_", text)[:64]


def protected_platform_hosts() -> set[str]:
    """Hosts of the injected Challenges API. Model rewrite must leave them unchanged."""
    return injected_platform_hosts()


def is_protected_platform_url(url: str) -> bool:
    """True for the platform host and for any Challenges API path."""
    parts = urllib.parse.urlsplit(str(url or "").strip())
    host = (parts.hostname or "").lower()
    if not host:
        return False
    protected = protected_platform_hosts()
    if host in protected or (host.endswith(".tsecbench.gw") and _bare_gateway_host(host) in protected):
        return True
    path = parts.path or ""
    return "/api/v1/challenges" in path or "/openapi/v1/challenges" in path


def _bare_gateway_host(host: str) -> str:
    suffix = ".tsecbench.gw"
    return host[: -len(suffix)] if host.endswith(suffix) else host


def rewrite_model_base(url: str) -> str:
    """Apply the hosted gateway rewrite when SOLVER_GATEWAY=1.

    https://api.deepseek.com/v1 → http://api.deepseek.com.tsecbench.gw/v1
    Hosts that already end in `.tsecbench.gw` are not double-suffixed.
    BENCHMARK_BASE_URL is never rewritten, even when it already ends in
    ``.tsecbench.gw``. Challenges API URLs are returned unchanged.
    """
    raw = str(url or "").strip()
    if not raw or os.environ.get("SOLVER_GATEWAY") != "1":
        return raw
    parts = urllib.parse.urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return raw
    if is_protected_platform_url(raw):
        return raw
    host = parts.hostname
    if not host.endswith(".tsecbench.gw"):
        host = host + ".tsecbench.gw"
    netloc = host
    if parts.port:
        netloc = f"{host}:{parts.port}"
    if parts.username:
        auth = parts.username
        if parts.password:
            auth = f"{auth}:{parts.password}"
        netloc = f"{auth}@{netloc}"
    return urllib.parse.urlunsplit(("http", netloc, parts.path, parts.query, parts.fragment))


def _profile_dirs() -> list[Path]:
    """Contest profile roots.

    ``CONTEST_DSH_PROFILE_DIR`` is the only root when set (tests use this).
    Otherwise ``$DSH_HOME/profiles`` is scanned. ``~/.dsh`` is not implied, so a
    local ``SOLVER_GATEWAY=1`` run does not rewrite a developer profile.
    """
    explicit = os.environ.get("CONTEST_DSH_PROFILE_DIR", "").strip()
    if explicit:
        return [Path(explicit)]
    dsh_home = os.environ.get("DSH_HOME", "").strip()
    if dsh_home:
        return [Path(dsh_home) / "profiles"]
    return []


def _rewrite_yaml_profile(text: str) -> str:
    """Rewrite only baseURL keys. Other URL lines, including the platform host, stay."""
    pattern = re.compile(r"^(\s*)(baseURL|baseUrl|base_url)(\s*:\s*)(.*)$")
    lines: list[str] = []
    changed = False
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        ending = line[len(body) :]
        match = pattern.match(body)
        if not match:
            lines.append(line)
            continue
        raw_value = match.group(4).strip()
        quote = ""
        comment = ""
        inner = raw_value
        if raw_value[:1] in ("'", '"'):
            quote = raw_value[0]
            end = raw_value.find(quote, 1)
            if end < 0:
                lines.append(line)
                continue
            inner = raw_value[1:end]
            comment = raw_value[end + 1 :]
        elif " #" in raw_value:
            inner, comment = raw_value.split(" #", 1)
            inner = inner.strip()
            comment = " #" + comment
        if not inner or is_protected_platform_url(inner):
            lines.append(line)
            continue
        rewritten = rewrite_model_base(inner)
        if rewritten == inner:
            lines.append(line)
            continue
        rendered = f"{quote}{rewritten}{quote}{comment}" if quote else f"{rewritten}{comment}"
        lines.append(f"{match.group(1)}{match.group(2)}{match.group(3)}{rendered}{ending}")
        changed = True
    return "".join(lines) if changed else text


def _rewrite_json_profile(node) -> bool:
    changed = False
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if key in PROFILE_URL_KEYS and isinstance(value, str):
                if value and not is_protected_platform_url(value):
                    rewritten = rewrite_model_base(value)
                    if rewritten != value:
                        node[key] = rewritten
                        changed = True
            elif isinstance(value, (dict, list)) and _rewrite_json_profile(value):
                changed = True
    elif isinstance(node, list):
        for item in node:
            if isinstance(item, (dict, list)) and _rewrite_json_profile(item):
                changed = True
    return changed


def rewrite_profile_bases() -> None:
    """Rewrite contest-profile baseURL fields only. Never walk arbitrary URL strings."""
    if os.environ.get("SOLVER_GATEWAY") != "1":
        return
    for root in _profile_dirs():
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if "node_modules" in path.parts or ".git" in path.parts:
                continue
            if path.suffix.lower() not in {".json", ".yml", ".yaml"}:
                continue
            try:
                if path.stat().st_size > 1_000_000:
                    continue
                original = path.read_text(encoding="utf-8")
            except OSError as exc:
                log(f"profile rewrite skipped {path}: {exc}")
                continue
            if path.suffix.lower() == ".json":
                try:
                    payload = json.loads(original)
                except json.JSONDecodeError:
                    log(f"profile rewrite skipped {path}: not JSON")
                    continue
                if not _rewrite_json_profile(payload):
                    continue
                path.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                log(f"rewrote profile baseURL in {path}")
                continue
            rewritten = _rewrite_yaml_profile(original)
            if rewritten == original:
                continue
            path.write_text(rewritten, encoding="utf-8")
            log(f"rewrote profile baseURL in {path}")


def apply_gateway_rewrites() -> None:
    """Rewrite model endpoints onto *.tsecbench.gw.

    BENCHMARK_* is restored verbatim. A platform-injected Challenges host that
    already ends in ``.tsecbench.gw`` stays that way and is still called.
    """
    if os.environ.get("SOLVER_GATEWAY") != "1":
        log("SOLVER_GATEWAY is off; model base URLs are unchanged")
        return
    saved = {name: os.environ.get(name) for name in PROTECTED_ENVS}
    for name in MODEL_URL_ENVS:
        if name in PROTECTED_ENVS:
            continue
        current = os.environ.get(name, "").strip()
        if not current or is_protected_platform_url(current):
            continue
        rewritten = rewrite_model_base(current)
        if rewritten != current:
            os.environ[name] = rewritten
            log(f"rewrote {name}: {current} → {rewritten}")
    for name, value in saved.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    benchmark = os.environ.get("BENCHMARK_BASE_URL", "").strip()
    if benchmark:
        log(f"BENCHMARK_BASE_URL unchanged: {benchmark}")
    rewrite_profile_bases()


def require_platform_env() -> None:
    missing = [
        name
        for name in ("BENCHMARK_TOKEN", "BENCHMARK_BASE_URL")
        if not os.environ.get(name, "").strip()
    ]
    if missing:
        raise DriverError(
            "missing "
            + ", ".join(missing)
            + " (platform injects these at runtime; do not bake them into the image)"
        )


def vpn_preflight() -> None:
    flag = os.environ.get("CONTEST_VPN", "").strip().lower()
    enabled = flag in ("1", "true", "yes", "on")
    if not enabled:
        log(
            "VPN off (CONTEST_VPN unset). Integration docs say challenge addresses "
            "need a task VPN; the hosted upload page does not say the sandbox "
            "includes one. P0 does not block pre-seed on that ambiguity."
        )
        return
    config = os.environ.get("CONTEST_VPN_CONFIG", "").strip()
    if not config or not os.path.isfile(config):
        raise DriverError("CONTEST_VPN=1 but CONTEST_VPN_CONFIG is missing or not a file")
    command = os.environ.get("CONTEST_VPN_EXEC", "").strip()
    if not command:
        raise DriverError(
            "CONTEST_VPN=1 but CONTEST_VPN_EXEC is empty "
            "(this skeleton does not bundle an OpenVPN client)"
        )
    log(f"VPN toggle on; running CONTEST_VPN_EXEC (config {config})")
    subprocess.run(shlex.split(command), check=True)


def _request(method: str, url: str, token: str, body: dict | None = None):
    """Platform HTTP used by list and start.

    The default limit is 30s. ``CONTEST_HTTP_TIMEOUT`` overrides it, including
    the close path in the supervisor. Transport failures become ``DriverError``
    so a timeout cannot escape the visit or the supervisor loop.
    """
    try:
        return request_json(method, url, token, body, timeout=30)
    except SupervisorError as exc:
        raise DriverError(str(exc)) from exc


def coerce_challenges(payload) -> list:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("challenges", "data", "items", "results"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
    raise DriverError("list_challenges response has no challenge list")


def container_addrs(payload) -> list[str]:
    """Pull challenge addresses out of a list response or a start response."""
    if isinstance(payload, list):
        found: list[str] = []
        for item in payload:
            if isinstance(item, str) and item.strip():
                found.append(item.strip())
            elif isinstance(item, dict):
                found.extend(container_addrs(item))
        return found
    if not isinstance(payload, dict):
        return []
    for key in ("container_addr", "containerAddr", "addrs", "address", "addr"):
        if key not in payload:
            continue
        value = payload[key]
        if isinstance(value, str) and value.strip():
            return [value.strip()]
        if isinstance(value, (list, dict)):
            found = container_addrs(value)
            if found:
                return found
    for key in ("data", "challenge", "result"):
        value = payload.get(key)
        if isinstance(value, (dict, list)):
            found = container_addrs(value)
            if found:
                return found
    return []


def api_prefixes() -> list[str]:
    explicit = os.environ.get("BENCHMARK_API_PREFIX", "").strip()
    if explicit:
        if not explicit.startswith("/"):
            explicit = "/" + explicit
        return [explicit.rstrip("/")]
    # SDK docs use /api/v1; the local bench and tools/submit_flag.mjs use /openapi/v1.
    return ["/api/v1", "/openapi/v1"]


def list_challenges_live(base: str, token: str):
    errors = []
    for prefix in api_prefixes():
        try:
            url = challenge_url(base, prefix + "/challenges")
        except SupervisorError as exc:
            raise DriverError(str(exc)) from exc
        try:
            _status, payload = _request("GET", url, token)
        except DriverError as exc:
            errors.append(str(exc))
            continue
        return prefix, coerce_challenges(payload)
    raise DriverError("list_challenges failed: " + " | ".join(errors))


def start_challenge_live(base: str, prefix: str, token: str, code: str) -> list[str]:
    """POST ``{prefix}/challenges/start?unique_code=`` with body ``{}``.

    Hosted FastAPI requires ``unique_code`` as a query parameter. A JSON body
    alone is HTTP 422 (``loc`` is ``["query", "unique_code"]``). The path form
    ``/challenges/{code}/start`` is HTTP 404 on this platform and is not called.

    ``prefix`` is the one ``list_challenges_live`` already selected
    (``/openapi/v1`` on the hosted bench). An empty prefix retries
    ``api_prefixes()`` with the same query shape, including ``/api/v1``.
    """
    query = urllib.parse.urlencode({"unique_code": code})
    prefixes = [prefix] if prefix else api_prefixes()
    errors = []
    for item in prefixes:
        path = f"{item}/challenges/start?{query}"
        try:
            url = challenge_url(base, path)
        except SupervisorError as exc:
            raise DriverError(str(exc)) from exc
        try:
            _status, payload = _request("POST", url, token, {})
        except DriverError as exc:
            errors.append(str(exc))
            continue
        addrs = container_addrs(payload)
        if addrs:
            return addrs
        errors.append(f"{url} returned no container_addr")
    raise DriverError("start_challenge failed: " + " | ".join(errors))


def load_fixture(path: Path) -> list:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DriverError(f"CONTEST_FIXTURE unreadable: {exc}") from exc
    return coerce_challenges(payload)


def is_completed(challenge: dict) -> bool:
    if challenge.get("is_completed") is True or challenge.get("completed") is True:
        return True
    status = str(challenge.get("status") or "").lower()
    return status in ("completed", "solved", "passed")


def compose_brief(description: str, addrs: list[str]) -> str:
    addr_text = ", ".join(addrs)
    text = (description or "").strip()
    return (
        f"{text}\n"
        f"container_addr: {addr_text}\n"
        "只做本题。凭证在运行时环境里，不要写入镜像。"
    )


def bootstrap(
    cwd: Path,
    problem_id: str,
    brief: str,
    target: str,
    unique_code: str | None = None,
) -> dict:
    if not BOOTSTRAP.is_file():
        raise DriverError(f"missing bootstrap writer: {BOOTSTRAP}")
    argv = [
        "node",
        str(BOOTSTRAP),
        "--cwd",
        str(cwd),
        "--problem-id",
        problem_id,
        "--brief",
        brief,
        "--target",
        target,
        "--criterion",
        os.environ.get("FGS_CRITERION", DEFAULT_CRITERION),
    ]
    code = str(unique_code or "").strip()
    if code:
        argv.extend(["--unique-code", code])
    proc = subprocess.run(
        argv,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.stderr.strip():
        log(proc.stderr.strip())
    if proc.returncode != 0:
        raise DriverError(proc.stderr.strip() or proc.stdout.strip() or "bootstrap failed")
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        raise DriverError(f"bootstrap returned non-JSON: {proc.stdout!r}") from exc


def apply_enrich(cwd: Path, problem_id: str, payload: dict) -> dict:
    """Write baseline facts onto an already seeded graph. Empty payload is a no-op."""
    if payload.get("empty"):
        return {"ok": True, "status": "empty", "facts": 0}
    if not APPLY_ENRICH.is_file():
        raise DriverError(f"missing enrich writer: {APPLY_ENRICH}")
    blob = cwd / ".fgs" / "enrich-input.json"
    blob.parent.mkdir(parents=True, exist_ok=True)
    blob.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    proc = subprocess.run(
        ["node", str(APPLY_ENRICH), "--cwd", str(cwd), "--problem-id", problem_id, "--payload", str(blob)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.stderr.strip():
        log(proc.stderr.strip())
    if proc.returncode != 0:
        raise DriverError(proc.stderr.strip() or proc.stdout.strip() or "enrich failed")
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        raise DriverError(f"enrich returned non-JSON: {proc.stdout!r}") from exc


def reusable_container(challenge: dict) -> list[str]:
    """Active container with an address. Second pass prefers this over start."""
    status = str(challenge.get("container_status") or "").strip().lower()
    if status not in ("available", "pending", "stop_pending"):
        return []
    return container_addrs(challenge)


def assert_seeded(cwd: Path, problem_id: str) -> None:
    competition = cwd / ".fgs" / "competition.json"
    graph = cwd / ".fgs" / "projects" / problem_id / "graph.yaml"
    if not competition.is_file() or not graph.is_file():
        raise DriverError(f"seed missing under {cwd}")
    index = json.loads(competition.read_text(encoding="utf-8"))
    if index.get("activeProblemId") != problem_id:
        raise DriverError(
            f"activeProblemId={index.get('activeProblemId')!r} expected {problem_id}"
        )
    text = graph.read_text(encoding="utf-8")
    if "fact_origin" not in text or "goal_final" not in text:
        raise DriverError(f"graph missing fact_origin/goal_final: {graph}")


def write_challenge_meta(
    cwd: Path,
    *,
    problem_id: str,
    unique_code: str,
    challenge: dict | None,
    addrs: list[str],
    profile: str,
    api_prefix: str | None,
) -> dict[str, str]:
    fields = challenge_fields(challenge, addrs, unique_code, target=display_target(addrs))
    payload = {
        **fields,
        "problem_id": problem_id,
        "container_addr": list(addrs),
        "api_prefix": api_prefix or "",
        "profile": profile,
        "fgs": profile_has_fgs(profile),
    }
    meta_dir = cwd / ".contest"
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / "challenge.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return fields


def launch_dsh(
    cwd: Path,
    problem_id: str,
    *,
    unique_code: str | None = None,
    background: bool = False,
    profile: str | None = None,
    challenge: dict | None = None,
    addrs: list[str] | None = None,
    api_prefix: str | None = None,
    pass_kind: str = "first",
):
    """Start the solver in ``cwd``.

    Returns a ``Popen`` when ``background`` is set and a real command exists.
    The stub path writes ``.fgs/dsh-launch.json`` and returns None. The prompt
    is the Solver brief: it does not mention reap, retire, or autosup.

    The child env copies the parent (so ``BENCHMARK_*`` / ``SOLVER_GATEWAY``
    are not rewritten) and sets ``FGS_UNIQUE_CODE`` to this challenge's id,
    the same value start/close use. The parent environment is left unchanged.

    ``profile`` is resolved here when the caller did not already choose one,
    so a worker started after the FGS deadline does not keep a stale name.
    """
    code = str(unique_code if unique_code is not None else problem_id).strip()
    chosen = profile if profile is not None else profile_for_now()
    env = solver_child_env(code)
    fields = write_challenge_meta(
        cwd,
        problem_id=problem_id,
        unique_code=code,
        challenge=challenge,
        addrs=list(addrs or []),
        profile=chosen,
        api_prefix=api_prefix,
    )
    prompt = cwd / "prompt.txt"
    prompt.write_text(render_solver_brief(fields), encoding="utf-8")
    command = solver_argv(prompt, chosen)
    record = {
        "problemId": problem_id,
        "cwd": str(cwd),
        "stub": command is None,
        "command": command
        or [
            shutil.which(os.environ.get("CONTEST_DSH_BIN", "dsh")) or "dsh",
            "--profile",
            chosen,
            "--json",
            str(prompt),
        ],
        "provider": "deepseek-official",
        "protocol": "anthropic_messages",
        "profile": chosen,
        "fgs": profile_has_fgs(chosen),
        "pass": "fgs" if str(pass_kind).strip().lower() == "fgs" else "first",
        "uniqueCode": code,
        "note": (
            "Harness is not launched unless CONTEST_DSH_LAUNCH=1 and dsh is on PATH "
            "(or CONTEST_WORKER_CMD is set). "
            "Profiles use stock DeepSeek Messages. Do not patch deepseek-official to openai-completions. "
            "Baseline workers submit with benchmark_submit_flag, not fgs_satisfy_goal."
        ),
    }
    marker_dir = cwd / ".fgs"
    marker_dir.mkdir(parents=True, exist_ok=True)
    marker = marker_dir / "dsh-launch.json"
    if command is None:
        marker.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log(f"dsh launch stub for {problem_id} profile={chosen} (set CONTEST_DSH_LAUNCH=1 when the harness is installed)")
        return None
    log(f"launch solver cwd={cwd} background={background} unique_code={code} profile={chosen}")
    if background:
        proc = subprocess.Popen(command, cwd=str(cwd), env=env, start_new_session=True)
        record["pid"] = proc.pid
        record["stub"] = False
        marker.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return proc
    marker.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    subprocess.run(command, cwd=str(cwd), env=env, check=False)
    return None


def _record_pass(cwd: Path, pass_kind: str, profile: str) -> None:
    path = cwd / ".contest" / "passes.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(
        {"pass": pass_kind, "profile": profile, "fgs": profile_has_fgs(profile)},
        ensure_ascii=False,
    )
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def visit(
    challenge: dict,
    *,
    base: str,
    prefix: str | None,
    token: str,
    workdir: Path,
    fixture: bool,
    background: bool = False,
    pass_kind: str = "first",
    enrich_dir: str | None = None,
    fail_reason: str = "",
    reuse_ok: bool = True,
) -> dict:
    raw_code = str(challenge.get("unique_code") or challenge.get("code") or "").strip()
    problem_id = normalize_problem_id(raw_code)
    if not problem_id or not re.fullmatch(r"[a-z0-9_-]{1,64}", problem_id):
        return {"ok": False, "problemId": raw_code, "code": raw_code, "error": f"bad problem id: {raw_code!r}"}
    kind = "fgs" if str(pass_kind or "").strip().lower() == "fgs" else "first"
    started = False
    try:
        reused = False
        if fixture:
            addrs = container_addrs(challenge)
        elif kind == "fgs" and reuse_ok:
            addrs = reusable_container(challenge)
            if addrs:
                reused = True
                log(f"reuse container {problem_id or raw_code}")
            else:
                addrs = start_challenge_live(base, prefix or "", token, raw_code)
                started = True
                log(f"restart container {problem_id or raw_code}")
        else:
            addrs = start_challenge_live(base, prefix or "", token, raw_code)
            started = True
        if not addrs:
            raise DriverError("start returned empty container_addr; skip bootstrap and dsh")
        cwd = workdir / problem_id
        cwd.mkdir(parents=True, exist_ok=True)
        profile = profile_for_visit(kind)
        status = "skipped-seed"
        launched_id = problem_id
        enrich_note = "skip"
        if should_seed_fgs(profile):
            brief = compose_brief(str(challenge.get("description") or ""), addrs)
            target = ", ".join(addrs)
            seeded = bootstrap(cwd, problem_id, brief, target, unique_code=raw_code)
            assert_seeded(cwd, seeded.get("problemId") or problem_id)
            status = seeded.get("status") or "seeded"
            launched_id = seeded.get("problemId") or problem_id
            if kind == "fgs":
                payload = collect_enrich(enrich_dir, reason=fail_reason)
                enrich_path = cwd / ".fgs" / "enrich-input.json"
                enrich_path.parent.mkdir(parents=True, exist_ok=True)
                enrich_path.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                if payload.get("empty"):
                    enrich_note = "empty"
                    log(f"enrich=empty code={raw_code}")
                else:
                    try:
                        applied = apply_enrich(cwd, launched_id, payload)
                    except DriverError as exc:
                        enrich_note = "error"
                        log(f"enrich failed code={raw_code}: {exc}")
                    else:
                        count = int(applied.get("facts") or 0)
                        enrich_note = "empty" if applied.get("status") == "empty" or count == 0 else f"facts:{count}"
                        log(f"enrich={enrich_note} code={raw_code}")
        proc = launch_dsh(
            cwd,
            launched_id,
            unique_code=raw_code,
            background=background,
            profile=profile,
            challenge=challenge,
            addrs=addrs,
            api_prefix=prefix,
            pass_kind=kind,
        )
        _record_pass(cwd, kind, profile)
        if kind == "fgs":
            log(f"visit {problem_id} {status} pass=fgs enrich={enrich_note}")
        else:
            log(f"visit {problem_id} {status} pass=first")
        fields = challenge_fields(challenge, addrs, raw_code, target=display_target(addrs))
        result = {
            "ok": True,
            "problemId": problem_id,
            "code": raw_code,
            "status": status,
            "profile": profile,
            "fgs": profile_has_fgs(profile),
            "pass": kind,
            "enrich": enrich_note,
            "cwd": str(cwd),
            "started": started,
            "reused": reused,
            "budget_min": fields.get("budget_min") or "",
        }
        if proc is not None:
            result["pid"] = proc.pid
            result["proc"] = proc
            result["launched"] = True
        return result
    except (DriverError, OSError, subprocess.CalledProcessError) as exc:
        log(f"visit {problem_id or raw_code} failed: {exc}")
        return {
            "ok": False,
            "problemId": problem_id or raw_code,
            "code": raw_code,
            "error": str(exc),
            "started": started,
            "close": started,
        }


def concurrency() -> int:
    source = "CONTEST_MAX_ACTIVE" if os.environ.get("CONTEST_MAX_ACTIVE", "").strip() else "CONTEST_MAX_CONCURRENCY"
    raw = os.environ.get(source, str(MAX_ACTIVE)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise DriverError(f"{source} is not an integer: {raw}") from exc
    if value > MAX_ACTIVE:
        log(f"{source}={value} capped at {MAX_ACTIVE} (platform max active)")
        value = MAX_ACTIVE
    return max(1, value)


def supervisor_enabled() -> bool:
    raw = os.environ.get("CONTEST_SUPERVISOR", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def solver_argv(prompt: Path, profile: str | None = None) -> list[str] | None:
    custom = os.environ.get("CONTEST_WORKER_CMD", "").strip()
    if custom:
        return shlex.split(custom)
    dsh = shutil.which(os.environ.get("CONTEST_DSH_BIN", "dsh"))
    if os.environ.get("CONTEST_DSH_LAUNCH") == "1" and dsh:
        chosen = profile if profile is not None else profile_for_now()
        return [dsh, "--profile", chosen, "--json", str(prompt)]
    return None


def run_root(workdir: Path) -> Path:
    raw = os.environ.get("RUN", "").strip()
    return Path(raw).expanduser().resolve() if raw else workdir


def load_challenge_snapshot(base: str, token: str, fixture_path: str):
    if fixture_path:
        challenges = load_fixture(Path(fixture_path))
        return None, challenges, f"fixture list: {len(challenges)} challenges from {fixture_path}"
    prefix, challenges = list_challenges_live(base, token)
    return prefix, challenges, f"list_challenges via {prefix}: {len(challenges)}"


def announce_schedule(challenges) -> tuple[list, int]:
    pending = [item for item in challenges if isinstance(item, dict) and not is_completed(item)]
    skipped = len(challenges) - len(pending)
    if skipped:
        log(f"skip completed: {skipped}")
    if not pending:
        log("no pending challenges")
        return [], 0
    workers = min(concurrency(), len(pending))
    log(f"schedule {len(pending)} visits, max concurrency {workers} (platform cap {MAX_ACTIVE})")
    return pending, workers


def run_once(workdir: Path, token: str, base: str, fixture_path: str) -> int:
    prefix, challenges, listed = load_challenge_snapshot(base, token, fixture_path)
    log(listed)
    pending, workers = announce_schedule(challenges)
    if not pending:
        return 0
    results = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            pool.submit(
                visit,
                item,
                base=base,
                prefix=prefix,
                token=token,
                workdir=workdir,
                fixture=bool(fixture_path),
            )
            for item in pending
        ]
        for future in as_completed(futures):
            results.append(future.result())
    failed = [item for item in results if not item.get("ok")]
    log(f"done ok={len(results) - len(failed)} failed={len(failed)}")
    return 1 if failed else 0


def slot_view(slot: dict) -> dict:
    directory = Path(slot["dir"]) if slot.get("dir") else None
    meta = read_project_meta(directory) if directory and directory.is_dir() else {"_present": False}
    proc = slot.get("proc")
    if proc is not None:
        alive = proc.poll() is None
        pid = proc.pid
    else:
        alive = False
        pid = slot.get("pid")
    return {
        "code": slot.get("code"),
        "pid": pid,
        "alive": alive,
        "dir": slot.get("dir"),
        "launched": bool(slot.get("launched")),
        "meta_state": meta.get("state") if meta.get("_present") else None,
        "meta_at": (meta.get("deferredAt") or meta.get("updatedAt") or "") if meta.get("_present") else "",
        "meta_present": bool(meta.get("_present")),
        "session_id": slot.get("session_id") or "",
    }


def remember_slot(result: dict) -> dict | None:
    if not result.get("ok") or not result.get("cwd"):
        return None
    return {
        "code": result.get("code") or result.get("problemId"),
        "pid": result.get("pid"),
        "proc": result.get("proc"),
        "dir": result.get("cwd"),
        "launched": bool(result.get("launched")),
        "session_id": "",
        "pass_kind": result.get("pass") or "first",
        "profile": result.get("profile") or "",
        "started_at": stamp_utc(),
        "budget_min": result.get("budget_min") or "",
    }


def close_slot(run: Path, code: str, already: set[str], fixture_path: str, base: str, token: str) -> str:
    """Try to close ``code`` once.

    Returns ``closed`` on success, ``retry`` when the platform never answered
    (timeout or a dropped connection), ``failed`` on an HTTP answer we will
    not pin the loop for, and ``skip`` when this code is already closed.
    A failure is not written to the closed set, so a later tick can try again.
    """
    if not code or code in already:
        return "skip"
    try:
        note = perform_close(
            run,
            code,
            base=base,
            token=token,
            fixture=fixture_path or None,
            already=already,
        )
    except PlatformTransportError as exc:
        log(f"close {code} failed: {exc}; pending retry")
        append_log(run, f"close {code} failed: {exc}; pending retry")
        return "retry"
    except SupervisorError as exc:
        log(f"close {code} failed: {exc}")
        append_log(run, f"close {code} failed: {exc}")
        return "failed"
    except OSError as exc:
        # request_json already wraps TimeoutError. This is the belt so a raw
        # timeout from urlopen still cannot kill the tick.
        log(f"close {code} failed: {type(exc).__name__}: {exc}; pending retry")
        append_log(run, f"close {code} failed: {type(exc).__name__}: {exc}; pending retry")
        return "retry"
    if note is None:
        return "skip"
    log(f"close {code}")
    return "closed"


def supervisor_interval() -> float:
    raw = os.environ.get("CONTEST_SUPERVISOR_INTERVAL", "20").strip() or "20"
    try:
        return max(0.0, float(raw))
    except ValueError as exc:
        raise DriverError(f"CONTEST_SUPERVISOR_INTERVAL is not a number: {raw}") from exc


def pending_queue(challenges, attempted: set[str], inflight: set[str]) -> list:
    queue = []
    for item in challenges:
        if not isinstance(item, dict) or is_completed(item):
            continue
        code = str(item.get("unique_code") or item.get("code") or "").strip()
        if not code or code in attempted or code in inflight:
            continue
        queue.append(item)
    return queue


def run_supervised(workdir: Path, token: str, base: str, fixture_path: str) -> int:
    """One scheduler: reap, retire, then fill free slots from this driver's queue."""
    run = run_root(workdir)
    (run / "monitor").mkdir(parents=True, exist_ok=True)
    (run / "attempted").mkdir(parents=True, exist_ok=True)
    try:
        acquire_lock(run)
    except SupervisorError as exc:
        raise DriverError(str(exc)) from exc
    log("supervisor on (this driver owns dispatch)")
    try:
        return supervisor_loop(run, workdir, token, base, fixture_path)
    finally:
        release_lock(run)


def _code_completed(challenges, code: str) -> bool:
    for item in challenges or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("unique_code") or item.get("code") or "").strip() != code:
            continue
        return is_completed(item)
    return False


def _enqueue_fail(run: Path, code: str, reason: str, directory: str | None) -> None:
    try:
        dest = run / "queue" / "artifacts" / safe_code(code)
        artifact = snapshot_artifacts(Path(directory) if directory else None, dest)
    except (SupervisorError, OSError) as exc:
        log(f"snapshot {code} failed: {exc}")
        artifact = ""
    try:
        register_fail(
            run,
            unique_code=code,
            reason=reason,
            artifact_dir=artifact,
            attempt=1,
            problem_id="",
        )
        mark_first_pass_done(run, code)
    except SupervisorError as exc:
        log(f"register_fail {code} failed: {exc}")
        return
    log(f"fail {code} reason={reason}")


def _mark_done(run: Path, code: str) -> None:
    try:
        mark_first_pass_done(run, code)
    except SupervisorError as exc:
        log(f"mark first pass {code} failed: {exc}")


def _settle_fgs_end(run: Path, code: str) -> None:
    _mark_done(run, code)
    try:
        if not fgs_done(run, code):
            bump_failed_at(run, code)
    except SupervisorError as exc:
        log(f"fgs settle {code} failed: {exc}")


def _classify_dead_slot(run: Path, slot: dict, challenges, *, transport_glitch: bool) -> None:
    """Record a finished worker. A list glitch parks it instead of enqueueing."""
    code = str(slot.get("code") or "").strip()
    if not code:
        return
    view = slot_view(slot)
    if view["alive"]:
        return
    pass_kind = slot.get("pass_kind") or "first"
    if pass_kind == "fgs":
        _settle_fgs_end(run, code)
        return
    if not view["launched"]:
        _mark_done(run, code)
        return
    if transport_glitch:
        try:
            park_unclassified(run, code, {
                "unique_code": code,
                "dir": slot.get("dir") or "",
                "pass_kind": pass_kind,
                "reason": "reap",
            })
        except SupervisorError as exc:
            log(f"park {code} failed: {exc}")
        return
    reason = failure_reason(
        completed=_code_completed(challenges, code),
        alive=False,
        launched=True,
        meta_state=view.get("meta_state"),
        deferred_past_grace=False,
        budget_past=False,
        fail_on_budget=False,
        transport_glitch=False,
    )
    if reason:
        _enqueue_fail(run, code, reason, slot.get("dir"))
    else:
        _mark_done(run, code)


def _drain_unclassified(run: Path, challenges) -> None:
    for info in list_unclassified(run):
        code = str(info.get("unique_code") or "").strip()
        if not code:
            continue
        matched = None
        for item in challenges or []:
            if isinstance(item, dict) and str(item.get("unique_code") or item.get("code") or "").strip() == code:
                matched = item
                break
        if matched is None:
            continue
        try:
            discard_unclassified(run, code)
        except SupervisorError as exc:
            log(f"discard parked {code} failed: {exc}")
            continue
        if is_completed(matched) or info.get("pass_kind") == "fgs":
            _mark_done(run, code)
            if info.get("pass_kind") == "fgs":
                _settle_fgs_end(run, code)
            continue
        _enqueue_fail(run, code, str(info.get("reason") or "reap"), info.get("dir") or "")


def _note_retire_fail(run: Path, action: dict, slot: dict | None, challenges, *, list_failed: bool) -> None:
    code = str(action.get("code") or "").strip()
    if not code:
        return
    state = str(action.get("state") or "")
    pass_kind = (slot or {}).get("pass_kind") or "first"
    directory = action.get("dir") or (slot or {}).get("dir") or ""
    if state == "solved" or _code_completed(challenges, code):
        _mark_done(run, code)
        return
    if pass_kind == "fgs":
        _settle_fgs_end(run, code)
        return
    if state not in ("deferred", "budget"):
        _mark_done(run, code)
        return
    if list_failed:
        try:
            park_unclassified(run, code, {
                "unique_code": code,
                "dir": directory,
                "pass_kind": pass_kind,
                "reason": state,
            })
        except SupervisorError as exc:
            log(f"park {code} failed: {exc}")
        return
    _enqueue_fail(run, code, state, directory)


def supervisor_loop(run: Path, workdir: Path, token: str, base: str, fixture_path: str) -> int:
    # A bad CONTEST_HTTP_TIMEOUT is configuration, not a platform blip.
    http_timeout(30)
    interval = supervisor_interval()
    grace, grace_solved = grace_settings()
    cap = concurrency()
    attempted: set[str] = set()
    blocked: set[str] = set()
    closed_this_tick: set[str] = set()
    slots: list[dict] = []
    visits: list[dict] = []
    closed = load_closed_set(run)
    pending_close: set[str] = set()
    prefix = None
    announced = False
    use_fail_queue = fgs_mode() == "on_fail"

    def attempt_close(code: str) -> bool:
        if not code or code in closed:
            pending_close.discard(code)
            return False
        outcome = close_slot(run, code, closed, fixture_path, base, token)
        if outcome == "retry":
            pending_close.add(code)
            return False
        pending_close.discard(code)
        if outcome == "closed":
            closed_this_tick.add(code)
            return True
        return False

    while True:
        closed_this_tick.clear()
        list_failed = False
        try:
            prefix, challenges, listed = load_challenge_snapshot(base, token, fixture_path)
        except (DriverError, SupervisorError, OSError) as exc:
            # List used to raise out of this loop (TimeoutError is an OSError
            # and was not a DriverError). An empty snapshot is not "no work":
            # the platform may still be holding slots.
            detail = exc if isinstance(exc, (DriverError, SupervisorError)) else f"{type(exc).__name__}: {exc}"
            log(f"list challenges failed: {detail}")
            append_log(run, f"list challenges failed: {detail}")
            list_failed = True
            challenges = []
            listed = ""
        if not announced and not list_failed:
            log(listed)
            pending, _workers = announce_schedule(challenges)
            announced = True
            if not pending and not pending_close:
                return 0

        views = [slot_view(slot) for slot in slots]
        touched: set[str] = set()
        for action in plan_reap(challenges, views, already_closed=closed, include_dead_launched=True):
            if action["op"] == "keep":
                append_log(run, f"keep {action['code']}")
                continue
            touched.add(action["code"])
            attempt_close(action["code"])
        for code in list(pending_close):
            if code in touched or code in closed:
                continue
            attempt_close(code)
        if use_fail_queue:
            if list_failed:
                for slot in slots:
                    if not slot_view(slot)["alive"]:
                        _classify_dead_slot(run, slot, challenges, transport_glitch=True)
            else:
                _drain_unclassified(run, challenges)
                for slot in slots:
                    if not slot_view(slot)["alive"]:
                        _classify_dead_slot(run, slot, challenges, transport_glitch=False)
        slots = [slot for slot in slots if slot_view(slot)["alive"]]

        views = [slot_view(slot) for slot in slots]
        retire_actions = plan_retire(views, challenges, now=utc_now(), grace=grace, grace_solved=grace_solved)
        if use_fail_queue:
            seen_codes = {action["code"] for action in retire_actions}
            budget_views = []
            for slot in slots:
                view = slot_view(slot)
                view["started_at"] = slot.get("started_at")
                view["budget_min"] = slot.get("budget_min")
                budget_views.append(view)
            for action in plan_budget_retire(
                budget_views,
                challenges,
                now=utc_now(),
                enabled=fail_on_budget(),
            ):
                if action["code"] not in seen_codes:
                    retire_actions.append(action)
        for action in retire_actions:
            if action["op"] == "hold":
                append_log(
                    run,
                    f"hold {action['code']} ({action['state']}, grace {action['remaining']}s)",
                    tag="retire",
                )
                log(f"hold {action['code']} ({action['state']})")
                continue
            terminate_pid(action.get("pid"))
            attempt_close(action["code"])
            if action.get("archive") and action.get("dir"):
                archive_worker(Path(action["dir"]))
            mark_retired(run, action["code"])
            slot = next((item for item in slots if item.get("code") == action["code"]), None)
            if use_fail_queue:
                _note_retire_fail(run, action, slot, challenges, list_failed=list_failed)
            else:
                attempted.add(action["code"])
            append_log(run, f"retire {action['code']} ({action['state']})", tag="retire")
            log(f"retire {action['code']}")
        slots = [slot for slot in slots if slot_view(slot)["alive"]]

        views = [slot_view(slot) for slot in slots]
        alive_ids = [view.get("session_id") or "" for view in views if view.get("alive")]
        for sampler in plan_gc_samplers(alive_ids, list_samplers()):
            terminate_pid(sampler.get("pid"), wait=0.2)
            append_log(run, f"gc sampler pid={sampler.get('pid')} (session={sampler.get('session_id')})")

        inflight = {slot.get("code") for slot in slots if slot.get("code")}
        alive = sum(1 for slot in slots if slot_view(slot)["alive"])
        # Unknown list fails closed: do not start another container on a guess.
        active = count_active(challenges, unknown=list_failed)
        plans: list[dict] = []
        if use_fail_queue:
            retries = fgs_max_retries()
            if list_failed:
                new_n = 0
                fgs_n = 0
            else:
                new_n = len(queue_new(challenges, run=run, inflight=inflight, blocked=blocked))
                fgs_n = len(queue_fgs(
                    challenges,
                    run=run,
                    inflight=inflight,
                    blocked=blocked,
                    max_retries=retries,
                ))
            fgs_live = sum(
                1 for slot in slots if slot.get("pass_kind") == "fgs" and slot_view(slot)["alive"]
            )
            plans = select_dispatch(
                challenges,
                run=run,
                inflight=inflight,
                blocked=blocked,
                fgs_inflight=fgs_live,
                alive=alive,
                active=active,
                cap=cap,
                retry_last=fgs_retry_last(),
                fgs_max_active=fgs_max_active(),
                max_retries=retries,
                list_failed=list_failed,
            )
            queue_len = new_n + fgs_n
            budget = len(plans)
            tick_extra = f" queue_new={new_n} queue_fgs={fgs_n}"
        else:
            queue = pending_queue(challenges, attempted, inflight)
            queue_len = len(queue)
            budget = dispatch_budget(alive, active, cap, queue_len)
            if budget > 0:
                for item in queue[:budget]:
                    code = str(item.get("unique_code") or item.get("code") or "").strip()
                    plans.append({
                        "challenge": item,
                        "pass_kind": "first",
                        "code": code,
                        "record": None,
                    })
            new_n = queue_len
            fgs_n = 0
            retries = 0
            tick_extra = ""
        append_log(run, f"alive_workers={alive} active_containers={active} queue_left={queue_len}")
        log(f"supervisor tick alive={alive} active={active} queue={queue_len} budget={budget}{tick_extra}")

        if plans:
            for plan in plans:
                code = plan.get("code") or ""
                if not code:
                    continue
                if use_fail_queue and plan["pass_kind"] == "fgs":
                    try:
                        note_fgs_dispatch(run, code, retries)
                    except SupervisorError as exc:
                        log(f"note fgs dispatch {code} failed: {exc}")
                elif use_fail_queue:
                    try:
                        mark_first_pass_started(run, code)
                    except SupervisorError as exc:
                        log(f"mark first pass started {code} failed: {exc}")
                else:
                    attempted.add(code)
            with ThreadPoolExecutor(max_workers=max(1, min(len(plans), cap))) as pool:
                futures = []
                for plan in plans:
                    record = plan.get("record") or {}
                    futures.append(pool.submit(
                        visit,
                        plan["challenge"],
                        base=base,
                        prefix=prefix,
                        token=token,
                        workdir=workdir,
                        fixture=bool(fixture_path),
                        background=True,
                        pass_kind=plan["pass_kind"],
                        enrich_dir=record.get("artifact_dir") or None,
                        fail_reason=str(record.get("reason") or ""),
                        reuse_ok=plan.get("code") not in closed_this_tick,
                    ))
                for future in as_completed(futures):
                    result = future.result()
                    visits.append(result)
                    if not result.get("ok"):
                        if result.get("code"):
                            blocked.add(result["code"])
                        if result.get("close") and result.get("code"):
                            attempt_close(result["code"])
                        continue
                    remembered = remember_slot(result)
                    if remembered is not None:
                        slots.append(remembered)
            # Let a just-started worker write meta.json before the next retire read.
            if any(slot.get("proc") is not None for slot in slots):
                time.sleep(0.2)
            continue

        # A failed list is not an empty queue. A close that never got an answer
        # still occupies a platform slot, so keep ticking until it succeeds.
        if (
            not list_failed
            and queue_len == 0
            and not pending_close
            and not any(slot_view(slot)["alive"] for slot in slots)
        ):
            break
        time.sleep(interval)

    failed = [item for item in visits if not item.get("ok")]
    log(f"done ok={len(visits) - len(failed)} failed={len(failed)}")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    del argv  # reserved; the visit order is driven by env + the platform, not flags
    mark_driver_started()
    try:
        require_platform_env()
        # Capture the injected Challenges endpoint before any gateway rewrite.
        # apply_gateway_rewrites must not touch these; the snapshot is what list,
        # start, and close actually call.
        token = os.environ["BENCHMARK_TOKEN"].strip()
        base = os.environ["BENCHMARK_BASE_URL"].strip()
        apply_gateway_rewrites()
        os.environ["BENCHMARK_TOKEN"] = token
        os.environ["BENCHMARK_BASE_URL"] = base
        vpn_preflight()
        workdir = Path(os.environ.get("CONTEST_WORKDIR", str(ROOT / "contest-work"))).resolve()
        workdir.mkdir(parents=True, exist_ok=True)
        fixture_path = os.environ.get("CONTEST_FIXTURE", "").strip()
        http_timeout(30)
        if not supervisor_enabled():
            log("supervisor off")
            return run_once(workdir, token, base, fixture_path)
        return run_supervised(workdir, token, base, fixture_path)
    except (DriverError, SupervisorError) as exc:
        log(str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
