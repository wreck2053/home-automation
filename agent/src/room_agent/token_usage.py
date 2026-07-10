from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage


DEEPSEEK_V4_FLASH_CACHE_HIT_INPUT_COST_PER_1M = 0.0028
DEEPSEEK_V4_FLASH_CACHE_MISS_INPUT_COST_PER_1M = 0.14
DEEPSEEK_V4_FLASH_OUTPUT_COST_PER_1M = 0.28
DEEPSEEK_V4_PRO_CACHE_HIT_INPUT_COST_PER_1M = 0.003625
DEEPSEEK_V4_PRO_CACHE_MISS_INPUT_COST_PER_1M = 0.435
DEEPSEEK_V4_PRO_OUTPUT_COST_PER_1M = 0.87


def _pricing_for_model(model: str) -> tuple[str, float, float, float] | None:
    normalized = model.strip().lower()
    if normalized in {"deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"}:
        return (
            "DeepSeek V4 Flash",
            DEEPSEEK_V4_FLASH_CACHE_HIT_INPUT_COST_PER_1M,
            DEEPSEEK_V4_FLASH_CACHE_MISS_INPUT_COST_PER_1M,
            DEEPSEEK_V4_FLASH_OUTPUT_COST_PER_1M,
        )
    if normalized == "deepseek-v4-pro":
        return (
            "DeepSeek V4 Pro",
            DEEPSEEK_V4_PRO_CACHE_HIT_INPUT_COST_PER_1M,
            DEEPSEEK_V4_PRO_CACHE_MISS_INPUT_COST_PER_1M,
            DEEPSEEK_V4_PRO_OUTPUT_COST_PER_1M,
        )
    return None


def estimate_deepseek_v4_pro_cost(
    *,
    cache_hit_input_tokens: int,
    cache_miss_input_tokens: int,
    output_tokens: int,
) -> dict[str, float]:
    cache_hit_cost = (
        cache_hit_input_tokens * DEEPSEEK_V4_PRO_CACHE_HIT_INPUT_COST_PER_1M / 1_000_000
    )
    cache_miss_cost = (
        cache_miss_input_tokens
        * DEEPSEEK_V4_PRO_CACHE_MISS_INPUT_COST_PER_1M
        / 1_000_000
    )
    output_cost = output_tokens * DEEPSEEK_V4_PRO_OUTPUT_COST_PER_1M / 1_000_000
    input_cost = cache_hit_cost + cache_miss_cost
    return {
        "estimated_cache_hit_input_cost_usd": cache_hit_cost,
        "estimated_cache_miss_input_cost_usd": cache_miss_cost,
        "estimated_input_cost_usd": input_cost,
        "estimated_output_cost_usd": output_cost,
        "estimated_total_cost_usd": input_cost + output_cost,
    }


def estimate_deepseek_cost(
    *,
    model: str,
    cache_hit_input_tokens: int,
    cache_miss_input_tokens: int,
    output_tokens: int,
) -> dict[str, float | str | bool]:
    pricing = _pricing_for_model(model)
    if pricing is None:
        return {
            "pricing_model": model,
            "pricing_available": False,
            "estimated_cache_hit_input_cost_usd": 0.0,
            "estimated_cache_miss_input_cost_usd": 0.0,
            "estimated_input_cost_usd": 0.0,
            "estimated_output_cost_usd": 0.0,
            "estimated_total_cost_usd": 0.0,
        }

    pricing_model, cache_hit_rate, cache_miss_rate, output_rate = pricing
    cache_hit_cost = cache_hit_input_tokens * cache_hit_rate / 1_000_000
    cache_miss_cost = cache_miss_input_tokens * cache_miss_rate / 1_000_000
    output_cost = output_tokens * output_rate / 1_000_000
    return {
        "pricing_model": pricing_model,
        "pricing_available": True,
        "estimated_cache_hit_input_cost_usd": cache_hit_cost,
        "estimated_cache_miss_input_cost_usd": cache_miss_cost,
        "estimated_input_cost_usd": cache_hit_cost + cache_miss_cost,
        "estimated_output_cost_usd": output_cost,
        "estimated_total_cost_usd": cache_hit_cost + cache_miss_cost + output_cost,
    }


def extract_token_usage(
    message: AIMessage,
    *,
    model: str,
    call_index: int,
) -> dict[str, Any]:
    usage = _usage_dict(getattr(message, "usage_metadata", None))
    metadata = getattr(message, "response_metadata", {}) or {}
    if not usage:
        usage = _usage_dict(metadata.get("token_usage") or metadata.get("usage"))

    input_tokens = _int_from_keys(usage, "input_tokens", "prompt_tokens")
    output_tokens = _int_from_keys(usage, "output_tokens", "completion_tokens")
    total_tokens = _int_from_keys(usage, "total_tokens")
    if total_tokens == 0:
        total_tokens = input_tokens + output_tokens
    cache_hit_input_tokens = _cache_hit_tokens(usage)
    cache_miss_input_tokens = _cache_miss_tokens(usage)
    if cache_hit_input_tokens and not cache_miss_input_tokens:
        cache_miss_input_tokens = max(input_tokens - cache_hit_input_tokens, 0)
    elif cache_miss_input_tokens and not cache_hit_input_tokens:
        cache_hit_input_tokens = max(input_tokens - cache_miss_input_tokens, 0)
    elif not cache_hit_input_tokens and not cache_miss_input_tokens:
        cache_miss_input_tokens = input_tokens

    return {
        "call_index": call_index,
        "model": model,
        "has_usage": bool(usage),
        "input_tokens": input_tokens,
        "cache_hit_input_tokens": cache_hit_input_tokens,
        "cache_miss_input_tokens": cache_miss_input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        **estimate_deepseek_cost(
            model=model,
            cache_hit_input_tokens=cache_hit_input_tokens,
            cache_miss_input_tokens=cache_miss_input_tokens,
            output_tokens=output_tokens,
        ),
    }


def _usage_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def _int_from_keys(source: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = source.get(key)
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return 0


def _nested_int_from_keys(source: dict[str, Any], parent_key: str, *keys: str) -> int:
    nested = source.get(parent_key)
    if isinstance(nested, dict):
        return _int_from_keys(nested, *keys)
    return 0


def _cache_hit_tokens(usage: dict[str, Any]) -> int:
    return _int_from_keys(
        usage,
        "cache_hit_input_tokens",
        "input_cache_hit_tokens",
        "prompt_cache_hit_tokens",
        "cached_input_tokens",
        "cached_tokens",
    ) or _nested_int_from_keys(
        usage,
        "input_token_details",
        "cache_read",
        "cache_hit",
        "cached",
        "cached_tokens",
    )


def _cache_miss_tokens(usage: dict[str, Any]) -> int:
    return _int_from_keys(
        usage,
        "cache_miss_input_tokens",
        "input_cache_miss_tokens",
        "prompt_cache_miss_tokens",
        "uncached_input_tokens",
    ) or _nested_int_from_keys(
        usage,
        "input_token_details",
        "cache_miss",
        "uncached",
        "uncached_tokens",
    )
