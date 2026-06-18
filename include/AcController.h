#pragma once

#include "AppTypes.h"

namespace AcController {

struct Diagnostics {
  uint32_t executedCommands;
  uint32_t irTransmissions;
  uint32_t droppedCommands;
  uint32_t lastIrRaw;
  uint8_t queuedCommands;
};

void begin();
bool service();

bool setPower(bool power);
bool setMode(uint8_t mode);
bool setFanLevel(int fanLevel);
bool adjustFanLevel(int delta, int &absoluteFanLevel);
bool setTemperature(float temperature);
bool adjustTemperature(float delta, float &absoluteTemperature);
bool togglePreset();
bool setPresetPower(bool power);
bool requestPresetPower(bool power);
bool toggleSwing();
bool toggleLed();
bool toggleTurbo();

AcState getState();
Diagnostics getDiagnostics();
String thermostatModeName();

}  // namespace AcController
