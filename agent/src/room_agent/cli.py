from __future__ import annotations

import argparse
import asyncio
import sys

import uvicorn
from rich.console import Console

from .config import load_settings
from .console import RichLifecyclePrinter
from .graph import RoomAssistant
from .schemas import ChatHistoryMessage


async def run_prompt(prompt: str) -> int:
    console = Console()
    settings = load_settings()
    if not settings.has_deepseek_api_key:
        console.print("[bright_red]DEEPSEEK_API_KEY is required for chat requests.[/]")
        return 2

    assistant = RoomAssistant.from_settings(settings)
    printer = RichLifecyclePrinter(console)
    try:
        async for lifecycle_event in assistant.run(prompt):
            printer.print_event(lifecycle_event)
    finally:
        await assistant.aclose()
    return 0


async def run_chat() -> int:
    console = Console()
    settings = load_settings()
    if not settings.has_deepseek_api_key:
        console.print("[bright_red]DEEPSEEK_API_KEY is required for chat requests.[/]")
        return 2

    assistant = RoomAssistant.from_settings(settings)
    printer = RichLifecyclePrinter(console)
    history: list[ChatHistoryMessage] = []
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
            final_message = ""
            async for lifecycle_event in assistant.run(prompt, history=history):
                printer.print_event(lifecycle_event)
                if lifecycle_event.phase.value == "final":
                    final_message = lifecycle_event.message
            history.append(ChatHistoryMessage(role="user", content=prompt))
            if final_message:
                history.append(
                    ChatHistoryMessage(role="assistant", content=final_message)
                )
            history = history[-20:]
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

    subparsers.add_parser("chat", help="Start an interactive terminal chat.")

    serve_parser = subparsers.add_parser("serve", help="Run the local web UI.")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", default=8000, type=int)
    serve_parser.add_argument("--reload", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "ask":
        return asyncio.run(run_prompt(args.prompt))
    if args.command == "chat":
        return asyncio.run(run_chat())
    if args.command == "serve":
        return serve(args.host, args.port, args.reload)
    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
