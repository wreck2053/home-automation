# Local LangGraph Room Assistant

This is a local companion app for the ESP32 home automation controller. It runs
a LangGraph assistant that can chat normally and call room-control tools over
the ESP32 HTTP API.

## Setup

Use Python 3.11 or newer. From this `agent/` directory:

```sh
cp .env.example .env
uv sync --extra dev
```

Set `DEEPSEEK_API_KEY` in `.env`. Do not commit `.env`.

Conversation state is checkpointed to `data/checkpoints.sqlite3` by default.
Override `ROOM_AGENT_CHECKPOINT_DB` to use another local path.

## Run

```sh
uv run room-assistant ask "Alexa, it's too dark"
uv run room-assistant chat
uv run room-assistant serve
```

Both terminal commands print their LangGraph thread ID. Pass
`--thread <id>` on a later invocation to continue that checkpointed
conversation. Enabling AC turbo pauses the graph for explicit approval; other
device actions continue normally.

The web UI defaults to `http://127.0.0.1:8000`.

### Browser voice POC

Open the UI in Chrome on `localhost` (or another HTTPS origin) and press
**Enable voice** to grant microphone access. Voice mode uses Chrome's Tamil
speech recognition (`ta-IN`) and waits for **Deepy** before capturing a
command. The completed transcript is copied into the composer for review and
is never submitted automatically.

This POC listens only while the page is active. Chrome may use its remote
speech service, and the application does not retain raw microphone audio.

## Test

```sh
uv run pytest
npm install
npm test
```

The browser dependencies are pinned in `package.json` and copied into the
packaged static directory by `npm install`, so the local UI does not depend on
a CDN at runtime.
