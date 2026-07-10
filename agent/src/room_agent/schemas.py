from __future__ import annotations

from enum import Enum, IntEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class DeviceName(str, Enum):
    light = "light"
    fan = "fan"
    ac = "ac"


class AcMode(str, Enum):
    cool = "COOL"
    heat = "HEAT"


class AcFeature(str, Enum):
    swing = "swing"
    led = "led"
    turbo = "turbo"


class FanLevel(IntEnum):
    low = 1
    medium = 2
    high = 3


class EventPhase(str, Enum):
    phase_start = "phase_start"
    state_snapshot = "state_snapshot"
    model_start = "model_start"
    model_token = "model_token"
    model_intermediate = "model_intermediate"
    token_usage = "token_usage"
    tool_call = "tool_call"
    tool_result = "tool_result"
    final = "final"
    error = "error"


class AcState(BaseModel):
    model_config = ConfigDict(extra="ignore")

    power: bool
    mode: str
    temperature: int = Field(ge=17, le=30)
    fan_level: int = Field(alias="fanLevel", ge=1, le=3)
    swing: bool
    led: bool
    turbo: bool


class RoomState(BaseModel):
    model_config = ConfigDict(extra="ignore")

    light: bool
    fan: bool
    connected: bool
    ac: AcState


class ToolResult(BaseModel):
    success: bool
    action: str
    message: str
    skipped: bool = False
    before: RoomState | None = None
    after: RoomState | None = None
    raw_response: str | dict[str, Any] | None = None


class ChatHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    history: list[ChatHistoryMessage] = Field(default_factory=list, max_length=20)


class LifecycleEvent(BaseModel):
    run_id: str
    turn_id: str
    phase: EventPhase
    heading: str
    message: str
    color: str
    payload: dict[str, Any] | None = None
