from __future__ import annotations

from typing import Any

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from room_agent.device import RoomDeviceClient
from room_agent.graph import RoomAssistant
from room_agent.schemas import EventPhase

from .conftest import state_payload


class FakeToolCallingModel:
    def bind_tools(self, tools):
        self.tools = tools
        return self

    async def ainvoke(self, messages: list[Any]) -> AIMessage:
        system_text = next(
            (
                message.content
                for message in messages
                if isinstance(message, SystemMessage) and isinstance(message.content, str)
            ),
            "",
        )
        is_planner = "Internal planning step:" in system_text

        if any(isinstance(message, ToolMessage) for message in messages):
            return AIMessage(
                content="Room action complete." if is_planner else "Done.",
                usage_metadata={
                    "input_tokens": 30,
                    "output_tokens": 5,
                    "total_tokens": 35,
                },
            )

        prompt = next(
            message.content
            for message in reversed(messages)
            if isinstance(message, HumanMessage)
        ).lower()

        if "dark" in prompt:
            return AIMessage(
                content="I will turn on the light.",
                tool_calls=[
                    {"name": "set_light", "args": {"power": True}, "id": "call_light"}
                ],
                usage_metadata={
                    "input_tokens": 20,
                    "output_tokens": 4,
                    "total_tokens": 24,
                },
            )
        if "cold" in prompt:
            return AIMessage(
                content="",
                tool_calls=[
                    {"name": "set_fan", "args": {"power": False}, "id": "call_fan"},
                    {"name": "set_ac_power", "args": {"power": False}, "id": "call_ac"},
                ],
                usage_metadata={
                    "input_tokens": 22,
                    "output_tokens": 6,
                    "total_tokens": 28,
                },
            )
        if "ac" in prompt and "23" in prompt:
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "set_ac_temperature",
                        "args": {"celsius": 23},
                        "id": "call_temp",
                    }
                ],
                usage_metadata={
                    "input_tokens": 24,
                    "output_tokens": 5,
                    "total_tokens": 29,
                },
            )
        return AIMessage(
            content="No room action needed." if is_planner else "Here is a small joke.",
            usage_metadata={
                "input_tokens": 18,
                "output_tokens": 7,
                "total_tokens": 25,
            },
        )


async def build_assistant(state: dict[str, Any], transport: httpx.MockTransport):
    http_client = httpx.AsyncClient(transport=transport, base_url="http://device")
    device_client = RoomDeviceClient(
        base_url="http://device", timeout_seconds=1, http_client=http_client
    )
    assistant = RoomAssistant(device_client=device_client, model=FakeToolCallingModel())
    return assistant, http_client


@pytest.mark.asyncio
async def test_general_chat_does_not_call_control_tools(mutable_device_transport) -> None:
    state = state_payload(light=False, fan=False)
    calls: list[str] = []
    base_transport = mutable_device_transport(state)

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return await base_transport.handle_async_request(request)

    assistant, http_client = await build_assistant(
        state, httpx.MockTransport(handler)
    )
    try:
        events = [event async for event in assistant.run("tell me a joke")]
    finally:
        await http_client.aclose()

    assert all(not path.startswith("/toggle") for path in calls)
    assert any(event.phase == EventPhase.final for event in events)
    token_events = [event for event in events if event.phase == EventPhase.token_usage]
    assert len(token_events) == 2
    assert token_events[0].payload["input_tokens"] == 18
    assert token_events[0].payload["cache_miss_input_tokens"] == 18
    assert token_events[0].payload["output_tokens"] == 7
    assert token_events[1].payload["call_index"] == 2


@pytest.mark.asyncio
async def test_dark_prompt_turns_light_on(mutable_device_transport) -> None:
    state = state_payload(light=False)
    assistant, http_client = await build_assistant(
        state, mutable_device_transport(state)
    )
    try:
        events = [event async for event in assistant.run("Alexa, it's too dark")]
    finally:
        await http_client.aclose()

    assert state["light"] is True
    intermediate_events = [
        event for event in events if event.phase == EventPhase.model_intermediate
    ]
    tool_draft_events = [
        event
        for event in intermediate_events
        if event.payload and event.payload.get("tool_call_count", 0) > 0
    ]
    assert [event.message for event in tool_draft_events] == [
        "I will turn on the light."
    ]
    intermediate_index = next(
        index
        for index, event in enumerate(events)
        if event.phase == EventPhase.model_intermediate
    )
    tool_call_index = next(
        index for index, event in enumerate(events) if event.phase == EventPhase.tool_call
    )
    assert intermediate_index < tool_call_index
    assert all(
        event.message != "Done." for event in intermediate_events
    )
    assert any(
        event.phase == EventPhase.tool_call
        and event.payload
        and event.payload["tool_call"]["name"] == "set_light"
        for event in events
    )
    token_events = [event for event in events if event.phase == EventPhase.token_usage]
    assert len(token_events) == 3
    assert [event.payload["call_index"] for event in token_events] == [1, 2, 3]
    assert token_events[0].payload["model"] == "unknown"
    assert "estimated_cache_miss_input_cost_usd" in token_events[0].payload
    model_starts = [
        event for event in events
        if event.phase == EventPhase.model_start and event.payload
    ]
    assert model_starts[-1].payload["node"] == "final_model"
    assert model_starts[-1].payload["response_target"] == "final"


