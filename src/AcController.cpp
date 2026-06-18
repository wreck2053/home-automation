#include "AcController.h"

#include <Arduino.h>
#include <IRsend.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <ir_Coolix.h>

#include "AppConfig.h"

namespace AcController {
namespace {

constexpr UBaseType_t kCommandQueueDepth = 16;

enum class CommandType : uint8_t {
  SetPower,
  SetNormalState,
  SetPresetPower,
  ToggleSwing,
  ToggleLed,
  ToggleTurbo,
};

struct Command {
  CommandType type;
  AcState state;
};

IRCoolixAC ac(AppConfig::Pins::kIrTransmitter);
SemaphoreHandle_t stateMutex = nullptr;
QueueHandle_t commandQueue = nullptr;
uint8_t pendingPresetCommand = 0;
unsigned long nextPresetCommandAt = 0;
Diagnostics diagnostics{};

constexpr uint8_t kPresetCommandNone = 0;
constexpr uint8_t kPresetCommandTurbo = 1;
constexpr uint8_t kPresetCommandSwing = 2;
constexpr uint8_t kPresetCommandLed = 3;

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

AcState desiredState{
    false,
    AppConfig::AcDefaults::kPresetMode,
    AppConfig::AcDefaults::kPresetTemperature,
    AppConfig::AcDefaults::kPresetFanLevel,
    false,
    false,
    false,
};

uint8_t fanLevelToCoolixValue(const int fanLevel) {
  switch (fanLevel) {
    case 1:
      return kCoolixFanMin;
    case 2:
      return kCoolixFanMed;
    case 3:
    default:
      return kCoolixFanMax;
  }
}

uint8_t clampTemperature(const float temperature) {
  const int rounded =
      static_cast<int>(temperature + (temperature >= 0 ? 0.5f : -0.5f));
  return static_cast<uint8_t>(
      constrain(rounded, AppConfig::AcDefaults::kMinTemperature,
                AppConfig::AcDefaults::kMaxTemperature));
}

int clampFanLevel(const int fanLevel) { return constrain(fanLevel, 1, 3); }

bool presetCommandEnabled(const uint8_t command) {
  switch (command) {
    case kPresetCommandTurbo:
      return AppConfig::AcDefaults::kPresetTurbo;
    case kPresetCommandSwing:
      return AppConfig::AcDefaults::kPresetSwing;
    case kPresetCommandLed:
      return AppConfig::AcDefaults::kPresetLed;
    default:
      return false;
  }
}

void cancelPendingPresetCommandsLocked() {
  pendingPresetCommand = kPresetCommandNone;
  nextPresetCommandAt = 0;
}

void scheduleNextPresetCommandLocked(uint8_t command) {
  while (command <= kPresetCommandLed && !presetCommandEnabled(command)) {
    ++command;
  }

  if (command > kPresetCommandLed) {
    cancelPendingPresetCommandsLocked();
    return;
  }

  pendingPresetCommand = command;
  nextPresetCommandAt = millis() + AppConfig::Timing::kAcPresetCommandGapMs;
}

bool enqueueCommandLocked(const CommandType type, const AcState &state) {
  const Command command{type, state};
  if (commandQueue != nullptr &&
      xQueueSend(commandQueue, &command, 0) == pdTRUE) {
    return true;
  }

  ++diagnostics.droppedCommands;
  return false;
}

void transmitLocked() {
  diagnostics.lastIrRaw = ac.getRaw();
  ac.send();
  ++diagnostics.irTransmissions;
}

void applyNormalStateLocked(const AcState &state) {
  ac.setPower(true);
  ac.setMode(state.mode);
  ac.setTemp(state.temperature);
  ac.setFan(fanLevelToCoolixValue(state.fanLevel));
  transmitLocked();
}

void applyPowerOffLocked() {
  ac.setPower(false);
  transmitLocked();
  ac.stateReset();
}

void startPresetLocked(const AcState &state) {
  cancelPendingPresetCommandsLocked();
  applyNormalStateLocked(state);
  scheduleNextPresetCommandLocked(kPresetCommandTurbo);
}

void executeCommandLocked(const Command &command) {
  if (command.type != CommandType::SetPresetPower) {
    cancelPendingPresetCommandsLocked();
  }

  switch (command.type) {
    case CommandType::SetPower:
      if (command.state.power) {
        applyNormalStateLocked(command.state);
      } else {
        applyPowerOffLocked();
      }
      break;
    case CommandType::SetNormalState:
      applyNormalStateLocked(command.state);
      break;
    case CommandType::SetPresetPower:
      if (command.state.power) {
        startPresetLocked(command.state);
      } else {
        cancelPendingPresetCommandsLocked();
        applyPowerOffLocked();
      }
      break;
    case CommandType::ToggleSwing:
      ac.setSwing();
      transmitLocked();
      break;
    case CommandType::ToggleLed:
      ac.setLed();
      transmitLocked();
      break;
    case CommandType::ToggleTurbo:
      ac.setTurbo();
      transmitLocked();
      break;
  }
}

void sendPendingPresetCommandLocked() {
  switch (pendingPresetCommand) {
    case kPresetCommandTurbo:
      ac.setTurbo();
      break;
    case kPresetCommandSwing:
      ac.setSwing();
      break;
    case kPresetCommandLed:
      ac.setLed();
      break;
    default:
      cancelPendingPresetCommandsLocked();
      return;
  }

  transmitLocked();
  scheduleNextPresetCommandLocked(pendingPresetCommand + 1);
}

bool updateAndEnqueueLocked(const CommandType type,
                            const AcState &previousState) {
  if (enqueueCommandLocked(type, desiredState)) {
    return true;
  }

  desiredState = previousState;
  return false;
}

}  // namespace

void begin() {
  if (stateMutex == nullptr) {
    stateMutex = xSemaphoreCreateMutex();
  }
  if (commandQueue == nullptr) {
    commandQueue = xQueueCreate(kCommandQueueDepth, sizeof(Command));
  }

  LockGuard lock(stateMutex);
  ac.begin();
  ac.stateReset();
  cancelPendingPresetCommandsLocked();
}

bool service() {
  LockGuard lock(stateMutex);

  Command command{};
  if (commandQueue != nullptr &&
      xQueueReceive(commandQueue, &command, 0) == pdTRUE) {
    ++diagnostics.executedCommands;
    executeCommandLocked(command);
    return true;
  }

  if (pendingPresetCommand == kPresetCommandNone ||
      static_cast<long>(millis() - nextPresetCommandAt) < 0) {
    return false;
  }

  sendPendingPresetCommandLocked();
  return true;
}

bool setPower(const bool power) {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  desiredState.power = power;
  if (power) {
    desiredState.mode = kCoolixCool;
  } else {
    desiredState.swing = false;
    desiredState.led = false;
    desiredState.turbo = false;
  }
  return updateAndEnqueueLocked(CommandType::SetPower, previousState);
}

bool setMode(const uint8_t mode) {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  desiredState.power = true;
  desiredState.mode = mode;
  return updateAndEnqueueLocked(CommandType::SetNormalState, previousState);
}

bool setFanLevel(const int fanLevel) {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  desiredState.power = true;
  desiredState.fanLevel = clampFanLevel(fanLevel);
  desiredState.mode = kCoolixCool;
  return updateAndEnqueueLocked(CommandType::SetNormalState, previousState);
}

bool adjustFanLevel(const int delta, int &absoluteFanLevel) {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  desiredState.power = true;
  desiredState.fanLevel = clampFanLevel(desiredState.fanLevel + delta);
  desiredState.mode = kCoolixCool;
  const bool queued =
      updateAndEnqueueLocked(CommandType::SetNormalState, previousState);
  absoluteFanLevel = desiredState.fanLevel;
  return queued;
}

bool setTemperature(const float temperature) {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  desiredState.power = true;
  desiredState.temperature = clampTemperature(temperature);
  return updateAndEnqueueLocked(CommandType::SetNormalState, previousState);
}

bool adjustTemperature(const float delta, float &absoluteTemperature) {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  desiredState.power = true;
  desiredState.temperature =
      clampTemperature(static_cast<float>(desiredState.temperature) + delta);
  const bool queued =
      updateAndEnqueueLocked(CommandType::SetNormalState, previousState);
  absoluteTemperature = static_cast<float>(desiredState.temperature);
  return queued;
}

bool togglePreset() {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;

  if (desiredState.power) {
    desiredState.power = false;
    desiredState.swing = false;
    desiredState.led = false;
    desiredState.turbo = false;
  } else {
    desiredState.power = true;
    desiredState.mode = AppConfig::AcDefaults::kPresetMode;
    desiredState.temperature = AppConfig::AcDefaults::kPresetTemperature;
    desiredState.fanLevel = AppConfig::AcDefaults::kPresetFanLevel;
    desiredState.turbo = AppConfig::AcDefaults::kPresetTurbo;
    desiredState.swing = AppConfig::AcDefaults::kPresetSwing;
    desiredState.led = AppConfig::AcDefaults::kPresetLed;
  }

  return updateAndEnqueueLocked(CommandType::SetPresetPower, previousState);
}

bool setPresetPower(const bool power) { return requestPresetPower(power); }

bool requestPresetPower(const bool power) {
  LockGuard lock(stateMutex);
  if (desiredState.power == power) {
    return false;
  }

  const AcState previousState = desiredState;
  desiredState.power = power;
  if (power) {
    desiredState.mode = AppConfig::AcDefaults::kPresetMode;
    desiredState.temperature = AppConfig::AcDefaults::kPresetTemperature;
    desiredState.fanLevel = AppConfig::AcDefaults::kPresetFanLevel;
    desiredState.turbo = AppConfig::AcDefaults::kPresetTurbo;
    desiredState.swing = AppConfig::AcDefaults::kPresetSwing;
    desiredState.led = AppConfig::AcDefaults::kPresetLed;
  } else {
    desiredState.swing = false;
    desiredState.led = false;
    desiredState.turbo = false;
  }

  return updateAndEnqueueLocked(CommandType::SetPresetPower, previousState);
}

bool toggleSwing() {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  desiredState.swing = !desiredState.swing;
  return updateAndEnqueueLocked(CommandType::ToggleSwing, previousState);
}

bool toggleLed() {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  desiredState.led = !desiredState.led;
  return updateAndEnqueueLocked(CommandType::ToggleLed, previousState);
}

bool toggleTurbo() {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  desiredState.turbo = !desiredState.turbo;
  return updateAndEnqueueLocked(CommandType::ToggleTurbo, previousState);
}

AcState getState() {
  LockGuard lock(stateMutex);
  return desiredState;
}

Diagnostics getDiagnostics() {
  LockGuard lock(stateMutex);
  Diagnostics snapshot = diagnostics;
  snapshot.queuedCommands =
      commandQueue == nullptr
          ? 0
          : static_cast<uint8_t>(uxQueueMessagesWaiting(commandQueue));
  return snapshot;
}

String thermostatModeName() {
  const uint8_t mode = getState().mode;
  switch (mode) {
    case kCoolixCool:
      return "COOL";
    case kCoolixHeat:
      return "HEAT";
    case kCoolixAuto:
      return "AUTO";
    case kCoolixDry:
      return "DRY";
    case kCoolixFan:
      return "FAN";
    default:
      return "COOL";
  }
}

}  // namespace AcController
