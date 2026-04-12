#pragma once

#include <Arduino.h>

enum class RelayId : uint8_t { Light = 0, Fan = 1 };

enum class ControlSource : uint8_t {
  PhysicalSwitch,
  Http,
  Cloud,
};

enum class CloudConnectionState : uint8_t {
  WiFiDisconnected,
  WiFiConnecting,
  InternetUnavailable,
  CloudConnecting,
  CloudConnected,
};

constexpr uint8_t kRelayChangeNone = 0;
constexpr uint8_t kRelayChangeLight = 1U << 0;
constexpr uint8_t kRelayChangeFan = 1U << 1;

constexpr uint8_t relayChangeBit(const RelayId relayId) {
  return static_cast<uint8_t>(1U << static_cast<uint8_t>(relayId));
}

struct DevicePins {
  uint8_t relayPin;
  uint8_t switchPin;
  bool relayActiveLow;
};

struct RelayState {
  const char *name;
  const char *deviceId;
  DevicePins pins;
  bool power;
  int lastReading;
  int stableReading;
  unsigned long lastDebounceAt;
};

struct AcState {
  bool power;
  uint8_t mode;
  uint8_t temperature;
  int fanLevel;
  bool swing;
  bool led;
  bool turbo;
};
