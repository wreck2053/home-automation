#include "RelayController.h"

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include "AppConfig.h"

namespace RelayController {
namespace {

RelayState relayStates[] = {
    {"Light", AppConfig::Sinric::kLightSwitchId, AppConfig::Pins::kLight, false,
     HIGH, HIGH, 0},
    {"Fan", AppConfig::Sinric::kFanSwitchId, AppConfig::Pins::kFan, false, HIGH,
     HIGH, 0},
};
SemaphoreHandle_t stateMutex = nullptr;

class LockGuard {
 public:
  explicit LockGuard(SemaphoreHandle_t mutex) : mutex_(mutex), locked_(false) {
    if (mutex_ != nullptr) {
      locked_ = xSemaphoreTake(mutex_, portMAX_DELAY) == pdTRUE;
    }
  }

  ~LockGuard() {
    if (locked_) {
      xSemaphoreGive(mutex_);
    }
  }

 private:
  SemaphoreHandle_t mutex_;
  bool locked_;
};

RelayState &relayFromId(RelayId relayId) {
  return relayStates[static_cast<size_t>(relayId)];
}

bool switchReadingMeansOn(const int reading) { return reading == LOW; }

void writeRelayLocked(const RelayState &relay) {
  const bool outputLevel =
      relay.pins.relayActiveLow ? !relay.power : relay.power;
  digitalWrite(relay.pins.relayPin, outputLevel ? HIGH : LOW);
}

}  // namespace

void begin() {
  if (stateMutex == nullptr) {
    stateMutex = xSemaphoreCreateMutex();
  }

  LockGuard lock(stateMutex);
  for (RelayState &relay : relayStates) {
    pinMode(relay.pins.relayPin, OUTPUT);
    pinMode(relay.pins.switchPin, INPUT_PULLUP);

    relay.lastReading = digitalRead(relay.pins.switchPin);
    relay.stableReading = relay.lastReading;
    relay.lastDebounceAt = millis();
    relay.power = switchReadingMeansOn(relay.stableReading);

    writeRelayLocked(relay);
  }
}

uint8_t service() {
  const unsigned long now = millis();
  uint8_t changeMask = kRelayChangeNone;
  LockGuard lock(stateMutex);

  for (size_t index = 0; index < (sizeof(relayStates) / sizeof(relayStates[0]));
       ++index) {
    RelayState &relay = relayStates[index];
    const int reading = digitalRead(relay.pins.switchPin);

    if (reading != relay.lastReading) {
      relay.lastReading = reading;
      relay.lastDebounceAt = now;
    }

    const bool debounced =
        (now - relay.lastDebounceAt) >= AppConfig::Timing::kSwitchDebounceMs;
    if (!debounced || reading == relay.stableReading) {
      continue;
    }

    relay.stableReading = reading;
    const bool desiredPower = switchReadingMeansOn(relay.stableReading);
    if (relay.power != desiredPower) {
      relay.power = desiredPower;
      writeRelayLocked(relay);
      changeMask |= relayChangeBit(static_cast<RelayId>(index));
      Serial.printf("%s set from physical switch: %s\r\n", relay.name,
                    relay.power ? "on" : "off");
    }
  }

  return changeMask;
}

bool setPower(RelayId relayId, bool power, ControlSource source) {
  bool changed = false;
  const char *relayName = nullptr;

  {
    LockGuard lock(stateMutex);
    RelayState &relay = relayFromId(relayId);
    relayName = relay.name;
    if (relay.power == power) {
      return false;
    }

    relay.power = power;
    writeRelayLocked(relay);
    changed = true;
  }

  if (changed && source != ControlSource::PhysicalSwitch) {
    Serial.printf("%s set to %s\r\n", relayName, power ? "on" : "off");
  }

  return changed;
}

bool toggle(RelayId relayId, ControlSource source) {
  bool changed = false;
  bool power = false;
  const char *relayName = nullptr;

  {
    LockGuard lock(stateMutex);
    RelayState &relay = relayFromId(relayId);
    relayName = relay.name;
    relay.power = !relay.power;
    power = relay.power;
    writeRelayLocked(relay);
    changed = true;
  }

  if (changed && source != ControlSource::PhysicalSwitch) {
    Serial.printf("%s set to %s\r\n", relayName, power ? "on" : "off");
  }

  return changed;
}

bool getPower(RelayId relayId) {
  LockGuard lock(stateMutex);
  return relayFromId(relayId).power;
}

RelayState getState(RelayId relayId) {
  LockGuard lock(stateMutex);
  return relayFromId(relayId);
}

}  // namespace RelayController
