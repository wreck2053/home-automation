#pragma once

#include "AppTypes.h"

namespace AcController {

void begin();

bool setPower(bool power);
bool setMode(uint8_t mode);
bool setFanLevel(int fanLevel);
bool adjustFanLevel(int delta, int &absoluteFanLevel);
bool setTemperature(float temperature);
bool adjustTemperature(float delta, float &absoluteTemperature);
bool setPreset();
bool toggleSwing();
bool toggleLed();
bool toggleTurbo();

AcState getState();
String thermostatModeName();

}  // namespace AcController
