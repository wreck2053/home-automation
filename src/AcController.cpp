#include "AcController.h"

#include <Arduino.h>
#include <IRsend.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <ir_Coolix.h>

#include "AppConfig.h"

namespace AcController {
namespace {

constexpr UBaseType_t kCommandQueueDepth = 16;
constexpr uint32_t kIrWorkerStackSize = 4096;
constexpr UBaseType_t kIrWorkerPriority = 4;
constexpr BaseType_t kIrWorkerCore = 1;

struct Command {
  CommandType type;
  AcState state;
};

IRCoolixAC ac(AppConfig::Pins::kIrTransmitter);
SemaphoreHandle_t stateMutex = nullptr;
QueueHandle_t commandQueue = nullptr;
TaskHandle_t irWorkerTaskHandle = nullptr;
Diagnostics diagnostics{};

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

bool enqueueCommandLocked(const CommandType type, const AcState &state) {
  if (commandQueue == nullptr) {
    ++diagnostics.droppedCommands;
    return false;
  }

  const UBaseType_t queuedBefore = uxQueueMessagesWaiting(commandQueue);
  const Command command{type, state};
  if (xQueueSend(commandQueue, &command, 0) != pdTRUE) {
    ++diagnostics.droppedCommands;
    return false;
  }

  const uint8_t queuedAfter = static_cast<uint8_t>(queuedBefore + 1);
  diagnostics.queueHighWaterMark =
      max(diagnostics.queueHighWaterMark, queuedAfter);
  return true;
}

void recordTransmission(const uint32_t raw) {
  LockGuard lock(stateMutex);
  diagnostics.lastIrRaw = raw;
  ++diagnostics.irTransmissions;
}

void transmit() {
  const uint32_t raw = ac.getRaw();
  ac.send();
  recordTransmission(raw);
}

void applyNormalState(const AcState &state) {
  ac.setPower(true);
  ac.setMode(state.mode);
  ac.setTemp(state.temperature);
  ac.setFan(fanLevelToCoolixValue(state.fanLevel));
  transmit();
}

void applyPowerOff() {
  ac.setPower(false);
  transmit();
  ac.stateReset();
}

void executeCommand(const Command &command) {
  switch (command.type) {
    case CommandType::SetPower:
    case CommandType::SetPresetPower:
      if (command.state.power) {
        applyNormalState(command.state);
      } else {
        applyPowerOff();
      }
      break;
    case CommandType::SetNormalState:
      applyNormalState(command.state);
      break;
    case CommandType::ToggleSwing:
      ac.setSwing();
      transmit();
      break;
    case CommandType::ToggleLed:
      ac.setLed();
      transmit();
      break;
    case CommandType::ToggleTurbo:
      ac.setTurbo();
      transmit();
      break;
    case CommandType::None:
      return;
  }
}

void irWorkerTask(void *) {
  ac.begin();
  ac.stateReset();

  {
    LockGuard lock(stateMutex);
    diagnostics.workerRunning = true;
  }

  for (;;) {
    Command command{};
    if (xQueueReceive(commandQueue, &command, portMAX_DELAY) != pdTRUE) {
      continue;
    }

    executeCommand(command);

    LockGuard lock(stateMutex);
    ++diagnostics.executedCommands;
    diagnostics.lastCommand = command.type;
  }
}

bool updateAndEnqueueLocked(const CommandType type,
                            const AcState &previousState) {
  if (enqueueCommandLocked(type, desiredState)) {
    return true;
  }

  desiredState = previousState;
  return false;
}

void applyPresetStateLocked() {
  desiredState.power = true;
  desiredState.mode = AppConfig::AcDefaults::kPresetMode;
  desiredState.temperature = AppConfig::AcDefaults::kPresetTemperature;
  desiredState.fanLevel = AppConfig::AcDefaults::kPresetFanLevel;
  desiredState.swing = false;
  desiredState.led = false;
  desiredState.turbo = false;
}

void applyOffStateLocked() {
  desiredState.power = false;
  desiredState.swing = false;
  desiredState.led = false;
  desiredState.turbo = false;
}

}  // namespace

void begin() {
  if (stateMutex == nullptr) {
    stateMutex = xSemaphoreCreateMutex();
  }
  if (commandQueue == nullptr) {
    commandQueue = xQueueCreate(kCommandQueueDepth, sizeof(Command));
  }
  if (irWorkerTaskHandle == nullptr && stateMutex != nullptr &&
      commandQueue != nullptr) {
    xTaskCreatePinnedToCore(irWorkerTask, "AcIrWorker", kIrWorkerStackSize,
                            nullptr, kIrWorkerPriority, &irWorkerTaskHandle,
                            kIrWorkerCore);
  }
}

bool setPower(const bool power) {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  if (power) {
    desiredState.power = true;
    desiredState.mode = kCoolixCool;
  } else {
    applyOffStateLocked();
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
    applyOffStateLocked();
  } else {
    applyPresetStateLocked();
  }
  return updateAndEnqueueLocked(CommandType::SetPresetPower, previousState);
}

bool setPresetPower(const bool power) {
  LockGuard lock(stateMutex);
  const AcState previousState = desiredState;
  if (power) {
    applyPresetStateLocked();
  } else {
    applyOffStateLocked();
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

const char *commandTypeName(const CommandType type) {
  switch (type) {
    case CommandType::SetPower:
      return "set_power";
    case CommandType::SetNormalState:
      return "set_normal_state";
    case CommandType::SetPresetPower:
      return "set_preset_power";
    case CommandType::ToggleSwing:
      return "toggle_swing";
    case CommandType::ToggleLed:
      return "toggle_led";
    case CommandType::ToggleTurbo:
      return "toggle_turbo";
    case CommandType::None:
    default:
      return "none";
  }
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
