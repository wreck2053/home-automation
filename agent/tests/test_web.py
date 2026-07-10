from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest

from room_agent.events import event
from room_agent.schemas import EventPhase, LifecycleEvent
from room_agent.web import create_app


class FakeAssistant:
    def __init__(self) -> None:
        self.history = None

    async def run(self, prompt: str, history=None) -> AsyncIterator[LifecycleEvent]:
        self.history = history
        yield event(
            run_id="run",
            turn_id="turn",
            phase=EventPhase.phase_start,
            heading="User Prompt",
            message=prompt,
        )
        yield event(
            run_id="run",
            turn_id="turn",
            phase=EventPhase.state_snapshot,
            heading="State Snapshot",
            message="loaded",
            payload={"state": {}},
        )
        yield event(
            run_id="run",
            turn_id="turn",
            phase=EventPhase.model_start,
            heading="Model Call",
            message="calling",
        )
        yield event(
            run_id="run",
            turn_id="turn",
            phase=EventPhase.token_usage,
            heading="Token Usage #1",
            message="input 10 / output 5 / total 15",
            payload={
                "call_index": 1,
                "input_tokens": 10,
                "cache_hit_input_tokens": 2,
                "cache_miss_input_tokens": 8,
                "output_tokens": 5,
                "total_tokens": 15,
                "estimated_total_cost_usd": 0.00001,
            },
        )
        yield event(
            run_id="run",
            turn_id="turn",
            phase=EventPhase.final,
            heading="Final Output",
            message="done",
        )

    async def aclose(self) -> None:
        pass


def parse_sse_events(text: str) -> list[dict]:
    import json

    events = []
    for block in text.strip().split("\n\n"):
        data = "\n".join(
            line.removeprefix("data:").strip()
            for line in block.splitlines()
            if line.startswith("data:")
        )
        if data:
            events.append(json.loads(data))
    return events


@pytest.mark.asyncio
async def test_chat_stream_event_order(monkeypatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    fake_assistant = FakeAssistant()
    app = create_app(lambda settings: fake_assistant)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/chat",
            json={
                "prompt": "hello",
                "history": [{"role": "user", "content": "your name is alexa"}],
            },
        )

    assert response.status_code == 200
    phases = [event["phase"] for event in parse_sse_events(response.text)]
    assert phases == [
        "phase_start",
        "state_snapshot",
        "model_start",
        "token_usage",
        "final",
    ]
    assert fake_assistant.history is not None
    assert fake_assistant.history[0].content == "your name is alexa"
