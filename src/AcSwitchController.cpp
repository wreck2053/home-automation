#include "AcSwitchController.h"

#include <Arduino.h>

#include "AcController.h"
#include "AppConfig.h"

namespace AcSwitchController {
namespace {

int lastReading = HIGH;
int stableReading = HIGH;
unsigned long lastDebounceAt = 0;

bool readingMeansOn(const int reading) { return reading == LOW; }

bool applySwitchPosition(const int reading) {
  const bool power = readingMeansOn(reading);
  if (!AcController::setPresetPower(power)) {
    return false;
  }

  Serial.printf("AC set from physical switch: %s\r\n",
                power ? "on (preset)" : "off");
  return true;
}

}  // namespace

bool begin() {
  pinMode(AppConfig::Pins::kAcSwitch, INPUT_PULLUP);
  lastReading = digitalRead(AppConfig::Pins::kAcSwitch);
  stableReading = lastReading;
  lastDebounceAt = millis();
  return applySwitchPosition(stableReading);
}

bool service() {
  const unsigned long now = millis();
  const int reading = digitalRead(AppConfig::Pins::kAcSwitch);

  if (reading != lastReading) {
    lastReading = reading;
    lastDebounceAt = now;
  }

  const bool debounced =
      (now - lastDebounceAt) >= AppConfig::Timing::kSwitchDebounceMs;
  if (!debounced || reading == stableReading) {
    return false;
  }

  stableReading = reading;
  return applySwitchPosition(stableReading);
}

}  // namespace AcSwitchController
