from __future__ import annotations

from pathlib import Path

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


AGENT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    deepseek_api_key: SecretStr | None = Field(default=None, alias="DEEPSEEK_API_KEY")
    deepseek_model: str = Field(default="deepseek-v4-pro", alias="DEEPSEEK_MODEL")
    deepseek_base_url: AnyHttpUrl = Field(
        default="https://api.deepseek.com", alias="DEEPSEEK_BASE_URL"
    )
    room_device_base_url: AnyHttpUrl = Field(
        default="http://192.168.0.108", alias="ROOM_DEVICE_BASE_URL"
    )
    room_http_timeout_seconds: float = Field(
        default=5.0, gt=0, alias="ROOM_HTTP_TIMEOUT_SECONDS"
    )
    checkpoint_db: Path = Field(
        default=Path("data/checkpoints.sqlite3"), alias="ROOM_AGENT_CHECKPOINT_DB"
    )
    deepseek_max_output_tokens: int = Field(
        default=500, gt=0, le=4096, alias="DEEPSEEK_MAX_OUTPUT_TOKENS"
    )

    model_config = SettingsConfigDict(
        env_file=str(AGENT_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    @field_validator("deepseek_model")
    @classmethod
    def validate_deepseek_model(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("DEEPSEEK_MODEL cannot be empty")
        return stripped

    @property
    def deepseek_api_key_value(self) -> str:
        if self.deepseek_api_key is None:
            raise RuntimeError("DEEPSEEK_API_KEY is required for chat requests")
        value = self.deepseek_api_key.get_secret_value().strip()
        if not value:
            raise RuntimeError("DEEPSEEK_API_KEY is required for chat requests")
        return value

    @property
    def deepseek_base_url_value(self) -> str:
        return str(self.deepseek_base_url).rstrip("/")

    @property
    def room_device_base_url_value(self) -> str:
        return str(self.room_device_base_url).rstrip("/")

    @property
    def has_deepseek_api_key(self) -> bool:
        if self.deepseek_api_key is None:
            return False
        return bool(self.deepseek_api_key.get_secret_value().strip())

    @property
    def checkpoint_db_path(self) -> Path:
        path = self.checkpoint_db.expanduser()
        return path if path.is_absolute() else AGENT_ROOT / path

    def safe_summary(self) -> dict[str, object]:
        return {
            "deepseek_api_key": "***" if self.has_deepseek_api_key else None,
            "deepseek_model": self.deepseek_model,
            "deepseek_base_url": self.deepseek_base_url_value,
            "room_device_base_url": self.room_device_base_url_value,
            "room_http_timeout_seconds": self.room_http_timeout_seconds,
            "deepseek_max_output_tokens": self.deepseek_max_output_tokens,
            "checkpoint_db": str(self.checkpoint_db_path),
        }


def load_settings() -> Settings:
    return Settings()