@pytest.mark.asyncio
async def test_multi_step_trace_events_are_chronological(
    mutable_device_transport,
) -> None:
    class MultiStepModel:
        def __init__(self) -> None:
            self.call_count = 0

        def bind_tools(self, tools):
            return self

        async def ainvoke(self, messages: list[Any]) -> AIMessage:
            self.call_count += 1
            usage = {
                "input_tokens": 10,
                "output_tokens": 3,
                "total_tokens": 13,
            }
            if self.call_count == 1:
                return AIMessage(
                    content="First I will turn it on.",
                    tool_calls=[
                        {"name": "set_light", "args": {"power": True}, "id": "on"}
                    ],
                    usage_metadata=usage,
                )
            if self.call_count == 2:
                return AIMessage(
                    content="Now I will turn it off.",
                    tool_calls=[
                        {"name": "set_light", "args": {"power": False}, "id": "off"}
                    ],
                    usage_metadata=usage,
                )
            return AIMessage(content="Sequence complete.", usage_metadata=usage)

    state = state_payload(light=False)
    http_client = httpx.AsyncClient(
        transport=mutable_device_transport(state), base_url="http://device"
    )
    assistant = RoomAssistant(
        device_client=RoomDeviceClient(
            base_url="http://device", timeout_seconds=1, http_client=http_client
        ),
        model=MultiStepModel(),
    )
    try:
        events = [event async for event in assistant.run("run two light steps")]
    finally:
        await http_client.aclose()

    focused_phases = [
        event.phase
        for event in events
        if event.phase
        in {
            EventPhase.model_intermediate,
            EventPhase.tool_call,
            EventPhase.tool_result,
            EventPhase.final,
        }
    ]
    assert focused_phases == [
        EventPhase.model_intermediate,
        EventPhase.tool_call,
        EventPhase.tool_result,
        EventPhase.model_intermediate,
        EventPhase.tool_call,
        EventPhase.tool_result,
        EventPhase.final,
    ]


@pytest.mark.asyncio
async def test_cold_prompt_turns_fan_and_ac_off(mutable_device_transport) -> None:
    state = state_payload(fan=True, ac_power=True)
    assistant, http_client = await build_assistant(
        state, mutable_device_transport(state)
    )
    try:
        events = [event async for event in assistant.run("Alexa, it's too cold")]
    finally:
        await http_client.aclose()

    tool_names = {
        event.payload["tool_call"]["name"]
        for event in events
        if event.phase == EventPhase.tool_call and event.payload
    }
    assert state["fan"] is False
    assert state["ac"]["power"] is False
    assert {"set_fan", "set_ac_power"}.issubset(tool_names)


@pytest.mark.asyncio
async def test_explicit_ac_temperature_calls_ac_tool(mutable_device_transport) -> None:
    state = state_payload(ac_power=True, temperature=24)
    assistant, http_client = await build_assistant(
        state, mutable_device_transport(state)
    )
    try:
        events = [event async for event in assistant.run("set the AC to 23")]
    finally:
        await http_client.aclose()

    assert state["ac"]["temperature"] == 23
    assert any(
        event.phase == EventPhase.tool_call
        and event.payload
        and event.payload["tool_call"]["name"] == "set_ac_temperature"
        for event in events
    )


class TurboToolCallingModel:
    def bind_tools(self, tools):
        return self

    async def ainvoke(self, messages: list[Any]) -> AIMessage:
        system_text = next(
            (message.content for message in messages if isinstance(message, SystemMessage)),
            "",
        )
        is_planner = "Internal planning step:" in system_text
        if any(isinstance(message, ToolMessage) for message in messages):
            return AIMessage(content="" if is_planner else "Turbo request handled.")
        return AIMessage(
            content="Enabling turbo.",
            tool_calls=[
                {
                    "name": "set_ac_feature",
                    "args": {"feature": "turbo", "enabled": True},
                    "id": "call_turbo",
                }
            ],
        )


