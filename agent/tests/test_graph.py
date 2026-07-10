from __future__ import annotations

from typing import Any

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from room_agent.device import RoomDeviceClient
from room_agent.graph import RoomAssistant
from room_agent.schemas import EventPhase

from .conftest import state_payload


class FakeToolCallingModel:
    def bind_tools(self, tools):
        self.tools = tools
        return self

    async def ainvoke(self, messages: list[Any]) -> AIMessage:
        if any(isinstance(message, ToolMessage) for message in messages):
            return AIMessage(
                content="Done.",
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
            content="Here is a small joke.",
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
    assert len(token_events) == 1
    assert token_events[0].payload["input_tokens"] == 18
    assert token_events[0].payload["cache_miss_input_tokens"] == 18
    assert token_events[0].payload["output_tokens"] == 7


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
    assert [event.message for event in intermediate_events] == [
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
    assert len(token_events) == 2
    assert [event.payload["call_index"] for event in token_events] == [1, 2]
    assert token_events[0].payload["model"] == "unknown"
    assert "estimated_cache_miss_input_cost_usd" in token_events[0].payload


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
