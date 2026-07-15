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

    async def run(
        self, prompt: str, history=None, *, thread_id: str | None = None
    ) -> AsyncIterator[LifecycleEvent]:
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


class FakeCheckpointAssistant(FakeAssistant):
    def __init__(self, status: str) -> None:
        super().__init__()
        self.status = status

    async def thread_status(self, thread_id: str) -> dict:
        return {"thread_id": thread_id, "status": self.status}

    async def resume(
        self, thread_id: str, approved: bool
    ) -> AsyncIterator[LifecycleEvent]:
        yield event(
            run_id="run",
            turn_id="turn",
            phase=EventPhase.approval_decision,
            heading="Turbo Approval Decision",
            message="approved" if approved else "denied",
            payload={"thread_id": thread_id, "approved": approved},
        )
        yield event(
            run_id="run",
            turn_id="turn",
            phase=EventPhase.final,
            heading="Final Output",
            message="done",
        )


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
                    "thread_id": "browser-thread-1",
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


@pytest.mark.asyncio
async def test_markdown_ui_assets_are_served_in_dependency_order() -> None:
    app = create_app()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        index = await client.get("/")
        assets = [
            await client.get("/static/vendor/lucide.min.js"),
            await client.get("/static/vendor/marked.umd.js"),
            await client.get("/static/vendor/purify.min.js"),
            await client.get("/static/vendor/highlight.min.js"),
            await client.get("/static/markdown.js"),
            await client.get("/static/tool-progress.js"),
        ]

    assert index.status_code == 200
    assert all(response.status_code == 200 for response in assets)
    html = index.text
    assert "LANGGRAPH LOCAL" not in html
    assert "LANGGRAPH" not in html
    assert "Room assistant for Rahul's bedroom" not in html
    assert html.index("lucide.min.js") < html.index("marked.umd.js")
    assert html.index("marked.umd.js") < html.index("purify.min.js")
    assert html.index("purify.min.js") < html.index("highlight.min.js")
    assert html.index("highlight.min.js") < html.index("markdown.js")
    assert html.index("markdown.js") < html.index("tool-progress.js")
    assert html.index("tool-progress.js") < html.index("app.js")
    assert 'id="composerExpand"' in html
    assert 'data-icon="Maximize2"' in html
    assert '>Logs</button>' in html
    assert 'class="workflow-step"' not in html
    assert 'id="workflowTooltip"' not in html
    assert 'data-icon="Lightbulb"' in html
    assert 'data-icon="Fan"' in html
    assert 'data-icon="Snowflake"' in html
    assert 'data-icon="Thermometer"' in html
    assert 'aria-label="AC settings"' in html
    assert "Climate" not in html
    assert 'id="stopResponse"' in html
    assert 'id="scrollLatest"' in html
    assert 'id="clearSession"' not in html
    assert 'id="resetUsage"' not in html
    assert 'class="usage-actions"' not in html


@pytest.mark.asyncio
async def test_empty_checkpoint_thread_can_be_inspected_and_deleted(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("ROOM_AGENT_CHECKPOINT_DB", str(tmp_path / "checkpoints.sqlite3"))
    app = create_app()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        status = await client.get("/api/threads/browser-thread")
        deleted = await client.delete("/api/threads/browser-thread")

    assert status.status_code == 200
    assert status.json()["status"] == "empty"
    assert status.json()["exists"] is False
    assert deleted.status_code == 204


@pytest.mark.asyncio
async def test_pending_thread_rejects_new_prompt_and_accepts_one_resume(
    monkeypatch,
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    fake_assistant = FakeCheckpointAssistant("interrupted")
    app = create_app(lambda settings: fake_assistant)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        blocked = await client.post(
            "/api/chat",
            json={"thread_id": "thread-1", "prompt": "new prompt"},
        )
        resumed = await client.post(
            "/api/chat/resume",
            json={"thread_id": "thread-1", "approved": True},
        )
        fake_assistant.status = "ready"
        stale = await client.post(
            "/api/chat/resume",
            json={"thread_id": "thread-1", "approved": True},
        )

    assert blocked.status_code == 409
    assert resumed.status_code == 200
    assert [item["phase"] for item in parse_sse_events(resumed.text)] == [
        "approval_decision",
        "final",
    ]
    assert stale.status_code == 409