class ResetThenEnableTurboModel:
    def bind_tools(self, tools):
        return self

    async def ainvoke(self, messages: list[Any]) -> AIMessage:
        system_text = next(
            (message.content for message in messages if isinstance(message, SystemMessage)),
            "",
        )
        is_planner = "Internal planning step:" in system_text
        tool_messages = [message for message in messages if isinstance(message, ToolMessage)]
        if not is_planner:
            return AIMessage(content="Turbo request handled.")
        if not tool_messages:
            return AIMessage(
                content="I will reset turbo first.",
                tool_calls=[
                    {
                        "name": "set_ac_feature",
                        "args": {"feature": "turbo", "enabled": False},
                        "id": "call_turbo_off",
                    }
                ],
            )
        if len(tool_messages) == 1:
            return AIMessage(
                content="Now enabling turbo.",
                tool_calls=[
                    {
                        "name": "set_ac_feature",
                        "args": {"feature": "turbo", "enabled": True},
                        "id": "call_turbo_on",
                    }
                ],
            )
        return AIMessage(content="")


@pytest.mark.asyncio
@pytest.mark.parametrize("approved", [True, False])
async def test_turbo_activation_interrupts_before_device_mutation(
    mutable_device_transport, approved: bool
) -> None:
    state = state_payload(ac_power=True, turbo=False)
    calls: list[str] = []
    base_transport = mutable_device_transport(state)

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return await base_transport.handle_async_request(request)

    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://device"
    )
    assistant = RoomAssistant(
        device_client=RoomDeviceClient(
            base_url="http://device", timeout_seconds=1, http_client=http_client
        ),
        model=TurboToolCallingModel(),
    )
    try:
        first_events = [
            item async for item in assistant.run("enable AC turbo", thread_id="turbo-thread")
        ]
        assert state["ac"]["turbo"] is False
        assert "/state/turbo/on" not in calls
        assert any(item.phase == EventPhase.approval_required for item in first_events)
        assert (await assistant.thread_status("turbo-thread"))["status"] == "interrupted"

        resumed_events = [
            item async for item in assistant.resume("turbo-thread", approved)
        ]
    finally:
        await http_client.aclose()

    assert state["ac"]["turbo"] is approved
    assert calls.count("/state/turbo/on") == (1 if approved else 0)
    assert any(item.phase == EventPhase.approval_decision for item in resumed_events)
    assert any(item.phase == EventPhase.final for item in resumed_events)


@pytest.mark.asyncio
async def test_enable_request_blocks_model_attempt_to_cycle_turbo_before_approval(
    mutable_device_transport,
) -> None:
    # The ESP32 can report stale desired state after a physical remote changes the AC.
    # Model the physical unit as off while the controller reports turbo on.
    state = state_payload(ac_power=True, turbo=True)
    toggle_calls: list[str] = []
    base_transport = mutable_device_transport(state)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/state/turbo/on":
            toggle_calls.append(request.url.path)
        return await base_transport.handle_async_request(request)

    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://device"
    )
    assistant = RoomAssistant(
        device_client=RoomDeviceClient(
            base_url="http://device", timeout_seconds=1, http_client=http_client
        ),
        model=ResetThenEnableTurboModel(),
    )
    try:
        first_events = [
            item
            async for item in assistant.run(
                "Turbo is not on, turn on turbo again", thread_id="guard-thread"
            )
        ]
        assert toggle_calls == []
        blocked = [
            item
            for item in first_events
            if item.phase == EventPhase.tool_result and "disable blocked" in item.message
        ]
        assert blocked
        assert any(item.phase == EventPhase.approval_required for item in first_events)

        resumed_events = [item async for item in assistant.resume("guard-thread", True)]
    finally:
        await http_client.aclose()

    assert toggle_calls == ["/state/turbo/on"]
    assert any(item.phase == EventPhase.final for item in resumed_events)


@pytest.mark.asyncio
async def test_sqlite_checkpoint_restores_thread_without_replaying_history(
    mutable_device_transport, tmp_path
) -> None:
    database = tmp_path / "checkpoints.sqlite3"
    state = state_payload()

    async def run_turn(prompt: str, history=None):
        async with AsyncSqliteSaver.from_conn_string(str(database)) as saver:
            http_client = httpx.AsyncClient(
                transport=mutable_device_transport(state), base_url="http://device"
            )
            assistant = RoomAssistant(
                device_client=RoomDeviceClient(
                    base_url="http://device", timeout_seconds=1, http_client=http_client
                ),
                model=FakeToolCallingModel(),
                checkpointer=saver,
            )
            try:
                return [
                    item
                    async for item in assistant.run(
                        prompt, history=history, thread_id="persistent-thread"
                    )
                ]
            finally:
                await http_client.aclose()

    await run_turn("tell me a joke")
    second = await run_turn(
        "tell me another joke",
        history=[{"role": "user", "content": "this must not be replayed"}],
    )
    checkpoint = next(item for item in second if item.heading == "Checkpoint Thread")
    assert checkpoint.payload["restored"] is True
    assert checkpoint.payload["bootstrap_messages"] == 0
    assert checkpoint.payload["message_count"] > 0
