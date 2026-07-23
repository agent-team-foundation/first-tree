#!/usr/bin/env python3
"""Build a read-only Context Tree value audit from First Tree Chats and Codex traces."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

SCHEMA_VERSION = 1
AUTHORIZATION_VALUES = {"owned", "explicit"}
RESULT_VALUES = {"verified", "probable", "unproven"}
EFFECT_VALUES = {"confirmed", "constrained", "redirected", "conflicted"}
RUBRIC_KEYS = (
    "real_read",
    "decision_bearing_normal_passage",
    "task_relevant",
    "read_before_choice",
    "influence_visible",
)
UUID_PATTERN = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
CHAT_CONTEXT_PATTERN = re.compile(
    r"<first-tree-current-chat-context[\s\S]*?</first-tree-current-chat-context>",
    re.UNICODE,
)
CHAT_ID_PATTERN = re.compile(rf'"chatId"\s*:\s*"({UUID_PATTERN})"', re.UNICODE)
READ_COMMAND_PATTERN = re.compile(
    r"""(?:^|[\s/"'`])(?:cat|nl|sed|head|tail|less|read|rg|grep|awk|perl|bat|view|read_file)(?:[\s"'`/]|$)""",
    re.IGNORECASE | re.UNICODE,
)
TREE_MENTION_PATTERN = re.compile(
    r"context[\s-]+tree|tree\s+(?:node|节点|decision|决策|constraint|约束|rationale|现行|current)|"
    r"(?:^|[\s\"'`(])(?:[^\s/\"'`()]+/)+[^\s\"'`()]+\.md(?=$|[\s\"'`,;:)])",
    re.IGNORECASE | re.UNICODE,
)
SHELL_SESSION_PATTERN = re.compile(r"(?:session ID|session_id[\"']?\s*[:=])\s*([0-9]+)", re.IGNORECASE)
CELL_SESSION_PATTERN = re.compile(r"(?:cell ID|cell_id[\"']?\s*[:=])\s*([A-Za-z0-9_.:-]+)", re.IGNORECASE)


class AuditError(RuntimeError):
    """Raised for invalid input or an incomplete deterministic audit step."""


@dataclass(frozen=True)
class Window:
    start: datetime
    end: datetime


@dataclass(frozen=True)
class ScopedChat:
    chat_id: str
    agent: str
    agent_id: str
    authorization: str


@dataclass(frozen=True)
class ScopedAgent:
    name: str
    agent_id: str
    authorization: str


@dataclass(frozen=True)
class Scope:
    agents: tuple[ScopedAgent, ...]
    chats: tuple[ScopedChat, ...]


def parse_datetime(value: str, *, field: str = "timestamp") -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise AuditError(f"Invalid {field}: {value}") from error
    if parsed.tzinfo is None:
        raise AuditError(f"{field} must include a timezone: {value}")
    return parsed.astimezone(timezone.utc)


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def resolve_window(days: int, now_text: str | None) -> Window:
    if days <= 0:
        raise AuditError("--days must be greater than zero.")
    end = parse_datetime(now_text, field="--now") if now_text else datetime.now(timezone.utc)
    return Window(start=end - timedelta(days=days), end=end)


def in_window(value: str | None, window: Window) -> bool:
    if not value:
        return False
    try:
        timestamp = parse_datetime(value)
    except AuditError:
        return False
    return window.start <= timestamp <= window.end


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AuditError(f"Could not read JSON from {path}: {error}") from error


def iter_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise AuditError(f"Invalid JSONL at {path}:{line_number}: {error}") from error
                if not isinstance(value, dict):
                    raise AuditError(f"Expected a JSON object at {path}:{line_number}.")
                yield value
    except OSError as error:
        raise AuditError(f"Could not read {path}: {error}") from error


def resolve_artifact_root(value: str) -> Path:
    raw = Path(value).expanduser()
    if raw.is_symlink():
        raise AuditError("--artifact-root must not be a symbolic link.")
    try:
        raw.mkdir(parents=True, exist_ok=True)
        root = raw.resolve(strict=True)
    except OSError as error:
        raise AuditError(f"Could not prepare --artifact-root {raw}: {error}") from error
    if not root.is_dir():
        raise AuditError(f"--artifact-root must be a directory: {root}")
    return root


def artifact_path(root: Path, value: str, *, field: str, must_exist: bool) -> Path:
    raw = Path(value).expanduser()
    candidate = raw if raw.is_absolute() else root / raw
    lexical = Path(os.path.abspath(candidate))
    if lexical.is_symlink():
        raise AuditError(f"{field} must not be a symbolic link: {lexical}")
    try:
        resolved = lexical.resolve(strict=must_exist)
        resolved.relative_to(root)
    except (OSError, ValueError) as error:
        raise AuditError(f"{field} must resolve inside --artifact-root {root}: {candidate}") from error
    if must_exist:
        if not resolved.is_file() or resolved.is_symlink():
            raise AuditError(f"{field} must be a regular file inside --artifact-root: {resolved}")
    else:
        try:
            resolved.parent.mkdir(parents=True, exist_ok=True)
            parent = resolved.parent.resolve(strict=True)
            parent.relative_to(root)
        except (OSError, ValueError) as error:
            raise AuditError(f"Could not prepare {field} inside --artifact-root: {resolved}") from error
        if resolved.exists() and (not resolved.is_file() or resolved.is_symlink()):
            raise AuditError(f"{field} must be a regular file path: {resolved}")
    return resolved


def require_distinct_paths(paths: Mapping[str, Path]) -> None:
    reverse: dict[Path, list[str]] = {}
    for field, path in paths.items():
        reverse.setdefault(path, []).append(field)
    duplicates = {path: fields for path, fields in reverse.items() if len(fields) > 1}
    if duplicates:
        detail = "; ".join(f"{path}: {', '.join(fields)}" for path, fields in duplicates.items())
        raise AuditError(f"Artifact inputs and outputs must be distinct ({detail}).")


def atomic_write(path: Path, text: str) -> None:
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
            temporary = handle.name
        os.replace(temporary, path)
        temporary = None
    except OSError as error:
        raise AuditError(f"Could not write {path}: {error}") from error
    finally:
        if temporary is not None:
            try:
                Path(temporary).unlink()
            except OSError:
                pass


def write_jsonl(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    text = "".join(f"{json.dumps(row, ensure_ascii=False, sort_keys=True)}\n" for row in rows)
    atomic_write(path, text)


def write_text(path: Path, text: str) -> None:
    atomic_write(path, text)


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AuditError(f"{field} must be a non-empty string.")
    return value.strip()


def validate_authorization(value: Any, field: str) -> str:
    authorization = require_string(value, field)
    if authorization not in AUTHORIZATION_VALUES:
        raise AuditError(f"{field} must be one of: {', '.join(sorted(AUTHORIZATION_VALUES))}.")
    return authorization


def require_uuid(value: Any, field: str) -> str:
    result = require_string(value, field)
    if re.fullmatch(UUID_PATTERN, result) is None:
        raise AuditError(f"{field} must be a UUID.")
    return result


def audit_id(chat_id: str, agent_id: str) -> str:
    return f"{chat_id}@{agent_id}"


def load_scope(path: Path) -> Scope:
    raw = read_json(path)
    if not isinstance(raw, dict) or raw.get("schema_version") != SCHEMA_VERSION:
        raise AuditError(f"{path} must be a schema_version {SCHEMA_VERSION} scope object.")

    agents: list[ScopedAgent] = []
    for index, value in enumerate(raw.get("agents", [])):
        if not isinstance(value, dict):
            raise AuditError(f"agents[{index}] must be an object.")
        authorization = validate_authorization(value.get("authorization"), f"agents[{index}].authorization")
        if authorization != "owned":
            raise AuditError(
                f"agents[{index}].authorization must be owned; explicit authorization applies to one Chat ID."
            )
        agents.append(
            ScopedAgent(
                name=require_string(value.get("name"), f"agents[{index}].name"),
                agent_id=require_uuid(value.get("agent_id"), f"agents[{index}].agent_id"),
                authorization=authorization,
            )
        )

    chats: list[ScopedChat] = []
    for index, value in enumerate(raw.get("chats", [])):
        if not isinstance(value, dict):
            raise AuditError(f"chats[{index}] must be an object.")
        chat_id = require_uuid(value.get("chat_id"), f"chats[{index}].chat_id")
        agent = require_string(value.get("agent"), f"chats[{index}].agent")
        authorization = validate_authorization(value.get("authorization"), f"chats[{index}].authorization")
        if authorization != "explicit":
            raise AuditError(
                f"chats[{index}].authorization must be explicit; owned scope is represented by an agent entry."
            )
        chats.append(
            ScopedChat(
                chat_id=chat_id,
                agent=agent,
                agent_id=require_uuid(value.get("agent_id"), f"chats[{index}].agent_id"),
                authorization=authorization,
            )
        )

    if not agents and not chats:
        raise AuditError("The scope must contain at least one owned agent or explicitly authorized Chat.")
    if len({agent.name for agent in agents}) != len(agents):
        raise AuditError("The scope contains duplicate agent names.")
    if len({agent.agent_id for agent in agents}) != len(agents):
        raise AuditError("The scope contains duplicate owned agent IDs.")
    if len({(chat.chat_id, chat.agent_id) for chat in chats}) != len(chats):
        raise AuditError("The scope contains duplicate Chat and audited-Agent pairs.")
    return Scope(agents=tuple(agents), chats=tuple(chats))


def run_first_tree_data(binary: str, arguments: Sequence[str]) -> Any:
    command = [binary, "--json", *arguments]
    completed = subprocess.run(command, capture_output=True, check=False, text=True)
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or f"exit {completed.returncode}"
        raise AuditError(f"Read-only First Tree command failed: {' '.join(command)}: {detail}")
    output = completed.stdout.strip()
    if not output:
        raise AuditError(f"Read-only First Tree command produced no JSON: {' '.join(command)}")
    try:
        payload = json.loads(output)
    except json.JSONDecodeError as error:
        raise AuditError(f"Invalid JSON from {' '.join(command)}: {error}") from error
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise AuditError(f"First Tree command did not succeed: {' '.join(command)}")
    return payload.get("data")


def run_first_tree_json(binary: str, arguments: Sequence[str]) -> dict[str, Any]:
    data = run_first_tree_data(binary, arguments)
    if not isinstance(data, dict):
        raise AuditError(f"First Tree command returned no data object: {' '.join(arguments)}")
    return data


def verify_local_agent(binary: str, name: str, agent_id: str) -> None:
    local_agents = run_first_tree_data(binary, ["agent", "list"])
    if not isinstance(local_agents, list) or not any(
        isinstance(agent, dict)
        and agent.get("name") == name
        and agent.get("uuid") == agent_id
        and agent.get("runtime") == "codex"
        for agent in local_agents
    ):
        raise AuditError(
            f"Agent {name} ({agent_id}) is not an exact local Codex configuration."
        )


def verify_owned_agent(binary: str, scoped_agent: ScopedAgent) -> None:
    verify_local_agent(binary, scoped_agent.name, scoped_agent.agent_id)
    remote_agents = run_first_tree_data(binary, ["agent", "list", "--remote"])
    if not isinstance(remote_agents, list) or not any(
        isinstance(agent, dict)
        and agent.get("name") == scoped_agent.name
        and agent.get("uuid") == scoped_agent.agent_id
        and agent.get("runtimeProvider") == "codex"
        for agent in remote_agents
    ):
        raise AuditError(
            f"Owned agent {scoped_agent.name} ({scoped_agent.agent_id}) was not returned by the current user's managed-agent list."
        )


def paginated_items(binary: str, arguments: Sequence[str], *, agent: str | None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    cursor: str | None = None
    seen_cursors: set[str] = set()
    while True:
        page_args = [*arguments, "-l", "100"]
        if cursor is not None:
            page_args.extend(["--cursor", cursor])
        if agent is not None:
            page_args.extend(["--agent", agent])
        data = run_first_tree_json(binary, page_args)
        page_items = data.get("items")
        if not isinstance(page_items, list):
            raise AuditError(f"Expected data.items from {' '.join(page_args)}.")
        for item in page_items:
            if isinstance(item, dict):
                items.append(item)
        next_cursor = data.get("nextCursor")
        if not isinstance(next_cursor, str) or not next_cursor:
            break
        if next_cursor in seen_cursors:
            raise AuditError(f"Pagination cursor repeated for {' '.join(page_args)}.")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return items


def message_record(value: Mapping[str, Any]) -> dict[str, Any]:
    created_at = value.get("createdAt") or value.get("created_at")
    content = value.get("content")
    return {
        "message_id": value.get("id") or value.get("message_id"),
        "created_at": created_at if isinstance(created_at, str) else None,
        "sender_id": value.get("senderId") or value.get("sender_id"),
        "sender_kind": value.get("sender_kind"),
        "content": content if isinstance(content, str) else payload_text(content),
    }


def export_chats(args: argparse.Namespace) -> None:
    artifact_root = resolve_artifact_root(args.artifact_root)
    scope_path = artifact_path(artifact_root, args.scope, field="--scope", must_exist=True)
    output_path = artifact_path(artifact_root, args.output, field="--output", must_exist=False)
    require_distinct_paths({"--scope": scope_path, "--output": output_path})
    scope = load_scope(scope_path)
    window = resolve_window(args.days, args.now)
    chat_sources: dict[tuple[str, str], dict[str, Any]] = {}
    verified_local_agents: set[tuple[str, str]] = set()

    for scoped_agent in scope.agents:
        verify_owned_agent(args.first_tree_bin, scoped_agent)
        verified_local_agents.add((scoped_agent.name, scoped_agent.agent_id))
        for chat in paginated_items(args.first_tree_bin, ["chat", "list"], agent=scoped_agent.name):
            chat_id = chat.get("id")
            if not isinstance(chat_id, str) or re.fullmatch(UUID_PATTERN, chat_id) is None:
                continue
            last_message_at = chat.get("lastMessageAt")
            if isinstance(last_message_at, str) and not in_window(last_message_at, window):
                continue
            key = (chat_id, scoped_agent.agent_id)
            chat_sources.setdefault(
                key,
                {
                    "agent": scoped_agent.name,
                    "agent_id": scoped_agent.agent_id,
                    "authorization": scoped_agent.authorization,
                    "chat": chat,
                    "explicit": False,
                },
            )

    for scoped_chat in scope.chats:
        local_identity = (scoped_chat.agent, scoped_chat.agent_id)
        if local_identity not in verified_local_agents:
            verify_local_agent(args.first_tree_bin, *local_identity)
            verified_local_agents.add(local_identity)
        key = (scoped_chat.chat_id, scoped_chat.agent_id)
        existing = chat_sources.get(key, {})
        chat_sources[key] = {
            "agent": scoped_chat.agent,
            "agent_id": scoped_chat.agent_id,
            "authorization": scoped_chat.authorization,
            "chat": existing.get("chat", {}),
            "explicit": True,
        }

    exported: list[dict[str, Any]] = []
    for (chat_id, source_agent_id), source in sorted(chat_sources.items()):
        history = paginated_items(
            args.first_tree_bin,
            ["chat", "history", chat_id],
            agent=source["agent"],
        )
        messages = [message_record(message) for message in history]
        messages = [
            message
            for message in messages
            if isinstance(message.get("created_at"), str) and in_window(message["created_at"], window)
        ]
        messages.sort(key=lambda message: (message["created_at"], str(message.get("message_id") or "")))
        if not messages and not source["explicit"]:
            continue
        chat_metadata = source["chat"]
        title = chat_metadata.get("topic") or chat_metadata.get("title") or chat_id
        exported.append(
            {
                "schema_version": SCHEMA_VERSION,
                "audit_id": audit_id(chat_id, source_agent_id),
                "chat_id": chat_id,
                "title": title,
                "authorization": source["authorization"],
                "source_agent": source["agent"],
                "source_agent_id": source["agent_id"],
                "window": {"start": isoformat(window.start), "end": isoformat(window.end)},
                "messages": messages,
                "coverage_gaps": [] if messages else ["no_visible_messages_in_window"],
            }
        )

    write_jsonl(output_path, exported)


def payload_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(filter(None, (payload_text(item) for item in value)))
    if not isinstance(value, dict):
        return ""
    values = []
    for key in ("text", "content", "output", "message"):
        if key in value:
            text = payload_text(value[key])
            if text:
                values.append(text)
    return "\n".join(values)


def chat_ids_from_text(text: str) -> list[str]:
    chat_ids: list[str] = []
    for block in CHAT_CONTEXT_PATTERN.findall(text):
        chat_ids.extend(match.group(1) for match in CHAT_ID_PATTERN.finditer(block))
    return chat_ids


def parse_tool_arguments(payload: Mapping[str, Any]) -> dict[str, Any]:
    raw = payload.get("arguments")
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}
        return parsed if isinstance(parsed, dict) else {"raw": raw}
    raw_input = payload.get("input")
    if isinstance(raw_input, dict):
        return dict(raw_input)
    if isinstance(raw_input, str):
        try:
            parsed = json.loads(raw_input)
        except json.JSONDecodeError:
            return {"raw": raw_input}
        return parsed if isinstance(parsed, dict) else {"raw": raw_input}
    return {}


def tool_raw(payload: Mapping[str, Any]) -> str:
    arguments = parse_tool_arguments(payload)
    return "\n".join(
        filter(
            None,
            (
                str(payload.get("name") or ""),
                payload_text(payload.get("input")),
                payload_text(payload.get("arguments")),
                payload_text(arguments),
            ),
        )
    )


def relative_tree_path(candidate: Path, tree_roots: Sequence[Path]) -> str | None:
    try:
        resolved = candidate.expanduser().resolve(strict=False)
    except OSError:
        return None
    for tree_root in tree_roots:
        try:
            relative = resolved.relative_to(tree_root)
        except ValueError:
            continue
        if relative.suffix.lower() == ".md" and ".." not in relative.parts and relative.parts:
            return relative.as_posix()
    return None


def extract_node_paths(
    payload: Mapping[str, Any],
    tree_roots: Sequence[Path],
    default_workdir: Path,
) -> list[str]:
    raw = tool_raw(payload).replace("\\/", "/")
    paths: set[str] = set()

    for tree_root in tree_roots:
        root_text = tree_root.as_posix().rstrip("/")
        absolute_pattern = re.compile(
            rf"{re.escape(root_text)}/(?P<relative>[^\"'`\r\n;|&<>]+?\.md)(?=$|[\s\"'`,;:)|&<>])",
            re.UNICODE,
        )
        for match in absolute_pattern.finditer(raw):
            relative = match.group("relative").strip()
            candidate = relative_tree_path(tree_root / relative, tree_roots)
            if candidate is not None:
                paths.add(candidate)

    arguments = parse_tool_arguments(payload)
    workdir_value = arguments.get("workdir")
    workdirs = {default_workdir}
    if isinstance(workdir_value, str) and workdir_value.strip():
        workdirs.add(Path(workdir_value).expanduser())
    for match in re.finditer(r"""workdir\s*:\s*["'`]([^"'`]+)["'`]""", raw, re.UNICODE):
        workdirs.add(Path(match.group(1)).expanduser())

    for value in arguments.values():
        if not isinstance(value, str):
            continue
        try:
            tokens = shlex.split(value)
        except ValueError:
            tokens = value.split()
        for token in tokens:
            cleaned = token.strip(" \t\r\n\"'`,;:()[]{}")
            if not cleaned.lower().endswith(".md") or any(character.isspace() for character in cleaned):
                continue
            token_path = Path(cleaned).expanduser()
            candidates = [token_path] if token_path.is_absolute() else [workdir / token_path for workdir in workdirs]
            for candidate in candidates:
                relative = relative_tree_path(candidate, tree_roots)
                if relative is not None:
                    paths.add(relative)

    relative_pattern = re.compile(
        r"""(?<![A-Za-z0-9_.@/-])((?:[^\s/"'`(){}[\],;:|&<>]+/)+[^\s/"'`(){}[\],;:|&<>]+\.md)""",
        re.UNICODE,
    )
    for match in relative_pattern.finditer(raw):
        token_path = Path(match.group(1))
        for workdir in workdirs:
            relative = relative_tree_path(workdir / token_path, tree_roots)
            if relative is not None:
                paths.add(relative)
    return sorted(paths)


def is_markdown_read(tool_name: str, raw: str, node_paths: Sequence[str]) -> bool:
    if not node_paths:
        return False
    lowered = raw.lower()
    if "apply_patch" in lowered or tool_name.endswith("apply_patch"):
        return False
    if tool_name in {"read_file", "view_file"}:
        return True
    return READ_COMMAND_PATTERN.search(raw) is not None


def content_class_hint(paths: Sequence[str]) -> str:
    classes = {
        "non-normal" if path == "AGENTS.md" or path.startswith(("members/", "raw-context/")) else "normal"
        for path in paths
    }
    if len(classes) == 1:
        return next(iter(classes))
    return "mixed"


def output_success(output: str) -> bool | None:
    lowered = output.lower()
    if re.search(r"(?:process exited with code|exit[_ ]code[\"']?\s*[:=])\s*[1-9][0-9]*", lowered):
        return False
    if re.search(r"(?:process exited with code|exit[_ ]code[\"']?\s*[:=])\s*0", lowered):
        return True
    return None


def is_root_managed_session(meta: Mapping[str, Any], workspace_roots: set[str]) -> bool:
    cwd = meta.get("cwd")
    if not isinstance(cwd, str) or str(Path(cwd).resolve()) not in workspace_roots:
        return False
    if meta.get("originator") != "first-tree" or meta.get("model_provider") != "openai":
        return False
    if meta.get("agent_path") or meta.get("parent_thread_id") or meta.get("forked_from_id"):
        return False
    if meta.get("thread_source") == "subagent" or isinstance(meta.get("source"), dict):
        return False
    return True


def trace_root_default() -> Path:
    codex_root = os.environ.get("CODEX_HOME")
    return Path(codex_root).expanduser() / "sessions" if codex_root else Path.home() / ".codex" / "sessions"


def parse_agent_workspaces(values: Sequence[str]) -> dict[str, str]:
    by_workspace: dict[str, str] = {}
    seen_agents: set[str] = set()
    for index, value in enumerate(values):
        agent_id_text, separator, workspace_text = value.partition("=")
        agent_id_value = require_uuid(agent_id_text, f"--agent-workspace[{index}] Agent UUID")
        if not separator or not workspace_text.strip():
            raise AuditError("--agent-workspace must use AGENT_UUID=/absolute/workspace syntax.")
        raw_workspace = Path(workspace_text).expanduser()
        if raw_workspace.is_symlink():
            raise AuditError(f"Authorized Agent workspace must not be a symbolic link: {raw_workspace}")
        try:
            workspace_path = raw_workspace.resolve(strict=True)
        except OSError as error:
            raise AuditError(
                f"Could not resolve authorized Agent workspace {raw_workspace}: {error}"
            ) from error
        if not workspace_path.is_dir():
            raise AuditError(f"Authorized Agent workspace is not a directory: {workspace_path}")
        runtime_dir = workspace_path / ".first-tree-workspace"
        identity_path = runtime_dir / "identity.json"
        if runtime_dir.is_symlink() or identity_path.is_symlink():
            raise AuditError(
                f"Managed workspace identity must not traverse a symbolic link: {identity_path}"
            )
        try:
            resolved_identity = identity_path.resolve(strict=True)
            resolved_identity.relative_to(workspace_path)
        except (OSError, ValueError) as error:
            raise AuditError(
                f"Managed workspace identity is missing or outside the workspace: {identity_path}"
            ) from error
        if not resolved_identity.is_file():
            raise AuditError(f"Managed workspace identity is not a regular file: {resolved_identity}")
        identity = read_json(resolved_identity)
        if (
            not isinstance(identity, dict)
            or identity.get("agentId") != agent_id_value
            or identity.get("type") != "agent"
        ):
            raise AuditError(
                f"Managed workspace identity does not match Agent {agent_id_value}: {resolved_identity}"
            )
        workspace = str(workspace_path)
        if agent_id_value in seen_agents:
            raise AuditError(f"Duplicate --agent-workspace Agent UUID: {agent_id_value}")
        if workspace in by_workspace:
            raise AuditError(f"One workspace cannot be attributed to multiple Agents: {workspace}")
        seen_agents.add(agent_id_value)
        by_workspace[workspace] = agent_id_value
    if not by_workspace:
        raise AuditError("At least one --agent-workspace is required.")
    return by_workspace


def normalize_chat(value: Mapping[str, Any], window: Window) -> dict[str, Any]:
    chat_id = value.get("chat_id") or value.get("source_id")
    if not isinstance(chat_id, str) or re.fullmatch(UUID_PATTERN, chat_id) is None:
        raise AuditError("Every Chat record must contain chat_id/source_id as a UUID.")
    raw_messages = value.get("messages") or value.get("visible_messages") or []
    if not isinstance(raw_messages, list):
        raise AuditError(f"Chat {chat_id} messages must be an array.")
    messages = [message_record(message) for message in raw_messages if isinstance(message, dict)]
    messages = [
        message
        for message in messages
        if isinstance(message.get("created_at"), str) and in_window(message["created_at"], window)
    ]
    messages.sort(key=lambda message: (message["created_at"], str(message.get("message_id") or "")))
    gaps = value.get("coverage_gaps")
    coverage_gaps = [str(gap) for gap in gaps] if isinstance(gaps, list) else []
    source_agent_id = require_uuid(value.get("source_agent_id"), f"Chat {chat_id} source_agent_id")
    expected_audit_id = audit_id(chat_id, source_agent_id)
    supplied_audit_id = value.get("audit_id")
    if supplied_audit_id is not None and supplied_audit_id != expected_audit_id:
        raise AuditError(f"Chat {chat_id} audit_id does not match its Chat and audited-Agent UUIDs.")
    return {
        "audit_id": expected_audit_id,
        "chat_id": chat_id,
        "title": str(value.get("title") or value.get("topic") or chat_id),
        "authorization": validate_authorization(
            value.get("authorization"),
            f"Chat {chat_id} authorization",
        ),
        "source_agent": value.get("source_agent"),
        "source_agent_id": source_agent_id,
        "messages": messages,
        "coverage_gaps": coverage_gaps,
    }


def read_trace_meta(path: Path) -> Mapping[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            for index, line in enumerate(handle):
                if index >= 32:
                    break
                if not line.strip():
                    continue
                value = json.loads(line)
                if isinstance(value, dict) and value.get("type") == "session_meta":
                    payload = value.get("payload")
                    return payload if isinstance(payload, dict) else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return None


def recent_trace_files(trace_root: Path, window: Window) -> list[Path]:
    """Return traces that could contain an in-window call without reading their contents."""
    minimum_mtime = window.start.timestamp()
    files: list[Path] = []
    for path in trace_root.rglob("*.jsonl"):
        try:
            if path.stat().st_mtime >= minimum_mtime:
                files.append(path)
        except OSError:
            continue
    return sorted(files)


def authorized_trace_files(
    trace_root: Path,
    workspace_roots: set[str],
    window: Window,
) -> list[Path]:
    """Inspect only session metadata before allowing any full trace-content scan."""
    accepted: list[Path] = []
    for path in recent_trace_files(trace_root, window):
        meta = read_trace_meta(path)
        if meta is not None and is_root_managed_session(meta, workspace_roots):
            accepted.append(path)
    return accepted


def clipped(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def trace_reads(
    path: Path,
    authorized_audits: Mapping[tuple[str, str], str],
    authorized_chat_pattern: re.Pattern[str],
    workspace_agents: Mapping[str, str],
    tree_roots: Sequence[Path],
    window: Window,
    max_passage_chars: int,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, set[str]], dict[str, set[str]]]:
    audit_ids = set(authorized_audits.values())
    reads: dict[str, list[dict[str, Any]]] = {item: [] for item in audit_ids}
    sessions: dict[str, set[str]] = {item: set() for item in audit_ids}
    gaps: dict[str, set[str]] = {item: set() for item in audit_ids}
    meta = read_trace_meta(path)
    workspace_roots = set(workspace_agents)
    if not isinstance(meta, dict) or not is_root_managed_session(meta, workspace_roots):
        return reads, sessions, gaps
    resolved_workspace = str(Path(str(meta["cwd"])).resolve())
    reader_agent_id = workspace_agents[resolved_workspace]
    default_workdir = Path(resolved_workspace)

    calls: dict[str, dict[str, Any]] = {}
    outputs: dict[str, tuple[str, str | None, bool]] = {}
    current_audit_id: str | None = None
    mentioned_chat_ids: set[str] = set()
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                mentioned_chat_ids.update(authorized_chat_pattern.findall(line))
                row = json.loads(line)
                if not isinstance(row, dict) or row.get("type") != "response_item":
                    continue
                payload = row.get("payload")
                if not isinstance(payload, dict):
                    continue
                payload_type = payload.get("type")
                if payload_type == "message" and payload.get("role") == "user":
                    user_text = payload_text(payload.get("content"))
                    if CHAT_CONTEXT_PATTERN.search(user_text) is None:
                        continue
                    all_ids = set(chat_ids_from_text(user_text))
                    matched_audits = {
                        authorized_audits[(chat_id, reader_agent_id)]
                        for chat_id in all_ids
                        if (chat_id, reader_agent_id) in authorized_audits
                    }
                    if len(all_ids) == 1 and len(matched_audits) == 1:
                        current_audit_id = next(iter(matched_audits))
                        sessions[current_audit_id].add(str(path))
                    else:
                        if len(all_ids) > 1:
                            for item in matched_audits:
                                gaps[item].add("ambiguous_multiple_chat_ids_in_trace_turn")
                        current_audit_id = None
                    if not all_ids:
                        for item in audit_ids:
                            if str(path) in sessions[item]:
                                gaps[item].add("invalid_runtime_chat_context_for_trace_turn")
                    continue
                if payload_type in {"custom_tool_call", "function_call"}:
                    call_id = payload.get("call_id")
                    if not isinstance(call_id, str) or current_audit_id is None:
                        continue
                    tool_name = str(payload.get("name") or "")
                    raw = tool_raw(payload)
                    node_paths = extract_node_paths(payload, tree_roots, default_workdir)
                    is_continuation = tool_name.endswith(("write_stdin", "wait"))
                    if not is_continuation and not is_markdown_read(tool_name, raw, node_paths):
                        continue
                    calls[call_id] = {
                        "audit_id": current_audit_id,
                        "timestamp": row.get("timestamp"),
                        "payload": payload,
                        "arguments": parse_tool_arguments(payload),
                        "raw": raw,
                        "node_paths": node_paths,
                    }
                    continue
                if payload_type in {"custom_tool_call_output", "function_call_output"}:
                    call_id = payload.get("call_id")
                    if not isinstance(call_id, str) or call_id not in calls:
                        continue
                    call_audit_id = calls[call_id]["audit_id"]
                    if current_audit_id != call_audit_id:
                        gaps[call_audit_id].add("cross_chat_tool_output_rejected")
                        if current_audit_id is not None:
                            gaps[current_audit_id].add("cross_chat_tool_output_rejected")
                        continue
                    output, output_truncated = clipped(
                        payload_text(payload.get("output")),
                        max_passage_chars,
                    )
                    outputs[call_id] = (
                        output,
                        row.get("timestamp"),
                        output_truncated,
                    )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        affected_audits = {
            authorized_audits[(chat_id, reader_agent_id)]
            for chat_id in mentioned_chat_ids
            if (chat_id, reader_agent_id) in authorized_audits
        }
        for item in affected_audits:
            sessions[item].add(str(path))
            gaps[item].add("codex_trace_malformed_or_partially_cleaned")
        return reads, sessions, gaps

    shell_sessions: dict[str, str] = {}
    cell_sessions: dict[str, str] = {}
    continuation_outputs: dict[str, list[tuple[str, str | None, str | None, bool]]] = {}
    for call_id, call in calls.items():
        payload = call["payload"]
        tool_name = str(payload.get("name") or "")
        output, output_completed_at, output_truncated = outputs.get(call_id, ("", None, False))
        if tool_name.endswith("exec_command"):
            match = SHELL_SESSION_PATTERN.search(output)
            if match:
                shell_sessions[match.group(1)] = call_id
        elif tool_name.endswith("exec"):
            match = CELL_SESSION_PATTERN.search(output)
            if match:
                cell_sessions[match.group(1)] = call_id
        if tool_name.endswith("write_stdin"):
            session_id = call["arguments"].get("session_id")
            original_call_id = shell_sessions.get(str(session_id))
            if original_call_id is not None:
                if calls[original_call_id]["audit_id"] != call["audit_id"]:
                    gaps[calls[original_call_id]["audit_id"]].add("cross_chat_continuation_rejected")
                    gaps[call["audit_id"]].add("cross_chat_continuation_rejected")
                    continue
                continuation_outputs.setdefault(original_call_id, []).append(
                    (output, output_completed_at, call.get("timestamp"), output_truncated)
                )
        elif tool_name.endswith("wait"):
            cell_id = call["arguments"].get("cell_id")
            original_call_id = cell_sessions.get(str(cell_id))
            if original_call_id is not None:
                if calls[original_call_id]["audit_id"] != call["audit_id"]:
                    gaps[calls[original_call_id]["audit_id"]].add("cross_chat_continuation_rejected")
                    gaps[call["audit_id"]].add("cross_chat_continuation_rejected")
                    continue
                continuation_outputs.setdefault(original_call_id, []).append(
                    (output, output_completed_at, call.get("timestamp"), output_truncated)
                )

    for items in continuation_outputs.values():
        items.sort(key=lambda item: str(item[2] or ""))

    for call_id, call in calls.items():
        current_id = call["audit_id"]
        timestamp = call.get("timestamp")
        if not isinstance(timestamp, str) or not in_window(timestamp, window):
            continue
        payload = call["payload"]
        tool_name = str(payload.get("name") or "")
        if tool_name.endswith(("write_stdin", "wait")):
            continue
        raw = call["raw"]
        node_paths = call["node_paths"]
        initial_output, completed_at, initial_truncated = outputs.get(call_id, ("", None, False))
        continuations = continuation_outputs.get(call_id, [])
        output = initial_output
        output_was_truncated = initial_truncated
        if continuations:
            output = "\n".join([output, *(item[0] for item in continuations)])
            completed_at = continuations[-1][1]
            output_was_truncated = output_was_truncated or any(item[3] for item in continuations)
        initial_handle = (
            SHELL_SESSION_PATTERN.search(initial_output)
            if tool_name.endswith("exec_command")
            else CELL_SESSION_PATTERN.search(initial_output)
            if tool_name.endswith("exec")
            else None
        )
        if initial_handle is not None:
            last_output = continuations[-1][0] if continuations else ""
            last_pending = (
                SHELL_SESSION_PATTERN.search(last_output)
                if tool_name.endswith("exec_command")
                else CELL_SESSION_PATTERN.search(last_output)
            )
            if not continuations or last_pending is not None:
                gaps[current_id].add("tree_read_output_pending")
                continue
        if not output.strip():
            gaps[current_id].add("tree_read_output_missing")
            continue
        success = output_success(output)
        if success is False:
            gaps[current_id].add("tree_read_command_failed")
            continue
        if success is None:
            success = True
        passage, passage_truncated = clipped(output, max_passage_chars)
        passage_truncated = passage_truncated or output_was_truncated
        if passage_truncated:
            gaps[current_id].add("tree_read_passage_truncated")
        command, command_truncated = clipped(raw, 4000)
        read_id = hashlib.sha256(f"{path}:{call_id}".encode()).hexdigest()[:20]
        reads[current_id].append(
            {
                "read_id": read_id,
                "timestamp": timestamp,
                "completed_at": completed_at,
                "session_file": str(path),
                "call_id": call_id,
                "tool_name": tool_name,
                "reader_agent_id": reader_agent_id,
                "node_paths": node_paths,
                "content_class_hint": content_class_hint(node_paths),
                "command": command,
                "command_truncated": command_truncated,
                "passage": passage,
                "passage_truncated": passage_truncated,
                "success": success,
            }
        )
    return reads, sessions, gaps


def collect_evidence(args: argparse.Namespace) -> None:
    artifact_root = resolve_artifact_root(args.artifact_root)
    chats_path = artifact_path(artifact_root, args.chats, field="--chats", must_exist=True)
    output_path = artifact_path(artifact_root, args.output, field="--output", must_exist=False)
    require_distinct_paths({"--chats": chats_path, "--output": output_path})
    window = resolve_window(args.days, args.now)
    chat_rows = [normalize_chat(row, window) for row in iter_jsonl(chats_path)]
    if not chat_rows:
        raise AuditError("No authorized Chat records were provided.")
    if len({chat["audit_id"] for chat in chat_rows}) != len(chat_rows):
        raise AuditError("The Chat export contains duplicate Chat and audited-Agent pairs.")
    chats = {chat["audit_id"]: chat for chat in chat_rows}
    authorized_audits = {
        (chat["chat_id"], chat["source_agent_id"]): chat["audit_id"] for chat in chat_rows
    }
    authorized_chat_ids = {chat["chat_id"] for chat in chat_rows}
    workspace_agents = parse_agent_workspaces(args.agent_workspace)
    scoped_agent_ids = {chat["source_agent_id"] for chat in chat_rows}
    configured_agent_ids = set(workspace_agents.values())
    if configured_agent_ids != scoped_agent_ids:
        missing = scoped_agent_ids - configured_agent_ids
        extra = configured_agent_ids - scoped_agent_ids
        raise AuditError(
            f"--agent-workspace must match the exact scoped Agent UUIDs; missing={sorted(missing)}, extra={sorted(extra)}."
        )
    workspace_roots = set(workspace_agents)
    tree_roots = tuple(sorted({Path(root).expanduser().resolve() for root in args.tree_root}))
    if not tree_roots:
        raise AuditError("At least one exact --tree-root is required.")
    for tree_root in tree_roots:
        if not tree_root.is_dir():
            raise AuditError(f"Authorized --tree-root is not a directory: {tree_root}")
    trace_root = (Path(args.trace_root).expanduser() if args.trace_root else trace_root_default()).resolve()
    if not trace_root.is_dir():
        for chat in chats.values():
            chat["coverage_gaps"].append("codex_trace_root_missing_or_cleaned")
        trace_files: list[Path] = []
    else:
        trace_files = authorized_trace_files(trace_root, workspace_roots, window)

    per_audit_reads: dict[str, list[dict[str, Any]]] = {item: [] for item in chats}
    per_audit_sessions: dict[str, set[str]] = {item: set() for item in chats}
    per_audit_gaps: dict[str, set[str]] = {item: set() for item in chats}

    authorized_chat_pattern = re.compile("|".join(re.escape(chat_id) for chat_id in sorted(authorized_chat_ids)))
    for trace_file in trace_files:
        reads, sessions, gaps = trace_reads(
            trace_file,
            authorized_audits,
            authorized_chat_pattern,
            workspace_agents,
            tree_roots,
            window,
            args.max_passage_chars,
        )
        for item in chats:
            per_audit_reads[item].extend(reads[item])
            per_audit_sessions[item].update(sessions[item])
            per_audit_gaps[item].update(gaps[item])

    output_rows: list[dict[str, Any]] = []
    for current_audit_id, chat in sorted(chats.items()):
        chat_id = chat["chat_id"]
        reads = sorted(
            per_audit_reads[current_audit_id], key=lambda item: (item["timestamp"], item["read_id"])
        )
        messages = chat["messages"]
        visible_tree_mentions = [
            message
            for message in messages
            if TREE_MENTION_PATTERN.search(str(message.get("content") or "")) is not None
        ]
        choice_messages = []
        agent_messages = [
            message for message in messages if message.get("sender_id") == chat["source_agent_id"]
        ]
        if reads:
            earliest_read = parse_datetime(reads[0]["timestamp"])
            choice_messages = [
                message
                for message in agent_messages
                if isinstance(message.get("created_at"), str)
                and parse_datetime(message["created_at"]) >= earliest_read
            ]
        elif visible_tree_mentions:
            choice_messages = [
                message
                for message in visible_tree_mentions
                if message.get("sender_id") == chat["source_agent_id"]
            ]
        candidate_status = "candidate" if reads or visible_tree_mentions else "outside_candidate_set"
        gaps = set(chat["coverage_gaps"]) | per_audit_gaps[current_audit_id]
        if not per_audit_sessions[current_audit_id]:
            gaps.add("no_mapped_codex_trace")
        elif per_audit_sessions[current_audit_id] and not reads and visible_tree_mentions:
            gaps.add("no_successful_tree_content_read")
        output_rows.append(
            {
                "schema_version": SCHEMA_VERSION,
                "audit_id": current_audit_id,
                "chat": {
                    "chat_id": chat_id,
                    "title": chat["title"],
                    "authorization": chat["authorization"],
                    "source_agent": chat["source_agent"],
                    "source_agent_id": chat["source_agent_id"],
                    "message_count": len(messages),
                },
                "window": {"start": isoformat(window.start), "end": isoformat(window.end)},
                "candidate_status": candidate_status,
                "mapped_trace_files": sorted(per_audit_sessions[current_audit_id]),
                "reads": reads,
                "visible_choice_candidates": choice_messages,
                "visible_tree_mentions": visible_tree_mentions,
                "coverage_gaps": sorted(gaps),
            }
        )
    write_jsonl(output_path, output_rows)


def validate_rubric(value: Any, *, chat_id: str) -> dict[str, bool | None]:
    if not isinstance(value, dict):
        raise AuditError(f"Judgment for {chat_id} must contain a rubric object.")
    rubric: dict[str, bool | None] = {}
    for key in RUBRIC_KEYS:
        item = value.get(key)
        if item not in (True, False, None):
            raise AuditError(f"Judgment for {chat_id} rubric.{key} must be true, false, or null.")
        rubric[key] = item
    return rubric


def string_id_list(value: Any, *, field: str) -> list[str]:
    if not isinstance(value, list):
        raise AuditError(f"{field} must be an array.")
    items = [require_string(item, field) for item in value]
    if len(set(items)) != len(items):
        raise AuditError(f"{field} must not contain duplicate IDs.")
    return items


def load_judgments(path: Path) -> dict[str, dict[str, Any]]:
    judgments: dict[str, dict[str, Any]] = {}
    for row in iter_jsonl(path):
        current_audit_id = require_string(row.get("audit_id"), "judgment.audit_id")
        parts = current_audit_id.split("@")
        if len(parts) != 2 or any(re.fullmatch(UUID_PATTERN, part) is None for part in parts):
            raise AuditError("judgment.audit_id must use CHAT_UUID@AGENT_UUID syntax.")
        if current_audit_id in judgments:
            raise AuditError(f"Duplicate judgment for audit unit {current_audit_id}.")
        result = require_string(row.get("result"), f"judgment[{current_audit_id}].result")
        if result not in RESULT_VALUES:
            raise AuditError(f"Judgment for {current_audit_id} has invalid result {result}.")
        effect = row.get("effect")
        if effect is not None and effect not in EFFECT_VALUES:
            raise AuditError(f"Judgment for {current_audit_id} has invalid effect {effect}.")
        rubric = validate_rubric(row.get("rubric"), chat_id=current_audit_id)
        if result == "verified" and any(rubric[key] is not True for key in RUBRIC_KEYS):
            raise AuditError(
                f"Verified judgment for {current_audit_id} requires all five rubric checks to be true."
            )
        if result == "probable":
            if any(rubric[key] is not True for key in RUBRIC_KEYS[:4]):
                raise AuditError(
                    f"Probable judgment for {current_audit_id} requires real read, normal passage, relevance, and read-before-choice."
                )
            if all(rubric[key] is True for key in RUBRIC_KEYS):
                raise AuditError(
                    f"Probable judgment for {current_audit_id} satisfies the verified bar; classify it as verified."
                )
        if result in {"verified", "probable"} and effect is None:
            raise AuditError(f"{result.title()} judgment for {current_audit_id} requires an effect.")
        if result == "unproven" and effect is not None:
            raise AuditError(f"Unproven judgment for {current_audit_id} must not claim an effect.")
        if result == "unproven" and all(rubric[key] is True for key in RUBRIC_KEYS):
            raise AuditError(
                f"Unproven judgment for {current_audit_id} satisfies the verified bar; classify it as verified."
            )
        row["rubric"] = rubric
        row["summary"] = require_string(row.get("summary"), f"judgment[{current_audit_id}].summary")
        row["read_ids"] = string_id_list(
            row.get("read_ids", []), field=f"judgment[{current_audit_id}].read_ids"
        )
        row["choice_message_ids"] = string_id_list(
            row.get("choice_message_ids", []),
            field=f"judgment[{current_audit_id}].choice_message_ids",
        )
        if result in {"verified", "probable"}:
            if not row["read_ids"]:
                raise AuditError(
                    f"{result.title()} judgment for {current_audit_id} requires at least one read ID."
                )
            if not row["choice_message_ids"]:
                raise AuditError(
                    f"{result.title()} judgment for {current_audit_id} requires at least one visible choice message ID."
                )
        raw_gaps = row.get("coverage_gaps", [])
        if not isinstance(raw_gaps, list):
            raise AuditError(f"judgment[{current_audit_id}].coverage_gaps must be an array.")
        row["coverage_gaps"] = [str(gap) for gap in raw_gaps]
        representative = row.get("representative", False)
        if not isinstance(representative, bool):
            raise AuditError(f"judgment[{current_audit_id}].representative must be boolean.")
        row["representative"] = representative
        judgments[current_audit_id] = row
    return judgments


def validate_judgment_refs(candidate: Mapping[str, Any], judgment: Mapping[str, Any]) -> None:
    current_audit_id = candidate["audit_id"]
    reads_by_id = {read["read_id"]: read for read in candidate["reads"]}
    unknown_reads = set(judgment["read_ids"]) - set(reads_by_id)
    if unknown_reads:
        raise AuditError(
            f"Judgment for {current_audit_id} references unknown read IDs: {sorted(unknown_reads)}."
        )
    messages_by_id = {
        message.get("message_id"): message
        for message in candidate["visible_choice_candidates"]
        if message.get("message_id") is not None
    }
    unknown_messages = set(judgment["choice_message_ids"]) - set(messages_by_id)
    if unknown_messages:
        raise AuditError(
            f"Judgment for {current_audit_id} references unknown choice message IDs: {sorted(unknown_messages)}."
        )
    if judgment["result"] not in {"verified", "probable"}:
        return

    selected_reads = [reads_by_id[read_id] for read_id in judgment["read_ids"]]
    for read in selected_reads:
        if (
            read.get("success") is not True
            or not str(read.get("passage") or "").strip()
            or not read.get("node_paths")
        ):
            raise AuditError(
                f"Positive judgment for {current_audit_id} references a read without successful passage evidence."
            )
    selected_messages = [
        messages_by_id[message_id] for message_id in judgment["choice_message_ids"]
    ]
    if judgment["rubric"]["read_before_choice"] is True:
        missing_completion = [
            read["read_id"] for read in selected_reads if not isinstance(read.get("completed_at"), str)
        ]
        if missing_completion:
            raise AuditError(
                f"Positive judgment for {current_audit_id} cannot prove read-before-choice without completion timestamps: {missing_completion}."
            )
        read_times = [
            parse_datetime(
                str(read["completed_at"]),
                field=f"read {read['read_id']} completion time",
            )
            for read in selected_reads
        ]
        choice_times = [
            parse_datetime(
                require_string(message.get("created_at"), f"choice {message.get('message_id')} created_at"),
                field=f"choice {message.get('message_id')} created_at",
            )
            for message in selected_messages
        ]
        if max(read_times) > min(choice_times):
            raise AuditError(
                f"Judgment for {current_audit_id} claims read_before_choice, but a cited read completed after the earliest cited choice."
            )


def table_row(columns: Sequence[Any]) -> str:
    return "| " + " | ".join(str(column).replace("|", "\\|") for column in columns) + " |"


def representative_cases(evidence: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    selected = [
        row
        for row in evidence
        if isinstance(row.get("judgment"), dict) and row["judgment"].get("representative") is True
    ]
    if selected:
        return selected
    verified = [row for row in evidence if row.get("judgment", {}).get("result") == "verified"]
    return verified[:5]


def render_report(evidence: Sequence[Mapping[str, Any]], generated_at: datetime) -> str:
    candidates = [row for row in evidence if row["candidate_status"] == "candidate"]
    judged = [row for row in candidates if isinstance(row.get("judgment"), dict)]
    result_counts = Counter(row["judgment"]["result"] for row in judged)
    effect_counts = Counter(
        row["judgment"]["effect"] for row in judged if row["judgment"].get("effect") is not None
    )
    mapped_audits = sum(1 for row in evidence if row["mapped_trace_files"])
    chat_message_counts: dict[str, int] = {}
    mapped_chat_ids: set[str] = set()
    for row in evidence:
        chat_id = row["chat"]["chat_id"]
        chat_message_counts[chat_id] = max(
            chat_message_counts.get(chat_id, 0),
            int(row["chat"]["message_count"]),
        )
        if row["mapped_trace_files"]:
            mapped_chat_ids.add(chat_id)
    message_count = sum(chat_message_counts.values())
    gap_counts = Counter(gap for row in evidence for gap in row["coverage_gaps"])
    window_starts = {row["window"]["start"] for row in evidence}
    window_ends = {row["window"]["end"] for row in evidence}
    constraint_hits = sum(
        1
        for row in judged
        if row["judgment"]["result"] == "verified"
        and row["judgment"].get("effect") in {"constrained", "redirected", "conflicted"}
    )

    lines = [
        "# Context Tree Value Audit",
        "",
        f"Generated: {isoformat(generated_at)}",
        f"Window: {min(window_starts)} – {max(window_ends)}",
        "",
        "## Outcome",
        "",
        table_row(["Result", "Chat-Agent audits", "Meaning"]),
        table_row(["---", "---:", "---"]),
        table_row(["verified", result_counts["verified"], "All five rubric checks are evidenced."]),
        table_row(["probable", result_counts["probable"], "Relevant pre-choice normal passage and aligned outcome, with a visible-causality gap."]),
        table_row(["unproven", result_counts["unproven"], "Available records do not meet the value bar."]),
        "",
        f"Verified constraint hits (`constrained` + `redirected` + `conflicted`): **{constraint_hits}**.",
        "",
        "These counts are an auditable lower bound, not an effective-read rate. A file read, selector call, or Context Tree mention is not value by itself.",
        "",
        "## Effect Distribution",
        "",
        table_row(["Effect", "Verified or probable audits"]),
        table_row(["---", "---:"]),
    ]
    for effect in ("confirmed", "constrained", "redirected", "conflicted"):
        lines.append(table_row([effect, effect_counts[effect]]))

    lines.extend(
        [
            "",
            "## Representative Cases",
            "",
        ]
    )
    representatives = representative_cases(evidence)
    if not representatives:
        lines.append("No representative verified case was selected.")
        lines.append("")
    for row in representatives:
        judgment = row["judgment"]
        referenced_reads = {
            read["read_id"]: read for read in row["reads"] if read["read_id"] in judgment["read_ids"]
        }
        paths = sorted({path for read in referenced_reads.values() for path in read["node_paths"]})
        lines.extend(
            [
                f"### {row['chat']['title']} (`{row['chat']['chat_id'][:8]}` @ `{row['chat']['source_agent_id'][:8]}`)",
                "",
                f"- Result/effect: `{judgment['result']}` / `{judgment.get('effect') or 'none'}`",
                f"- Tree paths: {', '.join(f'`{path}`' for path in paths) if paths else 'No verified path'}",
                f"- Influence: {judgment['summary']}",
                "",
            ]
        )

    lines.extend(
        [
            "## Coverage",
            "",
            table_row(["Measure", "Count"]),
            table_row(["---", "---:"]),
            table_row(["Authorized Chats in window", len(chat_message_counts)]),
            table_row(["Authorized Chat-Agent audit units", len(evidence)]),
            table_row(["Visible messages", message_count]),
            table_row(["Chats mapped to local Codex traces", len(mapped_chat_ids)]),
            table_row(["Audit units mapped to local Codex traces", mapped_audits]),
            table_row(["Evidence candidates", len(candidates)]),
            table_row(["Passage-level judgments", len(judged)]),
            table_row(["Outside candidate set", len(evidence) - len(candidates)]),
            "",
            "Outside-candidate audit units are not `unproven` and are not an eligible denominator. Historical records cannot establish which tasks had relevant decision-bearing Tree content available.",
            "",
            "### Coverage gaps",
            "",
        ]
    )
    if not gap_counts:
        lines.append("- None recorded.")
    else:
        for gap, count in sorted(gap_counts.items()):
            lines.append(f"- `{gap}`: {count} audit unit(s)")

    lines.extend(
        [
            "",
            "## Rubric and Boundaries",
            "",
            "A `verified` result requires: a real successful Tree content read; a decision-bearing normal passage; task relevance; a read before the choice; and visible influence on the later choice.",
            "",
            "A `probable` result still requires a real, task-relevant, decision-bearing normal passage completed before the choice, but visible causality remains incomplete. `unproven` means the available records do not support the claim; it does not mean the Tree had no effect.",
            "",
            "This V0 uses only local Codex traces mapped by the runtime-injected `chatId`. Missing, cleaned, malformed, non-Codex, or truncated traces remain explicit coverage gaps. The audit does not modify Chats, traces, the Context Tree, or product state.",
            "",
        ]
    )
    return "\n".join(lines)


def finalize_report(args: argparse.Namespace) -> None:
    artifact_root = resolve_artifact_root(args.artifact_root)
    candidates_path = artifact_path(
        artifact_root, args.candidates, field="--candidates", must_exist=True
    )
    judgments_path = artifact_path(
        artifact_root, args.judgments, field="--judgments", must_exist=True
    )
    evidence_path = artifact_path(
        artifact_root, args.evidence_output, field="--evidence-output", must_exist=False
    )
    report_path = artifact_path(
        artifact_root, args.report_output, field="--report-output", must_exist=False
    )
    require_distinct_paths(
        {
            "--candidates": candidates_path,
            "--judgments": judgments_path,
            "--evidence-output": evidence_path,
            "--report-output": report_path,
        }
    )
    candidates = list(iter_jsonl(candidates_path))
    if not candidates:
        raise AuditError("No candidate records were provided.")
    judgments = load_judgments(judgments_path)
    candidate_ids = {row["audit_id"] for row in candidates if row.get("candidate_status") == "candidate"}
    missing = candidate_ids - set(judgments)
    extra = set(judgments) - candidate_ids
    if missing:
        raise AuditError(f"Missing judgments for candidate audit units: {sorted(missing)}.")
    if extra:
        raise AuditError(
            f"Judgments reference non-candidate or missing audit units: {sorted(extra)}."
        )

    evidence: list[dict[str, Any]] = []
    for candidate in sorted(candidates, key=lambda row: row["audit_id"]):
        row = dict(candidate)
        current_audit_id = row["audit_id"]
        judgment = judgments.get(current_audit_id)
        if judgment is not None:
            validate_judgment_refs(row, judgment)
            row["judgment"] = judgment
            row["coverage_gaps"] = sorted(set(row["coverage_gaps"]) | set(judgment["coverage_gaps"]))
        else:
            row["judgment"] = None
        evidence.append(row)

    generated_at = parse_datetime(args.generated_at, field="--generated-at") if args.generated_at else datetime.now(timezone.utc)
    write_jsonl(evidence_path, evidence)
    write_text(report_path, f"{render_report(evidence, generated_at)}\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only deterministic collector and reporter for Context Tree value audits."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser("export-chats", help="Export only the Chats named by an authorization scope.")
    export_parser.add_argument(
        "--artifact-root",
        required=True,
        help="Exact triggering-agent artifact directory; every input and output must stay inside it.",
    )
    export_parser.add_argument("--scope", required=True, help="Scope JSON containing owned agents and/or explicit Chats.")
    export_parser.add_argument("--output", required=True, help="Destination Chat JSONL.")
    export_parser.add_argument("--days", type=int, default=7, help="Lookback window in days (default: 7).")
    export_parser.add_argument("--now", help="Fixed RFC 3339 window end for reproducible runs.")
    export_parser.add_argument(
        "--first-tree-bin",
        default=os.environ.get("FIRST_TREE_BIN", "first-tree"),
        help="First Tree CLI binary (default: FIRST_TREE_BIN or first-tree).",
    )
    export_parser.set_defaults(handler=export_chats)

    collect_parser = subparsers.add_parser("collect", help="Pair authorized Chat records with local Codex trace evidence.")
    collect_parser.add_argument(
        "--artifact-root",
        required=True,
        help="Exact triggering-agent artifact directory; every input and output must stay inside it.",
    )
    collect_parser.add_argument("--chats", required=True, help="Authorized Chat JSONL from export-chats.")
    collect_parser.add_argument("--output", required=True, help="Destination candidate evidence JSONL.")
    collect_parser.add_argument("--days", type=int, default=7, help="Lookback window in days (default: 7).")
    collect_parser.add_argument("--now", help="Fixed RFC 3339 window end for reproducible runs.")
    collect_parser.add_argument(
        "--trace-root",
        help="Codex sessions root (default: CODEX_HOME/sessions or ~/.codex/sessions).",
    )
    collect_parser.add_argument(
        "--agent-workspace",
        action="append",
        default=[],
        required=True,
        help="Exact AGENT_UUID=/absolute/workspace binding; repeat for each scoped Agent.",
    )
    collect_parser.add_argument(
        "--tree-root",
        action="append",
        default=[],
        required=True,
        help="Exact authorized bound Context Tree root; repeat when scoped workspaces use different Trees.",
    )
    collect_parser.add_argument(
        "--max-passage-chars",
        type=int,
        default=24000,
        help="Maximum stored tool-output characters per read (default: 24000).",
    )
    collect_parser.set_defaults(handler=collect_evidence)

    report_parser = subparsers.add_parser("report", help="Validate Agent judgments and render final evidence/report artifacts.")
    report_parser.add_argument(
        "--artifact-root",
        required=True,
        help="Exact triggering-agent artifact directory; every input and output must stay inside it.",
    )
    report_parser.add_argument("--candidates", required=True, help="Candidate JSONL from collect.")
    report_parser.add_argument("--judgments", required=True, help="Passage-level Agent judgment JSONL.")
    report_parser.add_argument("--evidence-output", required=True, help="Destination final evidence JSONL.")
    report_parser.add_argument("--report-output", required=True, help="Destination Markdown report.")
    report_parser.add_argument("--generated-at", help="Fixed RFC 3339 report timestamp for reproducible runs.")
    report_parser.set_defaults(handler=finalize_report)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if getattr(args, "max_passage_chars", 1) <= 0:
            raise AuditError("--max-passage-chars must be greater than zero.")
        args.handler(args)
    except AuditError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
