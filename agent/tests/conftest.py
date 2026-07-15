from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest


def state_payload(
    *,
    light: bool = False,
    fan: bool = False,
    ac_power: bool = False,
    temperature: int = 24,
    fan_level: int = 3,
    swing: bool = False,
    led: bool = False,
    turbo: bool = False,
) -> dict[str, Any]:
    return {
        "light": light,
        "fan": fan,
        "connected": True,
        "ac": {
            "power": ac_power,
            "mode": "COOL",
            "temperature": temperature,
            "fanLevel": fan_level,
            "swing": swing,
            "led": led,
            "turbo": turbo,
        },
    }


@pytest.fixture
def mutable_device_transport() -> Callable[[dict[str, Any]], httpx.MockTransport]:
    def make_transport(state: dict[str, Any]) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            if path == "/api/state":
                return httpx.Response(200, json=state)
            if path == "/diagnostics":
                return httpx.Response(200, text="uptime_ms=1\nac_queued_commands=0\n")
            if path == "/toggle-light":
                state["light"] = not state["light"]
                return httpx.Response(200, text="Light toggled")
            if path == "/toggle-fan":
                state["fan"] = not state["fan"]
                return httpx.Response(200, text="Fan toggled")
            if path == "/next-color":
                return httpx.Response(200, text="Light color advanced")
            if path == "/power/on":
                state["ac"]["power"] = True
                return httpx.Response(200, text="Power On")
            if path == "/power/off":
                state["ac"]["power"] = False
                return httpx.Response(200, text="Power Off")
            if path.startswith("/temp/set/"):
                state["ac"]["power"] = True
                state["ac"]["temperature"] = int(path.rsplit("/", 1)[1])
                return httpx.Response(200, text="Temperature Set")
            if path == "/mode/cool":
                state["ac"]["power"] = True
                state["ac"]["mode"] = "COOL"
                return httpx.Response(200, text="Cool Mode")
            if path == "/mode/heat":
                state["ac"]["power"] = True
                state["ac"]["mode"] = "HEAT"
                return httpx.Response(200, text="Heat Mode")
            if path in {"/fan/low", "/fan/med", "/fan/high"}:
                state["ac"]["power"] = True
                state["ac"]["fanLevel"] = {"/fan/low": 1, "/fan/med": 2, "/fan/high": 3}[path]
                return httpx.Response(200, text="Fan Level")
            if path in {"/state/swing", "/state/led", "/state/turbo"}:
                feature = path.rsplit("/", 1)[1]
                state["ac"][feature] = not state["ac"][feature]
                return httpx.Response(200, text="Feature")
            if path in {"/state/turbo/on", "/state/turbo/off"}:
                state["ac"]["turbo"] = path.endswith("/on")
                return httpx.Response(200, text="Turbo")
            return httpx.Response(404, text=json.dumps({"error": path}))

        return httpx.MockTransport(handler)

    return make_transport
