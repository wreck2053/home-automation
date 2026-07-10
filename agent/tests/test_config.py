from __future__ import annotations

import pytest
from pydantic import ValidationError

from room_agent.config import Settings
from room_agent.events import redact_payload


def test_settings_accepts_valid_urls_and_redacts_key() -> None:
    settings = Settings(
        DEEPSEEK_API_KEY="secret-value",
        ROOM_DEVICE_BASE_URL="http://192.168.0.108",
    )

    assert settings.has_deepseek_api_key is True
    assert settings.deepseek_api_key_value == "secret-value"
    assert settings.safe_summary()["deepseek_api_key"] == "***"


def test_settings_rejects_invalid_device_url() -> None:
    with pytest.raises(ValidationError):
        Settings(DEEPSEEK_API_KEY="x", ROOM_DEVICE_BASE_URL="not-a-url")


def test_missing_key_is_reported_cleanly() -> None:
    settings = Settings(DEEPSEEK_API_KEY=None)

    assert settings.has_deepseek_api_key is False
    with pytest.raises(RuntimeError, match="DEEPSEEK_API_KEY"):
        _ = settings.deepseek_api_key_value


def test_redact_payload_removes_nested_secrets() -> None:
    payload = {
        "headers": {"authorization": "Bearer x"},
        "deepseek_api_key": "x",
        "nested": [{"password": "p"}, {"safe": "ok"}],
    }

    assert redact_payload(payload) == {
        "headers": {"authorization": "***"},
        "deepseek_api_key": "***",
        "nested": [{"password": "***"}, {"safe": "ok"}],
    }
