from __future__ import annotations

import json

from rich.console import Console, Group
from rich.json import JSON
from rich.panel import Panel
from rich.text import Text

from .events import TERMINAL_COLORS
from .schemas import EventPhase, LifecycleEvent


class RichLifecyclePrinter:
    def __init__(self, console: Console | None = None) -> None:
        self.console = console or Console()
        self._streaming_tokens = False

    def print_event(self, lifecycle_event: LifecycleEvent) -> None:
        if lifecycle_event.phase == EventPhase.model_token:
            self._streaming_tokens = True
            self.console.print(
                lifecycle_event.message,
                style=TERMINAL_COLORS[EventPhase.model_token],
                end="",
                soft_wrap=True,
            )
            return

        if self._streaming_tokens:
            self.console.print()
            self._streaming_tokens = False

        style = self._style_for(lifecycle_event)
        body: list[object] = [Text(lifecycle_event.message, style=style)]
        if lifecycle_event.payload:
            body.append(JSON(json.dumps(lifecycle_event.payload, default=str)))

        self.console.print(
            Panel(
                Group(*body),
                title=lifecycle_event.heading,
                border_style=style,
                expand=False,
            )
        )

    def _style_for(self, lifecycle_event: LifecycleEvent) -> str:
        if lifecycle_event.heading == "User Prompt":
            return "bright_cyan"
        if lifecycle_event.phase == EventPhase.final:
            return "spring_green1"
        return TERMINAL_COLORS[lifecycle_event.phase]
