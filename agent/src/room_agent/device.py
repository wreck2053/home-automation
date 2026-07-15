from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from .schemas import AcFeature, AcMode, FanLevel, RoomState, ToolResult


class RoomDeviceError(RuntimeError):
    pass


class RoomDeviceClient:
    def __init__(
        self,
        *,
        base_url: str,
        timeout_seconds: float,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(
            base_url=base_url.rstrip("/"), timeout=timeout_seconds
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> "RoomDeviceClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def get_state(self) -> RoomState:
        response = await self._request("GET", "/api/state")
        try:
            return RoomState.model_validate(response.json())
        except ValueError as exc:
            raise RoomDeviceError("Device returned invalid state JSON") from exc

    async def get_diagnostics(self) -> str:
        response = await self._request("GET", "/diagnostics")
        return response.text

    async def get_diagnostics_result(self) -> ToolResult:
        return await self._result_from_call(
            "get_diagnostics",
            lambda: self.get_diagnostics(),
            success_message="Fetched diagnostics",
        )

    async def get_room_state_result(self) -> ToolResult:
        return await self._result_from_call(
            "get_room_state",
            lambda: self.get_state(),
            success_message="Fetched current room state",
        )

    async def set_light(self, power: bool) -> ToolResult:
        return await self._set_toggle_relay(
            action="set_light",
            current_key="light",
            desired=power,
            command_path="/toggle-light",
            label="Light",
        )

    async def set_fan(self, power: bool) -> ToolResult:
        return await self._set_toggle_relay(
            action="set_fan",
            current_key="fan",
            desired=power,
            command_path="/toggle-fan",
            label="Fan",
        )

    async def advance_light_color(self) -> ToolResult:
        action = "advance_light_color"
        try:
            before = await self.get_state()
            if not before.light:
                return ToolResult(
                    success=False,
                    action=action,
                    message="Light must be on before changing color",
                    before=before,
                    after=before,
                )
            raw_response = await self._send_command("/next-color")
            after = await self.get_state()
            return ToolResult(
                success=True,
                action=action,
                message="Light color advanced",
                before=before,
                after=after,
                raw_response=raw_response,
            )
        except RoomDeviceError as exc:
            return self._error_result(action, exc)

    async def set_ac_power(self, power: bool) -> ToolResult:
        action = "set_ac_power"
        try:
            before = await self.get_state()
            if before.ac.power == power:
                return self._skipped_result(
                    action, f"AC already {'on' if power else 'off'}", before
                )
            raw_response = await self._send_command(
                "/power/on" if power else "/power/off"
            )
            after = await self.get_state()
            return ToolResult(
                success=True,
                action=action,
                message=f"AC turned {'on' if power else 'off'}",
                before=before,
                after=after,
                raw_response=raw_response,
            )
        except RoomDeviceError as exc:
            return self._error_result(action, exc)

    async def set_ac_temperature(self, celsius: int) -> ToolResult:
        action = "set_ac_temperature"
        if celsius < 17 or celsius > 30:
            return ToolResult(
                success=False,
                action=action,
                message="AC temperature must be between 17 and 30 C",
            )
        try:
            before = await self.get_state()
            if before.ac.power and before.ac.temperature == celsius:
                return self._skipped_result(
                    action, f"AC already set to {celsius} C", before
                )
            raw_response = await self._send_command(f"/temp/set/{celsius}")
            after = await self.get_state()
            return ToolResult(
                success=True,
                action=action,
                message=f"AC set to {celsius} C",
                before=before,
                after=after,
                raw_response=raw_response,
            )
        except RoomDeviceError as exc:
            return self._error_result(action, exc)

    async def set_ac_mode(self, mode: AcMode | str) -> ToolResult:
        action = "set_ac_mode"
        try:
            ac_mode = mode if isinstance(mode, AcMode) else AcMode(str(mode).upper())
        except ValueError:
            return ToolResult(
                success=False,
                action=action,
                message="Supported AC modes are COOL and HEAT",
            )

        path = {
            AcMode.cool: "/mode/cool",
            AcMode.heat: "/mode/heat",
        }[ac_mode]

        try:
            before = await self.get_state()
            if before.ac.power and before.ac.mode.upper() == ac_mode.value:
                return self._skipped_result(action, f"AC already in {ac_mode.value}", before)
            raw_response = await self._send_command(path)
            after = await self.get_state()
            return ToolResult(
                success=True,
                action=action,
                message=f"AC mode set to {ac_mode.value}",
                before=before,
                after=after,
                raw_response=raw_response,
            )
        except RoomDeviceError as exc:
            return self._error_result(action, exc)

    async def set_ac_fan_level(self, level: FanLevel | int) -> ToolResult:
        action = "set_ac_fan_level"
        try:
            fan_level = level if isinstance(level, FanLevel) else FanLevel(int(level))
        except (TypeError, ValueError):
            return ToolResult(
                success=False,
                action=action,
                message="AC fan level must be 1, 2, or 3",
            )

        path = {
            FanLevel.low: "/fan/low",
            FanLevel.medium: "/fan/med",
            FanLevel.high: "/fan/high",
        }[fan_level]

        try:
            before = await self.get_state()
            if before.ac.power and before.ac.fan_level == int(fan_level):
                return self._skipped_result(
                    action, f"AC fan already at level {int(fan_level)}", before
                )
            raw_response = await self._send_command(path)
            after = await self.get_state()
            return ToolResult(
                success=True,
                action=action,
                message=f"AC fan set to level {int(fan_level)}",
                before=before,
                after=after,
                raw_response=raw_response,
            )
        except RoomDeviceError as exc:
            return self._error_result(action, exc)

    async def set_ac_feature(
        self, feature: AcFeature | str, enabled: bool, *, force: bool = False
    ) -> ToolResult:
        action = "set_ac_feature"
        try:
            ac_feature = (
                feature if isinstance(feature, AcFeature) else AcFeature(str(feature))
            )
        except ValueError:
            return ToolResult(
                success=False,
                action=action,
                message="Supported AC features are swing, led, and turbo",
            )

        try:
            before = await self.get_state()
            current = bool(getattr(before.ac, ac_feature.value))
            if current == enabled and not force:
                return self._skipped_result(
                    action,
                    f"AC {ac_feature.value} already {'enabled' if enabled else 'disabled'}",
                    before,
                )
            if ac_feature == AcFeature.turbo:
                path = f"/state/turbo/{'on' if enabled else 'off'}"
                if force:
                    path += "?force=1"
            else:
                path = f"/state/{ac_feature.value}"
            raw_response = await self._send_command(path)
            after = await self.get_state()
            actual = bool(getattr(after.ac, ac_feature.value))
            if actual != enabled:
                return ToolResult(
                    success=False,
                    action=action,
                    message=f"AC {ac_feature.value} did not reach the requested state",
                    before=before,
                    after=after,
                    raw_response=raw_response,
                )
            return ToolResult(
                success=True,
                action=action,
                message=f"AC {ac_feature.value} {'enabled' if enabled else 'disabled'}",
                before=before,
                after=after,
                raw_response=raw_response,
            )
        except RoomDeviceError as exc:
            return self._error_result(action, exc)

    async def _set_toggle_relay(
        self,
        *,
        action: str,
        current_key: str,
        desired: bool,
        command_path: str,
        label: str,
    ) -> ToolResult:
        try:
            before = await self.get_state()
            if bool(getattr(before, current_key)) == desired:
                return self._skipped_result(
                    action, f"{label} already {'on' if desired else 'off'}", before
                )
            raw_response = await self._send_command(command_path)
            after = await self.get_state()
            return ToolResult(
                success=True,
                action=action,
                message=f"{label} turned {'on' if desired else 'off'}",
                before=before,
                after=after,
                raw_response=raw_response,
            )
        except RoomDeviceError as exc:
            return self._error_result(action, exc)

    async def _result_from_call(
        self,
        action: str,
        call: Callable[[], Awaitable[RoomState | str]],
        *,
        success_message: str,
    ) -> ToolResult:
        try:
            value = await call()
            if isinstance(value, RoomState):
                return ToolResult(
                    success=True,
                    action=action,
                    message=success_message,
                    raw_response=value.model_dump(mode="json"),
                )
            return ToolResult(
                success=True,
                action=action,
                message=success_message,
                raw_response=value,
            )
        except RoomDeviceError as exc:
            return self._error_result(action, exc)

    async def _send_command(self, path: str) -> str:
        response = await self._request("GET", path)
        return response.text

    async def _request(self, method: str, path: str) -> httpx.Response:
        try:
            response = await self._client.request(method, path)
            if response.status_code >= 400:
                message = response.text.strip() or response.reason_phrase
                raise RoomDeviceError(
                    f"Device request {path} failed with {response.status_code}: {message}"
                )
            return response
        except httpx.TimeoutException as exc:
            raise RoomDeviceError(f"Device request timed out for {path}") from exc
        except httpx.RequestError as exc:
            raise RoomDeviceError(f"Could not reach device at {path}: {exc}") from exc

    def _skipped_result(self, action: str, message: str, state: RoomState) -> ToolResult:
        return ToolResult(
            success=True,
            action=action,
            message=message,
            skipped=True,
            before=state,
            after=state,
        )

    def _error_result(self, action: str, exc: Exception) -> ToolResult:
        return ToolResult(success=False, action=action, message=str(exc))


def tool_result_json(result: ToolResult) -> str:
    return result.model_dump_json(by_alias=True)
