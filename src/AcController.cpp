#include "AcController.h"

#include <Arduino.h>
#include <IRsend.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <ir_Coolix.h>

#include "AppConfig.h"

namespace AcController {
namespace {

IRCoolixAC ac(AppConfig::Pins::kIrTransmitter);
SemaphoreHandle_t stateMutex = nullptr;
uint8_t pendingPresetCommand = 0;
unsigned long nextPresetCommandAt = 0;

constexpr uint8_t kPresetCommandNone = 0;
constexpr uint8_t kPresetCommandNormal = 1;
constexpr uint8_t kPresetCommandTurbo = 2;
constexpr uint8_t kPresetCommandSwing = 3;
constexpr uint8_t kPresetCommandLed = 4;
constexpr uint8_t kPresetCommandPowerOff = 5;

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

AcState state{
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

int coolixFanValueToLevel(const uint8_t fanValue) {
  switch (fanValue) {
    case kCoolixFanMin:
      return 1;
    case kCoolixFanMed:
      return 2;
    case kCoolixFanMax:
      return 3;
    default:
      return state.fanLevel;
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
    case kPresetCommandNormal:
      return true;
    case kPresetCommandTurbo:
      return AppConfig::AcDefaults::kPresetTurbo;
    case kPresetCommandSwing:
      return AppConfig::AcDefaults::kPresetSwing;
    case kPresetCommandLed:
      return AppConfig::AcDefaults::kPresetLed;
    case kPresetCommandPowerOff:
      return true;
    default:
      return false;
  }
}

void cancelPendingPresetCommandsLocked() {
  pendingPresetCommand = 0;
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

void scheduleImmediatePresetCommandLocked(const uint8_t command) {
  pendingPresetCommand = command;
  nextPresetCommandAt = millis();
}

void syncStateFromDeviceLocked() {
  state.power = ac.getPower();
  state.mode = ac.getMode();
  state.temperature = ac.getTemp();
  state.fanLevel = coolixFanValueToLevel(ac.getFan());
  state.swing = ac.getSwing();
  state.led = ac.getLed();
  state.turbo = ac.getTurbo();
}

void applyNormalStateLocked() {
  ac.setPower(true);
  ac.setMode(state.mode);
  ac.setTemp(state.temperature);
  ac.setFan(fanLevelToCoolixValue(state.fanLevel));
  ac.send();
  syncStateFromDeviceLocked();
}

void applyPowerOffLocked() {
  cancelPendingPresetCommandsLocked();
  ac.setPower(false);
  ac.send();
  ac.stateReset();
  state.power = false;
  state.swing = false;
  state.led = false;
  state.turbo = false;
}

void applyPresetLocked() {
  cancelPendingPresetCommandsLocked();
  state.power = true;
  state.mode = AppConfig::AcDefaults::kPresetMode;
  state.temperature = AppConfig::AcDefaults::kPresetTemperature;
  state.fanLevel = AppConfig::AcDefaults::kPresetFanLevel;
  applyNormalStateLocked();

  state.turbo = AppConfig::AcDefaults::kPresetTurbo;
  state.swing = AppConfig::AcDefaults::kPresetSwing;
  state.led = AppConfig::AcDefaults::kPresetLed;
  scheduleNextPresetCommandLocked(kPresetCommandTurbo);
}

void requestPresetLocked(const bool power) {
  cancelPendingPresetCommandsLocked();

  if (power) {
    state.power = true;
    state.mode = AppConfig::AcDefaults::kPresetMode;
    state.temperature = AppConfig::AcDefaults::kPresetTemperature;
    state.fanLevel = AppConfig::AcDefaults::kPresetFanLevel;
    state.turbo = AppConfig::AcDefaults::kPresetTurbo;
    state.swing = AppConfig::AcDefaults::kPresetSwing;
    state.led = AppConfig::AcDefaults::kPresetLed;
    scheduleImmediatePresetCommandLocked(kPresetCommandNormal);
    return;
  }

  state.power = false;
  state.swing = false;
  state.led = false;
  state.turbo = false;
  scheduleImmediatePresetCommandLocked(kPresetCommandPowerOff);
}

void sendPendingPresetCommandLocked() {
  switch (pendingPresetCommand) {
    case kPresetCommandNormal:
      applyNormalStateLocked();
      scheduleNextPresetCommandLocked(kPresetCommandTurbo);
      return;
    case kPresetCommandTurbo:
      ac.setTurbo();
      break;
    case kPresetCommandSwing:
      ac.setSwing();
      break;
    case kPresetCommandLed:
      ac.setLed();
      break;
    case kPresetCommandPowerOff:
      applyPowerOffLocked();
      return;
    default:
      cancelPendingPresetCommandsLocked();
      return;
  }

  ac.send();
  syncStateFromDeviceLocked();
  scheduleNextPresetCommandLocked(pendingPresetCommand + 1);
}

}  // namespace

void begin() {
  if (stateMutex == nullptr) {
    stateMutex = xSemaphoreCreateMutex();
  }

  LockGuard lock(stateMutex);
  ac.begin();
  ac.stateReset();
  cancelPendingPresetCommandsLocked();
  syncStateFromDeviceLocked();
}

bool service() {
  LockGuard lock(stateMutex);
  if (pendingPresetCommand == 0) {
    return false;
  }

  if (static_cast<long>(millis() - nextPresetCommandAt) < 0) {
    return false;
  }

  sendPendingPresetCommandLocked();
  return true;
}

bool setPower(const bool power) {
  LockGuard lock(stateMutex);
  cancelPendingPresetCommandsLocked();
  if (power) {
    state.power = true;
    state.mode = kCoolixCool;
    applyNormalStateLocked();
  } else {
    applyPowerOffLocked();
  }
  return true;
}

bool setMode(const uint8_t mode) {
  LockGuard lock(stateMutex);
  cancelPendingPresetCommandsLocked();
  state.power = true;
  state.mode = mode;
  applyNormalStateLocked();
  return true;
}

bool setFanLevel(const int fanLevel) {
  LockGuard lock(stateMutex);
  cancelPendingPresetCommandsLocked();
  state.power = true;
  state.fanLevel = clampFanLevel(fanLevel);
  state.mode = kCoolixCool;
  applyNormalStateLocked();
  return true;
}

bool adjustFanLevel(const int delta, int &absoluteFanLevel) {
  absoluteFanLevel = clampFanLevel(getState().fanLevel + delta);
  const bool changed = setFanLevel(absoluteFanLevel);
  absoluteFanLevel = getState().fanLevel;
  return changed;
}

bool setTemperature(const float temperature) {
  LockGuard lock(stateMutex);
  cancelPendingPresetCommandsLocked();
  state.power = true;
  state.temperature = clampTemperature(temperature);
  applyNormalStateLocked();
  return true;
}

bool adjustTemperature(const float delta, float &absoluteTemperature) {
  absoluteTemperature =
      static_cast<float>(clampTemperature(getState().temperature + delta));
  const bool changed = setTemperature(absoluteTemperature);
  absoluteTemperature = static_cast<float>(getState().temperature);
  return changed;
}

bool togglePreset() {
  LockGuard lock(stateMutex);

  if (state.power) {
    applyPowerOffLocked();
    return true;
  }

  applyPresetLocked();
  return true;
}

bool setPresetPower(const bool power) {
  LockGuard lock(stateMutex);
  if (state.power == power) {
    return false;
  }

  if (power) {
    applyPresetLocked();
  } else {
    applyPowerOffLocked();
  }

  return true;
}

bool requestPresetPower(const bool power) {
  LockGuard lock(stateMutex);
  if (state.power == power) {
    return false;
  }

  requestPresetLocked(power);
  return true;
}

bool toggleSwing() {
  LockGuard lock(stateMutex);
  cancelPendingPresetCommandsLocked();
  ac.setSwing();
  ac.send();
  syncStateFromDeviceLocked();
  return true;
}

bool toggleLed() {
  LockGuard lock(stateMutex);
  cancelPendingPresetCommandsLocked();
  ac.setLed();
  ac.send();
  syncStateFromDeviceLocked();
  return true;
}

bool toggleTurbo() {
  LockGuard lock(stateMutex);
  cancelPendingPresetCommandsLocked();
  ac.setTurbo();
  ac.send();
  syncStateFromDeviceLocked();
  return true;
}

AcState getState() {
  LockGuard lock(stateMutex);
  return state;
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
