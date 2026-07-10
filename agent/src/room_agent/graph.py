from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from typing import Annotated, Any, Literal, NotRequired, Protocol, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langchain_openai import ChatOpenAI
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph, add_messages
from langgraph.prebuilt import ToolNode

from .config import Settings
from .device import RoomDeviceClient
from .events import event, event_dict, new_run_id, redact_payload
from .schemas import ChatHistoryMessage, EventPhase, LifecycleEvent
from .system_prompt import SYSTEM_PROMPT
from .token_usage import extract_token_usage
from .tools import create_room_tools


class ToolBindableModel(Protocol):
    def bind_tools(self, tools: Sequence[BaseTool]) -> Any:
        ...


class RoomAgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    run_id: str
    turn_id: str
    device_state: NotRequired[dict[str, Any] | None]
    device_error: NotRequired[str | None]


def build_deepseek_model(settings: Settings) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.deepseek_model,
        api_key=settings.deepseek_api_key_value,
        base_url=settings.deepseek_base_url_value,
        temperature=0.2,
        streaming=True,
        stream_usage=True,
        max_completion_tokens=settings.deepseek_max_output_tokens,
    )


class RoomAssistant:
    def __init__(
        self,
        *,
        device_client: RoomDeviceClient,
        model: ToolBindableModel,
        model_name: str = "unknown",
        tools: list[BaseTool] | None = None,
    ) -> None:
        self.device_client = device_client
        self.tools = tools or create_room_tools(device_client)
        self.model = model
        self.model_name = model_name
        self.model_with_tools = model.bind_tools(self.tools)
        self.graph = self._build_graph()
        self.workflow_summary = (
            "START -> load_state -> model -> tools? -> "
            "load_state_after_tools -> model/final"
        )
        self.workflow_mermaid = self.graph.get_graph(xray=True).draw_mermaid()

    @classmethod
    def from_settings(cls, settings: Settings) -> "RoomAssistant":
        device_client = RoomDeviceClient(
            base_url=settings.room_device_base_url_value,
            timeout_seconds=settings.room_http_timeout_seconds,
        )
        return cls(
            device_client=device_client,
            model=build_deepseek_model(settings),
            model_name=settings.deepseek_model,
        )

    async def aclose(self) -> None:
        await self.device_client.aclose()

    async def run(
        self, prompt: str, history: Sequence[ChatHistoryMessage] | None = None
    ) -> AsyncIterator[LifecycleEvent]:
        run_id = new_run_id()
        turn_id = new_run_id()[:10]
        final_message = ""
        model_call_count = 0
        messages = self._messages_from_history(history or [])
        messages.append(HumanMessage(content=prompt))

        yield event(
            run_id=run_id,
            turn_id=turn_id,
            phase=EventPhase.phase_start,
            heading="User Prompt",
            message=prompt,
            color="#5ef1ff",
            payload={"prompt": prompt},
        )
        yield event(
            run_id=run_id,
            turn_id=turn_id,
            phase=EventPhase.phase_start,
            heading="Graph Built",
            message=self.workflow_summary,
            payload={"node": "graph", "mermaid": self.workflow_mermaid},
        )

        try:
            async for chunk in self.graph.astream(
                {
                    "messages": messages,
                    "run_id": run_id,
                    "turn_id": turn_id,
                },
                stream_mode=["updates", "messages", "custom"],
                version="v2",
            ):
                chunk_type = chunk["type"]
                if chunk_type == "custom":
                    yield LifecycleEvent.model_validate(chunk["data"])
                elif chunk_type == "messages":
                    token_event = self._token_event(chunk, run_id, turn_id)
                    if token_event is not None:
                        yield token_event
                elif chunk_type == "updates":
                    update_events, model_call_count = self._events_from_update(
                        chunk["data"], run_id, turn_id, model_call_count
                    )
                    for update_event, maybe_final in update_events:
                        if maybe_final:
                            final_message = maybe_final
                        yield update_event
        except Exception as exc:
            yield event(
                run_id=run_id,
                turn_id=turn_id,
                phase=EventPhase.error,
                heading="Agent Error",
                message=str(exc),
                payload={"error_type": type(exc).__name__},
            )
            return

        if final_message:
            yield event(
                run_id=run_id,
                turn_id=turn_id,
                phase=EventPhase.final,
                heading="Final Output",
                message=final_message,
                payload={"content": final_message},
            )

    def _build_graph(self) -> Any:
        builder = StateGraph(RoomAgentState)
        builder.add_node("load_state", self._load_state)
        builder.add_node("model", self._call_model)
        builder.add_node("tools", ToolNode(self.tools))
        builder.add_node("load_state_after_tools", self._load_state_after_tools)
        builder.add_edge(START, "load_state")
        builder.add_edge("load_state", "model")
        builder.add_conditional_edges("model", self._should_continue, ["tools", END])
        builder.add_edge("tools", "load_state_after_tools")
        builder.add_edge("load_state_after_tools", "model")
        return builder.compile()

    def _messages_from_history(
        self, history: Sequence[ChatHistoryMessage]
    ) -> list[BaseMessage]:
        messages: list[BaseMessage] = []
        for item in history[-20:]:
            if item.role == "user":
                messages.append(HumanMessage(content=item.content))
            elif item.role == "assistant":
                messages.append(AIMessage(content=item.content))
        return messages

    async def _load_state(self, state: RoomAgentState) -> dict[str, Any]:
        return await self._load_state_for_node(state, "load_state", "Load State")

    async def _load_state_after_tools(self, state: RoomAgentState) -> dict[str, Any]:
        return await self._load_state_for_node(
            state, "load_state_after_tools", "Refresh State After Tools"
        )

    async def _load_state_for_node(
        self, state: RoomAgentState, node: str, heading: str
    ) -> dict[str, Any]:
        self._write(
            state,
            EventPhase.phase_start,
            heading,
            f"Entering `{node}`",
            {"node": node},
        )
        try:
            room_state = await self.device_client.get_state()
            payload = room_state.model_dump(mode="json")
            self._write(
                state,
                EventPhase.state_snapshot,
                "State Snapshot",
                "Current ESP32 room state loaded",
                {"node": node, "state": payload},
            )
            return {"device_state": payload, "device_error": None}
        except Exception as exc:
            self._write(
                state,
                EventPhase.error,
                "State Load Failed",
                str(exc),
                {"node": node, "error_type": type(exc).__name__},
            )
            return {"device_state": None, "device_error": str(exc)}

    async def _call_model(self, state: RoomAgentState) -> dict[str, list[BaseMessage]]:
        self._write(
            state,
            EventPhase.phase_start,
            "Model Node",
            "Entering `model`",
            {"node": "model"},
        )
        self._write(
            state,
            EventPhase.model_start,
            "Model Call",
            "Calling DeepSeek with room tools bound",
            {
                "node": "model",
                "message_count": len(state["messages"]),
                "device_state": state.get("device_state"),
            },
        )
        response = await self.model_with_tools.ainvoke(
            [SystemMessage(content=self._system_message(state)), *state["messages"]]
        )
        return {"messages": [response]}

    def _should_continue(self, state: RoomAgentState) -> Literal["tools", "__end__"]:
        last_message = state["messages"][-1]
        if isinstance(last_message, AIMessage) and last_message.tool_calls:
            return "tools"
        return END

    def _system_message(self, state: RoomAgentState) -> str:
        device_state = state.get("device_state")
        state_json = json.dumps(device_state, indent=2, sort_keys=True)
        if device_state is None:
            state_json = f"Unavailable: {state.get('device_error') or 'unknown error'}"
        return f"{SYSTEM_PROMPT}\n\nCurrent room state:\n{state_json}"

    def _write(
        self,
        state: RoomAgentState,
        phase: EventPhase,
        heading: str,
        message: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        writer = get_stream_writer()
        writer(
            event_dict(
                run_id=state["run_id"],
                turn_id=state["turn_id"],
                phase=phase,
                heading=heading,
                message=message,
                payload=payload,
            )
        )

    def _token_event(
        self, chunk: dict[str, Any], run_id: str, turn_id: str
    ) -> LifecycleEvent | None:
        message_chunk, metadata = chunk["data"]
        if metadata.get("langgraph_node") != "model":
            return None
        content = self._message_text(message_chunk)
        if not content:
            return None
        return event(
            run_id=run_id,
            turn_id=turn_id,
            phase=EventPhase.model_token,
            heading="Model Token",
            message=content,
            payload={"node": "model"},
        )

    def _events_from_update(
        self,
        update_data: dict[str, Any],
        run_id: str,
        turn_id: str,
        model_call_count: int,
    ) -> tuple[list[tuple[LifecycleEvent, str | None]], int]:
        events: list[tuple[LifecycleEvent, str | None]] = []
        for node_name, update in update_data.items():
            if not isinstance(update, dict):
                continue
            for message in update.get("messages", []):
                if isinstance(message, AIMessage) and message.tool_calls:
                    model_call_count += 1
                    content = self._message_text(message)
                    if content:
                        events.append(
                            (
                                event(
                                    run_id=run_id,
                                    turn_id=turn_id,
                                    phase=EventPhase.model_intermediate,
                                    heading="Intermediate Model Output",
                                    message=content,
                                    payload={
                                        "node": node_name,
                                        "call_index": model_call_count,
                                        "tool_call_count": len(message.tool_calls),
                                    },
                                ),
                                None,
                            )
                        )
                    for tool_call in message.tool_calls:
                        events.append(
                            (
                                event(
                                    run_id=run_id,
                                    turn_id=turn_id,
                                    phase=EventPhase.tool_call,
                                    heading="Tool Call",
                                    message=f"{tool_call['name']}({tool_call.get('args', {})})",
                                    payload={
                                        "node": node_name,
                                        "tool_call": redact_payload(tool_call),
                                    },
                                ),
                                None,
                            )
                        )
                    events.append(
                        self._token_usage_event(
                            message, run_id, turn_id, node_name, model_call_count
                        )
                    )
                elif isinstance(message, ToolMessage):
                    parsed = self._parse_tool_content(message.content)
                    events.append(
                        (
                            event(
                                run_id=run_id,
                                turn_id=turn_id,
                                phase=EventPhase.tool_result,
                                heading="Tool Result",
                                message=self._tool_result_message(parsed),
                                payload={
                                    "node": node_name,
                                    "tool_call_id": message.tool_call_id,
                                    "result": parsed,
                                },
                            ),
                            None,
                        )
                    )
                elif isinstance(message, AIMessage) and not message.tool_calls:
                    model_call_count += 1
                    content = self._message_text(message)
                    if content:
                        events.append(
                            (
                                event(
                                    run_id=run_id,
                                    turn_id=turn_id,
                                    phase=EventPhase.model_start,
                                    heading="Model Response",
                                    message=content,
                                    payload={"node": node_name},
                                ),
                                content,
                            )
                        )
                    events.append(
                        self._token_usage_event(
                            message, run_id, turn_id, node_name, model_call_count
                        )
                    )
        return events, model_call_count

    def _token_usage_event(
        self,
        message: AIMessage,
        run_id: str,
        turn_id: str,
        node_name: str,
        call_index: int,
    ) -> tuple[LifecycleEvent, str | None]:
        usage = extract_token_usage(
            message,
            model=self.model_name,
            call_index=call_index,
        )
        return (
            event(
                run_id=run_id,
                turn_id=turn_id,
                phase=EventPhase.token_usage,
                heading=f"Token Usage #{call_index}",
                message=(
                    f"cache hit {usage['cache_hit_input_tokens']} / cache miss "
                    f"{usage['cache_miss_input_tokens']} / output "
                    f"{usage['output_tokens']} / total {usage['total_tokens']}"
                ),
                payload={"node": node_name, **usage},
            ),
            None,
        )

    def _parse_tool_content(self, content: Any) -> Any:
        if not isinstance(content, str):
            return content
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return content

    def _tool_result_message(self, parsed: Any) -> str:
        if isinstance(parsed, dict):
            message = parsed.get("message")
            success = parsed.get("success")
            if isinstance(message, str):
                return f"{'OK' if success else 'FAILED'}: {message}"
        return str(parsed)

    def _message_text(self, message: Any) -> str:
        content = getattr(message, "content", message)
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            return "".join(parts)
        return ""
