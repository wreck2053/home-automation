#pragma once

#include "AppTypes.h"

namespace AcController {

enum class CommandType : uint8_t {
  None,
  SetPower,
  SetNormalState,
  SetPresetPower,
  ToggleSwing,
  ToggleLed,
  ToggleTurbo,
};

struct Diagnostics {
  uint32_t executedCommands;
  uint32_t irTransmissions;
  uint32_t droppedCommands;
  uint32_t lastIrRaw;
  uint8_t queuedCommands;
  uint8_t queueHighWaterMark;
  bool workerRunning;
  CommandType lastCommand;
};

void begin();

bool setPower(bool power);
bool setMode(uint8_t mode);
bool setFanLevel(int fanLevel);
bool adjustFanLevel(int delta, int &absoluteFanLevel);
bool setTemperature(float temperature);
bool adjustTemperature(float delta, float &absoluteTemperature);
bool togglePreset();
bool setPresetPower(bool power);
bool toggleSwing();
bool toggleLed();
bool toggleTurbo();

AcState getState();
Diagnostics getDiagnostics();
const char *commandTypeName(CommandType type);
String thermostatModeName();

}  // namespace AcController
