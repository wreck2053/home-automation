from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, load_settings
from .device import RoomDeviceClient
from .events import event, new_run_id
from .graph import RoomAssistant
from .schemas import ChatRequest, EventPhase, LifecycleEvent


STATIC_DIR = Path(__file__).resolve().parent / "static"


class AssistantLike(Protocol):
    async def run(self, prompt: str, history=None):  # type: ignore[no-untyped-def]
        ...

    async def aclose(self) -> None:
        ...


AssistantFactory = Callable[[Settings], AssistantLike]


def encode_sse(lifecycle_event: LifecycleEvent) -> str:
    return f"event: lifecycle\ndata: {lifecycle_event.model_dump_json()}\n\n"


def create_app(assistant_factory: AssistantFactory | None = None) -> FastAPI:
    app = FastAPI(title="Local LangGraph Room Assistant")
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.post("/api/chat")
    async def chat(request: ChatRequest) -> StreamingResponse:
        settings = load_settings()

        async def stream():
            if not settings.has_deepseek_api_key:
                run_id = new_run_id()
                yield encode_sse(
                    event(
                        run_id=run_id,
                        turn_id=run_id[:10],
                        phase=EventPhase.error,
                        heading="Missing API Key",
                        message="DEEPSEEK_API_KEY is required for chat requests.",
                    )
                )
                return

            assistant = (
                assistant_factory(settings)
                if assistant_factory is not None
                else RoomAssistant.from_settings(settings)
            )
            try:
                async for lifecycle_event in assistant.run(
                    request.prompt, history=request.history
                ):
                    yield encode_sse(lifecycle_event)
            finally:
                await assistant.aclose()

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.get("/api/device-state")
    async def device_state() -> dict:
        settings = load_settings()
        async with RoomDeviceClient(
            base_url=settings.room_device_base_url_value,
            timeout_seconds=settings.room_http_timeout_seconds,
        ) as device_client:
            try:
                state = await device_client.get_state()
            except Exception as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            return state.model_dump(mode="json")

    @app.get("/health")
    async def health() -> dict:
        settings = load_settings()
        device_ok = False
        device_error = None
        async with RoomDeviceClient(
            base_url=settings.room_device_base_url_value,
            timeout_seconds=settings.room_http_timeout_seconds,
        ) as device_client:
            try:
                await device_client.get_state()
                device_ok = True
            except Exception as exc:
                device_error = str(exc)
        return {
            "ok": settings.has_deepseek_api_key and device_ok,
            "deepseek_api_key": "configured" if settings.has_deepseek_api_key else "missing",
            "device": "reachable" if device_ok else "unreachable",
            "device_error": device_error,
            "settings": settings.safe_summary(),
        }

    return app


app = create_app()
