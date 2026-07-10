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

## Run

```sh
uv run room-assistant ask "Alexa, it's too dark"
uv run room-assistant chat
uv run room-assistant serve
```

The web UI defaults to `http://127.0.0.1:8000`.

## Test

```sh
uv run pytest
npm install
npm test
```

The browser dependencies are pinned in `package.json` and copied into the
packaged static directory by `npm install`, so the local UI does not depend on
a CDN at runtime.
