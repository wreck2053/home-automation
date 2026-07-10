from __future__ import annotations

from typing import Annotated

from langchain_core.tools import BaseTool, tool
from pydantic import Field

from .device import RoomDeviceClient, tool_result_json
from .schemas import AcFeature, AcMode, FanLevel


def create_room_tools(device_client: RoomDeviceClient) -> list[BaseTool]:
    @tool
    async def get_room_state() -> str:
        """Read the current light, fan, and AC state from the room controller."""
        return tool_result_json(await device_client.get_room_state_result())

    @tool
    async def get_diagnostics() -> str:
        """Read low-level ESP32 diagnostics for debugging connectivity and AC command queues."""
        return tool_result_json(await device_client.get_diagnostics_result())

    @tool
    async def set_light(
        power: Annotated[bool, Field(description="True turns the light on; false turns it off.")],
    ) -> str:
        """Set the room light power state. Use this when the room is dark."""
        return tool_result_json(await device_client.set_light(power))

    @tool
    async def set_fan(
        power: Annotated[bool, Field(description="True turns the fan on; false turns it off.")],
    ) -> str:
        """Set the room fan power state. Use this for hot/cold comfort requests."""
        return tool_result_json(await device_client.set_fan(power))

    @tool
    async def set_ac_power(
        power: Annotated[bool, Field(description="True turns the AC on; false turns it off.")],
    ) -> str:
        """Set the AC power state."""
        return tool_result_json(await device_client.set_ac_power(power))

    @tool
    async def set_ac_temperature(
        celsius: Annotated[int, Field(ge=17, le=30, description="Target AC temperature in Celsius.")],
    ) -> str:
        """Set the AC target temperature from 17 to 30 C."""
        return tool_result_json(await device_client.set_ac_temperature(celsius))

    @tool
    async def set_ac_mode(
        mode: Annotated[AcMode, Field(description="Supported values: COOL or HEAT.")],
    ) -> str:
        """Set the AC mode. Only COOL and HEAT are exposed by the ESP32 HTTP API."""
        return tool_result_json(await device_client.set_ac_mode(mode))

    @tool
    async def set_ac_fan_level(
        level: Annotated[FanLevel, Field(description="1=low, 2=medium, 3=high.")],
    ) -> str:
        """Set the AC fan level."""
        return tool_result_json(await device_client.set_ac_fan_level(level))

    @tool
    async def set_ac_feature(
        feature: Annotated[AcFeature, Field(description="Feature to set: swing, led, or turbo.")],
        enabled: Annotated[bool, Field(description="True enables the feature; false disables it.")],
    ) -> str:
        """Enable or disable an AC toggle feature."""
        return tool_result_json(await device_client.set_ac_feature(feature, enabled))

    @tool
    async def advance_light_color() -> str:
        """Advance the light color. Only use this when the light is already on."""
        return tool_result_json(await device_client.advance_light_color())

    return [
        get_room_state,
        get_diagnostics,
        set_light,
        set_fan,
        set_ac_power,
        set_ac_temperature,
        set_ac_mode,
        set_ac_fan_level,
        set_ac_feature,
        advance_light_color,
    ]
