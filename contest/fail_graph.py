"""Build an FGS enrich payload from one challenge's baseline artifacts.

The payload is applied with the existing Controller ops (seed, open_step,
submit_fact). It does not invent a second graph format. Facts cite a file
path. Flag-shaped strings are redacted before they reach the graph.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

_FLAG = re.compile(r"(?i)(flag|ctf|key)\{[^{}\n]{0,200}\}")
_EXCLUDE = (
    "排除",
    "失败",
    "不可达",
    "not found",
    "denied",
    "404",
    "refused",
    "无效",
    "无此",
    "超时",
    "timeout",
)
_NOTE_NAMES = ("note.txt", "notes.txt", "probe.py", "notes.md")
_SKIP_FILES = frozenset({
    "prompt.txt",
    "dsh-launch.json",
    "enrich-input.json",
    "enrich-applied.json",
    "graph.yaml",
    "graph.json",
    "competition.json",
})
_MAX_FACTS = 6
_TITLE_LIMIT = 120


def redact(text: str) -> str:
    return _FLAG.sub("[redacted]", str(text or ""))


def _clip_chars(text: str, limit: int) -> str:
    body = redact(text).strip()
    if len(body) <= limit:
        return body
    if limit <= 1:
        return body[:limit]
    return body[: limit - 1].rstrip() + "…"


def _clip_bytes(text: str, limit: int = 3500) -> str:
    body = redact(text).strip()
    raw = body.encode("utf-8")
    if len(raw) <= limit:
        return body
    clipped = raw[:limit]
    while clipped:
        try:
            text_out = clipped.decode("utf-8")
            break
        except UnicodeDecodeError:
            clipped = clipped[:-1]
    else:
        text_out = ""
    return text_out.rstrip() + "…"


def _title(prefix: str, body: str) -> str:
    room = _TITLE_LIMIT - len(prefix)
    snippet = _clip_chars(body.replace("\n", " "), max(1, room))
    title = prefix + snippet
    return title[:_TITLE_LIMIT]


def _kind(note: str) -> str:
    lowered = note.lower()
    for hint in _EXCLUDE:
        if hint in note or hint in lowered:
            return "excluded"
    return "verified"


def _read_text(path: Path, limit: int = 4000) -> str:
    try:
        data = path.read_bytes()[:limit]
    except OSError:
        return ""
    return data.decode("utf-8", errors="replace")


def _observations(artifact_dir: Path) -> list[dict]:
    path = artifact_dir / ".fgs" / "observations.jsonl"
    if not path.is_file():
        return []
    rows = []
    for line in _read_text(path, 64_000).splitlines():
        text = line.strip()
        if not text:
            continue
        note = text
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            note = str(parsed.get("note") or parsed.get("text") or "").strip()
        elif isinstance(parsed, str):
            note = parsed.strip()
        if note:
            rows.append({"note": redact(note), "path": ".fgs/observations.jsonl"})
    return rows


def _interesting_files(artifact_dir: Path) -> list[Path]:
    found: list[Path] = []
    seen: set[Path] = set()

    def add(path: Path) -> None:
        if path.name in _SKIP_FILES or path in seen or not path.is_file():
            return
        seen.add(path)
        found.append(path)

    for name in _NOTE_NAMES:
        add(artifact_dir / name)
    try:
        entries = sorted(artifact_dir.iterdir(), key=lambda item: item.name)
    except OSError:
        entries = []
    for entry in entries:
        if not entry.is_file():
            continue
        if entry.suffix.lower() in (".py", ".txt", ".md") and entry.name not in _SKIP_FILES:
            add(entry)
    return found[:12]


def _file_summary(path: Path, root: Path) -> str:
    rel = path.relative_to(root).as_posix()
    first = ""
    for line in _read_text(path, 2000).splitlines():
        stripped = line.strip()
        if stripped:
            first = _clip_chars(stripped, 180)
            break
    if first:
        return f"{rel}: {first}"
    return rel


def _log_tail(artifact_dir: Path) -> str:
    tails = []
    try:
        logs = sorted(artifact_dir.glob("*.log"))
    except OSError:
        logs = []
    for path in logs[:3]:
        lines = [line.strip() for line in _read_text(path, 8000).splitlines() if line.strip()]
        if not lines:
            continue
        snippet = " | ".join(redact(line) for line in lines[-8:])
        tails.append(f"{path.name}: {_clip_chars(snippet, 400)}")
    return "\n".join(tails)


def collect_enrich(artifact_dir: str | Path | None, *, reason: str = "") -> dict:
    """Return a seed payload. ``empty`` is true when nothing usable was found."""
    root = Path(artifact_dir) if artifact_dir else None
    if root is None or not root.is_dir():
        return {"empty": True, "note": "", "facts": [], "intent": None, "sources": []}

    sources: list[str] = []
    observations = _observations(root)
    if observations:
        sources.append(".fgs/observations.jsonl")
    files = _interesting_files(root)
    summaries = []
    for path in files:
        summaries.append(_file_summary(path, root))
        sources.append(path.relative_to(root).as_posix())
    logs = _log_tail(root)
    if logs:
        sources.append("*.log")

    if not observations and not summaries and not logs:
        return {"empty": True, "note": "", "facts": [], "intent": None, "sources": []}

    narrative = [f"baseline 结束原因：{redact(reason) or 'unknown'}。"]
    narrative.append("下面是 baseline 这遍实际留下的东西（只列文件名和短摘要，不是整文件）。")
    if summaries:
        narrative.append("文件：")
        narrative.extend(f"- {line}" for line in summaries)
    if observations:
        narrative.append(f"观察：{len(observations)} 条，见 .fgs/observations.jsonl。")
    if logs:
        narrative.append("日志尾部：")
        narrative.append(logs)
    narrative.append("下一步应沿已验证事实继续利用并交分，已排除路径不要再走。")

    facts = [{
        "title": "baseline 做过什么",
        "content": _clip_bytes("\n".join(narrative)),
        "kind": "note",
        "evidence": summaries[0].split(":", 1)[0] if summaries else (
            ".fgs/observations.jsonl" if observations else ""
        ),
    }]
    for row in observations:
        kind = _kind(row["note"])
        prefix = "已排除: " if kind == "excluded" else "已验证: "
        facts.append({
            "title": _title(prefix, row["note"]),
            "content": _clip_bytes(
                f"{row['note']}\nevidence: {row['path']}"
            ),
            "kind": kind,
            "evidence": row["path"],
        })
        if len(facts) >= _MAX_FACTS:
            break
    if len(facts) < _MAX_FACTS and summaries:
        facts.append({
            "title": "baseline 产物清单",
            "content": _clip_bytes(
                "evidence 指向 baseline 工作目录里的文件，正文只保留短摘要。\n"
                + "\n".join(summaries)
            ),
            "kind": "note",
            "evidence": summaries[0].split(":", 1)[0],
        })

    verified_titles = [
        _title("已验证: ", row["note"])
        for row in observations
        if _kind(row["note"]) == "verified"
    ]
    action = "基于已有原语继续利用并提交 flag。先读已验证事实，不要重走已排除路径。"
    if verified_titles:
        action = f"{action} 引用最新已验证：{verified_titles[-1]}"

    return {
        "empty": False,
        "note": facts[0]["content"],
        "facts": facts[:_MAX_FACTS],
        "intent": {
            "action": action,
            "priority": "high",
        },
        "sources": sources,
    }
