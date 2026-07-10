from __future__ import annotations

from typing import Any
from uuid import uuid4

from .schemas import EventPhase, LifecycleEvent


TERMINAL_COLORS: dict[EventPhase, str] = {
    EventPhase.phase_start: "bright_magenta",
    EventPhase.state_snapshot: "bright_blue",
    EventPhase.model_start: "bright_yellow",
    EventPhase.model_token: "yellow",
    EventPhase.model_intermediate: "bright_magenta",
    EventPhase.token_usage: "bright_white",
    EventPhase.tool_call: "orange1",
    EventPhase.tool_result: "deep_sky_blue1",
    EventPhase.final: "spring_green1",
    EventPhase.error: "bright_red",
}

UI_COLORS: dict[EventPhase, str] = {
    EventPhase.phase_start: "#d879ff",
    EventPhase.state_snapshot: "#59a7ff",
    EventPhase.model_start: "#ffd166",
    EventPhase.model_token: "#f7d774",
    EventPhase.model_intermediate: "#bc8cff",
    EventPhase.token_usage: "#d7e1f2",
    EventPhase.tool_call: "#ff9f43",
    EventPhase.tool_result: "#5ad7ff",
    EventPhase.final: "#24f28c",
    EventPhase.error: "#ff5d6c",
}

REDACTED_KEYS = {
    "api_key",
    "authorization",
    "deepseek_api_key",
    "access_token",
    "refresh_token",
    "secret",
    "password",
}

SAFE_TOKEN_KEYS = {
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "deepseek_max_output_tokens",
}


def new_run_id() -> str:
    return uuid4().hex


def redact_payload(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key).lower()
            if key_text in SAFE_TOKEN_KEYS:
                redacted[key] = redact_payload(item)
            elif any(secret_key in key_text for secret_key in REDACTED_KEYS):
                redacted[key] = "***"
            else:
                redacted[key] = redact_payload(item)
        return redacted
    if isinstance(value, list):
        return [redact_payload(item) for item in value]
    return value


def event(
    *,
    run_id: str,
    turn_id: str,
    phase: EventPhase,
    heading: str,
    message: str,
    payload: dict[str, Any] | None = None,
    color: str | None = None,
) -> LifecycleEvent:
    return LifecycleEvent(
        run_id=run_id,
        turn_id=turn_id,
        phase=phase,
        heading=heading,
        message=message,
        color=color or UI_COLORS[phase],
        payload=redact_payload(payload) if payload is not None else None,
    )


def event_dict(**kwargs: Any) -> dict[str, Any]:
    return event(**kwargs).model_dump(mode="json")
