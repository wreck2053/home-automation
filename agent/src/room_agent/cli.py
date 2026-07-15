from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import AsyncIterator

import uvicorn
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from rich.console import Console

from .config import load_settings
from .console import RichLifecyclePrinter
from .graph import RoomAssistant
from .events import new_run_id
from .schemas import EventPhase, LifecycleEvent


async def _drive_with_approval(
    assistant: RoomAssistant,
    stream: AsyncIterator[LifecycleEvent],
    thread_id: str,
    console: Console,
    printer: RichLifecyclePrinter,
) -> str:
    final_message = ""
    while True:
        approval_required = False
        async for lifecycle_event in stream:
            printer.print_event(lifecycle_event)
            if lifecycle_event.phase == EventPhase.approval_required:
                approval_required = True
            elif lifecycle_event.phase == EventPhase.final:
                final_message = lifecycle_event.message
        if not approval_required:
            return final_message
        try:
            answer = console.input("[bold bright_yellow]Activate AC turbo? [y/N] [/]").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[yellow]Turbo activation denied.[/]")
            answer = "no"
        approved = answer.lower() in {"y", "yes"}
        stream = assistant.resume(thread_id, approved)


async def run_prompt(prompt: str, thread_id: str | None = None) -> int:
    console = Console()
    settings = load_settings()
    if not settings.has_deepseek_api_key:
        console.print("[bright_red]DEEPSEEK_API_KEY is required for chat requests.[/]")
        return 2

    thread_id = thread_id or new_run_id()
    console.print(f"[dim]LangGraph thread: {thread_id}[/]")
    settings.checkpoint_db_path.parent.mkdir(parents=True, exist_ok=True)
    async with AsyncSqliteSaver.from_conn_string(str(settings.checkpoint_db_path)) as saver:
        assistant = RoomAssistant.from_settings(settings, checkpointer=saver)
        printer = RichLifecyclePrinter(console)
        try:
            await _drive_with_approval(
                assistant,
                assistant.run(prompt, thread_id=thread_id),
                thread_id,
                console,
                printer,
            )
        finally:
            await assistant.aclose()
    return 0


async def run_chat(thread_id: str | None = None) -> int:
    console = Console()
    settings = load_settings()
    if not settings.has_deepseek_api_key:
        console.print("[bright_red]DEEPSEEK_API_KEY is required for chat requests.[/]")
        return 2

    thread_id = thread_id or new_run_id()
    console.print(f"[dim]LangGraph thread: {thread_id}[/]")
    settings.checkpoint_db_path.parent.mkdir(parents=True, exist_ok=True)
    async with AsyncSqliteSaver.from_conn_string(str(settings.checkpoint_db_path)) as saver:
        assistant = RoomAssistant.from_settings(settings, checkpointer=saver)
        printer = RichLifecyclePrinter(console)
        console.print("[bright_cyan]Room assistant chat. Press Ctrl-D or Ctrl-C to exit.[/]")
        try:
            while True:
                try:
                    prompt = console.input("[bold bright_cyan]you> [/]").strip()
                except (EOFError, KeyboardInterrupt):
                    console.print()
                    return 0
                if not prompt:
                    continue
                await _drive_with_approval(
                    assistant,
                    assistant.run(prompt, thread_id=thread_id),
                    thread_id,
                    console,
                    printer,
                )
        finally:
            await assistant.aclose()


def serve(host: str, port: int, reload: bool) -> int:
    uvicorn.run("room_agent.web:app", host=host, port=port, reload=reload)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="room-assistant")
    subparsers = parser.add_subparsers(dest="command", required=True)

    ask = subparsers.add_parser("ask", help="Send one prompt to the assistant.")
    ask.add_argument("prompt", help="Prompt to send.")
    ask.add_argument("--thread", help="Persistent LangGraph thread ID.")

    chat = subparsers.add_parser("chat", help="Start an interactive terminal chat.")
    chat.add_argument("--thread", help="Persistent LangGraph thread ID.")

    serve_parser = subparsers.add_parser("serve", help="Run the local web UI.")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", default=8000, type=int)
    serve_parser.add_argument("--reload", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "ask":
        return asyncio.run(run_prompt(args.prompt, args.thread))
    if args.command == "chat":
        return asyncio.run(run_chat(args.thread))
    if args.command == "serve":
        return serve(args.host, args.port, args.reload)
    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
