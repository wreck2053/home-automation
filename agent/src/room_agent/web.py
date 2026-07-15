from __future__ import annotations

import base64
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from pathlib import Path
from time import perf_counter
from typing import Protocol

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from .config import Settings, load_settings
from .device import RoomDeviceClient
from .events import event, new_run_id, redact_payload
from .graph import RoomAssistant
from .schemas import ChatRequest, EventPhase, LifecycleEvent, ResumeRequest


STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_TRANSCRIPTION_BYTES = 2 * 1024 * 1024
TRANSCRIPTION_CONTENT_TYPES = {"audio/wav", "audio/x-wav", "audio/wave"}


class AssistantLike(Protocol):
    async def run(  # type: ignore[no-untyped-def]
        self, prompt: str, history=None, *, thread_id: str | None = None
    ):
        ...

    async def resume(self, thread_id: str, approved: bool):
        ...

    async def thread_status(self, thread_id: str) -> dict:
        ...

    async def aclose(self) -> None:
        ...


AssistantFactory = Callable[[Settings], AssistantLike]
SaverContext = AbstractAsyncContextManager[AsyncSqliteSaver]


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
        if not settings.has_deepseek_api_key:
            raise HTTPException(status_code=503, detail="DEEPSEEK_API_KEY is required")
        assistant, saver_context = await _open_assistant(settings, assistant_factory)
        if hasattr(assistant, "thread_status"):
            try:
                status = await assistant.thread_status(request.thread_id)
            except Exception:
                await _close_assistant(assistant, saver_context)
                raise
            if status.get("status") == "interrupted":
                await _close_assistant(assistant, saver_context)
                raise HTTPException(
                    status_code=409,
                    detail="Resolve the pending turbo approval before sending another prompt.",
                )

        async def stream():
            try:
                async for lifecycle_event in assistant.run(
                    request.prompt, history=request.history, thread_id=request.thread_id
                ):
                    yield encode_sse(lifecycle_event)
            finally:
                await _close_assistant(assistant, saver_context)

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post("/api/chat/resume")
    async def resume_chat(request: ResumeRequest) -> StreamingResponse:
        settings = load_settings()
        if not settings.has_deepseek_api_key:
            raise HTTPException(status_code=503, detail="DEEPSEEK_API_KEY is required")
        assistant, saver_context = await _open_assistant(settings, assistant_factory)
        if not hasattr(assistant, "resume") or not hasattr(assistant, "thread_status"):
            await _close_assistant(assistant, saver_context)
            raise HTTPException(status_code=501, detail="Assistant does not support resume")
        try:
            status = await assistant.thread_status(request.thread_id)
        except Exception:
            await _close_assistant(assistant, saver_context)
            raise
        if status.get("status") != "interrupted":
            await _close_assistant(assistant, saver_context)
            raise HTTPException(status_code=409, detail="Thread has no pending approval")

        async def stream():
            try:
                async for lifecycle_event in assistant.resume(
                    request.thread_id, request.approved
                ):
                    yield encode_sse(lifecycle_event)
            finally:
                await _close_assistant(assistant, saver_context)

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.get("/api/threads/{thread_id}")
    async def thread_status(thread_id: str) -> dict:
        settings = load_settings()
        if not settings.has_deepseek_api_key:
            raise HTTPException(status_code=503, detail="DEEPSEEK_API_KEY is required")
        assistant, saver_context = await _open_assistant(settings, assistant_factory)
        try:
            if not hasattr(assistant, "thread_status"):
                raise HTTPException(status_code=501, detail="Assistant does not support checkpoints")
            return redact_payload(await assistant.thread_status(thread_id))
        finally:
            await _close_assistant(assistant, saver_context)

    @app.delete("/api/threads/{thread_id}", status_code=204)
    async def delete_thread(thread_id: str) -> Response:
        settings = load_settings()
        settings.checkpoint_db_path.parent.mkdir(parents=True, exist_ok=True)
        async with AsyncSqliteSaver.from_conn_string(
            str(settings.checkpoint_db_path)
        ) as saver:
            await saver.setup()
            await saver.adelete_thread(thread_id)
        return Response(status_code=204)

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

    @app.post("/api/voice/transcribe")
    async def transcribe_voice(request: Request) -> dict:
        settings = load_settings()
        if not settings.has_openrouter_api_key:
            raise HTTPException(status_code=503, detail="OPENROUTER_API_KEY is required")
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in TRANSCRIPTION_CONTENT_TYPES:
            raise HTTPException(status_code=415, detail="A WAV audio body is required")
        content_length = request.headers.get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > MAX_TRANSCRIPTION_BYTES:
            raise HTTPException(status_code=413, detail="Audio recording is too large")
        audio = await request.body()
        if not audio:
            raise HTTPException(status_code=400, detail="Audio recording is empty")
        if len(audio) > MAX_TRANSCRIPTION_BYTES:
            raise HTTPException(status_code=413, detail="Audio recording is too large")
        return await _transcribe_voice_audio(audio, settings)

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


async def _transcribe_voice_audio(audio: bytes, settings: Settings) -> dict:
    started = perf_counter()
    try:
        async with httpx.AsyncClient(timeout=settings.openrouter_timeout_seconds) as client:
            response = await client.post(
                f"{settings.openrouter_base_url_value}/audio/transcriptions",
                headers={
                    "Authorization": f"Bearer {settings.openrouter_api_key_value}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://127.0.0.1:8000",
                    "X-OpenRouter-Title": "Deepy Voice Lab",
                },
                json={
                    "model": settings.openrouter_transcribe_model,
                    "temperature": 0,
                    "input_audio": {
                        "data": base64.b64encode(audio).decode("ascii"),
                        "format": "wav",
                    },
                },
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="Transcription service timed out") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Transcription service is unavailable") from exc

    upstream_latency_ms = round((perf_counter() - started) * 1000)
    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Transcription service rejected the request ({response.status_code})",
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Transcription service returned invalid JSON") from exc
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=502, detail="Transcription service returned no text")
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
    return {
        "text": text.strip(),
        "upstream_latency_ms": upstream_latency_ms,
        "usage": usage,
    }


async def _open_assistant(
    settings: Settings, assistant_factory: AssistantFactory | None
) -> tuple[AssistantLike, SaverContext | None]:
    if assistant_factory is not None:
        return assistant_factory(settings), None
    settings.checkpoint_db_path.parent.mkdir(parents=True, exist_ok=True)
    saver_context = AsyncSqliteSaver.from_conn_string(str(settings.checkpoint_db_path))
    saver = await saver_context.__aenter__()
    try:
        assistant = RoomAssistant.from_settings(settings, checkpointer=saver)
    except Exception as exc:
        await saver_context.__aexit__(type(exc), exc, exc.__traceback__)
        raise
    return assistant, saver_context


async def _close_assistant(
    assistant: AssistantLike, saver_context: SaverContext | None
) -> None:
    try:
        await assistant.aclose()
    finally:
        if saver_context is not None:
            await saver_context.__aexit__(None, None, None)


app = create_app()
