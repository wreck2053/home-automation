from __future__ import annotations

from langchain_core.messages import AIMessage

from room_agent.token_usage import extract_token_usage


def test_extract_token_usage_from_usage_metadata() -> None:
    message = AIMessage(
        content="hello",
        usage_metadata={
            "input_tokens": 1000,
            "output_tokens": 500,
            "total_tokens": 1500,
        },
    )

    usage = extract_token_usage(message, model="deepseek-v4-pro", call_index=2)

    assert usage["call_index"] == 2
    assert usage["model"] == "deepseek-v4-pro"
    assert usage["has_usage"] is True
    assert usage["input_tokens"] == 1000
    assert usage["cache_hit_input_tokens"] == 0
    assert usage["cache_miss_input_tokens"] == 1000
    assert usage["output_tokens"] == 500
    assert usage["total_tokens"] == 1500
    assert usage["estimated_total_cost_usd"] == (1000 * 0.435 + 500 * 0.87) / 1_000_000


def test_extract_token_usage_splits_cache_hit_and_miss() -> None:
    message = AIMessage(
        content="hello",
        usage_metadata={
            "input_tokens": 1000,
            "output_tokens": 200,
            "total_tokens": 1200,
            "input_token_details": {"cache_read": 650},
        },
    )

    usage = extract_token_usage(message, model="deepseek-v4-pro", call_index=1)

    assert usage["cache_hit_input_tokens"] == 650
    assert usage["cache_miss_input_tokens"] == 350
    assert usage["estimated_cache_hit_input_cost_usd"] == 650 * 0.003625 / 1_000_000
    assert usage["estimated_cache_miss_input_cost_usd"] == 350 * 0.435 / 1_000_000
    assert usage["estimated_output_cost_usd"] == 200 * 0.87 / 1_000_000


def test_extract_token_usage_uses_flash_pricing_for_flash_model() -> None:
    message = AIMessage(
        content="hello",
        usage_metadata={
            "input_tokens": 1000,
            "output_tokens": 200,
            "total_tokens": 1200,
            "input_token_details": {"cache_read": 650},
        },
    )

    usage = extract_token_usage(message, model="deepseek-v4-flash", call_index=1)

    assert usage["pricing_model"] == "DeepSeek V4 Flash"
    assert usage["estimated_cache_hit_input_cost_usd"] == 650 * 0.0028 / 1_000_000
    assert usage["estimated_cache_miss_input_cost_usd"] == 350 * 0.14 / 1_000_000
    assert usage["estimated_output_cost_usd"] == 200 * 0.28 / 1_000_000


def test_extract_token_usage_from_response_metadata_fallback() -> None:
    message = AIMessage(
        content="hello",
        response_metadata={
            "token_usage": {
                "prompt_tokens": 12,
                "completion_tokens": 8,
                "total_tokens": 20,
                "prompt_cache_hit_tokens": 5,
                "prompt_cache_miss_tokens": 7,
            }
        },
    )

    usage = extract_token_usage(message, model="deepseek-v4-pro", call_index=1)

    assert usage["has_usage"] is True
    assert usage["input_tokens"] == 12
    assert usage["cache_hit_input_tokens"] == 5
    assert usage["cache_miss_input_tokens"] == 7
    assert usage["output_tokens"] == 8
    assert usage["total_tokens"] == 20


def test_extract_token_usage_missing_metadata_returns_zeroes() -> None:
    message = AIMessage(content="hello")

    usage = extract_token_usage(message, model="deepseek-v4-pro", call_index=1)

    assert usage["has_usage"] is False
    assert usage["input_tokens"] == 0
    assert usage["output_tokens"] == 0
    assert usage["total_tokens"] == 0
