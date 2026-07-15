from __future__ import annotations

import json

import httpx
import pytest

from room_agent.device import RoomDeviceClient
from room_agent.tools import create_room_tools

from .conftest import state_payload


@pytest.mark.asyncio
async def test_set_light_is_idempotent_when_already_on(mutable_device_transport) -> None:
    state = state_payload(light=True)
    calls: list[str] = []
    transport = mutable_device_transport(state)

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return await transport.handle_async_request(request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://device"
    ) as http_client:
        client = RoomDeviceClient(
            base_url="http://device", timeout_seconds=1, http_client=http_client
        )
        result = await client.set_light(True)

    assert result.success is True
    assert result.skipped is True
    assert "/toggle-light" not in calls


@pytest.mark.asyncio
async def test_set_fan_toggles_when_needed(mutable_device_transport) -> None:
    state = state_payload(fan=True)
    async with httpx.AsyncClient(
        transport=mutable_device_transport(state), base_url="http://device"
    ) as http_client:
        client = RoomDeviceClient(
            base_url="http://device", timeout_seconds=1, http_client=http_client
        )
        result = await client.set_fan(False)

    assert result.success is True
    assert state["fan"] is False


@pytest.mark.asyncio
async def test_temperature_out_of_range_is_rejected(mutable_device_transport) -> None:
    state = state_payload()
    async with httpx.AsyncClient(
        transport=mutable_device_transport(state), base_url="http://device"
    ) as http_client:
        client = RoomDeviceClient(
            base_url="http://device", timeout_seconds=1, http_client=http_client
        )
        result = await client.set_ac_temperature(31)

    assert result.success is False
    assert "between 17 and 30" in result.message


@pytest.mark.asyncio
async def test_advance_light_color_requires_light_on(mutable_device_transport) -> None:
    state = state_payload(light=False)
    async with httpx.AsyncClient(
        transport=mutable_device_transport(state), base_url="http://device"
    ) as http_client:
        client = RoomDeviceClient(
            base_url="http://device", timeout_seconds=1, http_client=http_client
        )
        result = await client.advance_light_color()

    assert result.success is False
    assert "must be on" in result.message


@pytest.mark.asyncio
async def test_tool_returns_friendly_timeout_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("no response", request=request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://device"
    ) as http_client:
        client = RoomDeviceClient(
            base_url="http://device", timeout_seconds=1, http_client=http_client
        )
        tools = {tool.name: tool for tool in create_room_tools(client)}
        response = await tools["set_light"].ainvoke({"power": True})

    parsed = json.loads(response)
    assert parsed["success"] is False
    assert "timed out" in parsed["message"]


@pytest.mark.asyncio
async def test_disabling_turbo_and_other_features_do_not_interrupt(
    mutable_device_transport,
) -> None:
    state = state_payload(ac_power=True, turbo=True, swing=False)
    async with httpx.AsyncClient(
        transport=mutable_device_transport(state), base_url="http://device"
    ) as http_client:
        client = RoomDeviceClient(
            base_url="http://device", timeout_seconds=1, http_client=http_client
        )
        tools = {tool.name: tool for tool in create_room_tools(client)}
        turbo_result = json.loads(
            await tools["set_ac_feature"].ainvoke(
                {"feature": "turbo", "enabled": False}
            )
        )
        swing_result = json.loads(
            await tools["set_ac_feature"].ainvoke(
                {"feature": "swing", "enabled": True}
            )
        )

    assert turbo_result["success"] is True
    assert swing_result["success"] is True
    assert state["ac"]["turbo"] is False
    assert state["ac"]["swing"] is True
