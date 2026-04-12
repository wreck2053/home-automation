#include "CloudService.h"

#include <Arduino.h>
#include <SinricPro.h>
#include <SinricProSwitch.h>
#include <SinricProWindowAC.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include "AcController.h"
#include "AppConfig.h"
#include "RelayController.h"

namespace CloudService {
namespace {

constexpr char kSinricHost[] = "ws.sinric.pro";
constexpr uint16_t kSinricPort = 443;
constexpr uint32_t kCloudTaskStackSize = 8192;

SemaphoreHandle_t stateMutex = nullptr;
TaskHandle_t cloudTaskHandle = nullptr;

CloudConnectionState connectionState = CloudConnectionState::WiFiDisconnected;
bool cloudConnected = false;
bool callbacksConfigured = false;
bool sinricInitialized = false;
unsigned long lastWiFiAttemptAt = 0;
unsigned long nextCloudRetryAt = 0;
unsigned long cloudRetryBackoffMs = AppConfig::Timing::kCloudRetryInitialMs;
unsigned long cloudHandleWindowUntil = 0;
uint8_t pendingRelayMask = kRelayChangeLight | kRelayChangeFan;
bool pendingAcSync = true;

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

struct PendingSnapshot {
  uint8_t relayMask;
  bool acSync;
};

void scheduleCloudRetryLocked(const unsigned long now) {
  nextCloudRetryAt = now + cloudRetryBackoffMs;
  cloudRetryBackoffMs =
      min(cloudRetryBackoffMs * 2, AppConfig::Timing::kCloudRetryMaxMs);
}

void configureWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(false);
}

void scheduleWiFiAttempt(const unsigned long now) {
  bool shouldAttempt = false;
  {
    LockGuard lock(stateMutex);
    if (now - lastWiFiAttemptAt >= AppConfig::Timing::kWiFiRetryIntervalMs) {
      lastWiFiAttemptAt = now;
      connectionState = CloudConnectionState::WiFiConnecting;
      shouldAttempt = true;
    }
  }

  if (!shouldAttempt) {
    return;
  }

  Serial.printf("[WiFi] Attempting connection to %s\r\n", AppConfig::Wifi::kSsid);
  WiFi.begin(AppConfig::Wifi::kSsid, AppConfig::Wifi::kPassword);
}

bool probeInternetReachability() {
  WiFiClient probeClient;
  probeClient.setTimeout(AppConfig::Timing::kInternetProbeTimeoutMs);
  const bool connected =
      probeClient.connect(kSinricHost, kSinricPort,
                          AppConfig::Timing::kInternetProbeTimeoutMs);
  if (connected) {
    probeClient.stop();
  }
  return connected;
}

PendingSnapshot takePendingSnapshot() {
  LockGuard lock(stateMutex);
  PendingSnapshot snapshot{pendingRelayMask, pendingAcSync};
  pendingRelayMask = kRelayChangeNone;
  pendingAcSync = false;
  return snapshot;
}

void mergePendingSnapshot(const PendingSnapshot &snapshot) {
  LockGuard lock(stateMutex);
  pendingRelayMask |= snapshot.relayMask;
  pendingAcSync = pendingAcSync || snapshot.acSync;
}

bool sendRelayEvent(const RelayId relayId) {
  const RelayState relay = RelayController::getState(relayId);
  SinricProSwitch &device = SinricPro[relay.deviceId];
  return device.sendPowerStateEvent(relay.power);
}

bool sendAcEvents() {
  SinricProWindowAC &device = SinricPro[AppConfig::Sinric::kAcId];
  const AcState state = AcController::getState();
  const String mode = AcController::thermostatModeName();

  bool sent = device.sendPowerStateEvent(state.power);
  sent = device.sendRangeValueEvent(state.fanLevel) && sent;
  sent = device.sendTargetTemperatureEvent(state.temperature) && sent;
  sent = device.sendThermostatModeEvent(mode) && sent;
  return sent;
}

void flushPendingEvents() {
  if (!isCloudConnected()) {
    return;
  }

  PendingSnapshot snapshot = takePendingSnapshot();
  PendingSnapshot failed{kRelayChangeNone, false};

  if ((snapshot.relayMask & kRelayChangeLight) != 0 &&
      !sendRelayEvent(RelayId::Light)) {
    failed.relayMask |= kRelayChangeLight;
  }

  if ((snapshot.relayMask & kRelayChangeFan) != 0 &&
      !sendRelayEvent(RelayId::Fan)) {
    failed.relayMask |= kRelayChangeFan;
  }

  if (snapshot.acSync && !sendAcEvents()) {
    failed.acSync = true;
  }

  if (failed.relayMask != kRelayChangeNone || failed.acSync) {
    mergePendingSnapshot(failed);
  }
}

bool onPowerStateLight(const String &, bool &state) {
  if (RelayController::setPower(RelayId::Light, state, ControlSource::Cloud)) {
    notifyRelayState(RelayId::Light, state, ControlSource::Cloud);
  }
  return true;
}

bool onPowerStateFan(const String &, bool &state) {
  if (RelayController::setPower(RelayId::Fan, state, ControlSource::Cloud)) {
    notifyRelayState(RelayId::Fan, state, ControlSource::Cloud);
  }
  return true;
}

bool onPowerStateAc(const String &, bool &state) {
  if (AcController::setPower(state)) {
    notifyAcState(ControlSource::Cloud);
  }
  return true;
}

bool onRangeValueAc(const String &, int &rangeValue) {
  rangeValue = constrain(rangeValue, 1, 3);
  if (AcController::setFanLevel(rangeValue)) {
    notifyAcState(ControlSource::Cloud);
  }
  rangeValue = AcController::getState().fanLevel;
  return true;
}

bool onAdjustRangeValueAc(const String &, int &rangeDelta) {
  int absoluteFanLevel = 0;
  if (AcController::adjustFanLevel(rangeDelta, absoluteFanLevel)) {
    notifyAcState(ControlSource::Cloud);
  }
  rangeDelta = absoluteFanLevel;
  return true;
}

bool onTargetTemperatureAc(const String &, float &temperature) {
  if (AcController::setTemperature(temperature)) {
    notifyAcState(ControlSource::Cloud);
  }
  temperature = static_cast<float>(AcController::getState().temperature);
  return true;
}

bool onAdjustTargetTemperatureAc(const String &, float &temperatureDelta) {
  float absoluteTemperature = 0.0f;
  if (AcController::adjustTemperature(temperatureDelta, absoluteTemperature)) {
    notifyAcState(ControlSource::Cloud);
  }
  temperatureDelta = absoluteTemperature;
  return true;
}

bool onThermostatModeAc(const String &, String &mode) {
  bool changed = false;
  if (mode == "COOL") {
    changed = AcController::setMode(kCoolixCool);
  } else if (mode == "HEAT") {
    changed = AcController::setMode(kCoolixHeat);
  } else if (mode == "AUTO") {
    changed = AcController::setMode(kCoolixAuto);
  } else if (mode == "DRY") {
    changed = AcController::setMode(kCoolixDry);
  } else if (mode == "FAN") {
    changed = AcController::setMode(kCoolixFan);
  }

  if (changed) {
    notifyAcState(ControlSource::Cloud);
  }

  mode = AcController::thermostatModeName();
  return true;
}

void setupCallbacks() {
  if (callbacksConfigured) {
    return;
  }

  callbacksConfigured = true;

  SinricProSwitch &lightDevice = SinricPro[AppConfig::Sinric::kLightSwitchId];
  lightDevice.onPowerState(onPowerStateLight);

  SinricProSwitch &fanDevice = SinricPro[AppConfig::Sinric::kFanSwitchId];
  fanDevice.onPowerState(onPowerStateFan);

  SinricProWindowAC &acDevice = SinricPro[AppConfig::Sinric::kAcId];
  acDevice.onPowerState(onPowerStateAc);
  acDevice.onRangeValue(onRangeValueAc);
  acDevice.onAdjustRangeValue(onAdjustRangeValueAc);
  acDevice.onTargetTemperature(onTargetTemperatureAc);
  acDevice.onAdjustTargetTemperature(onAdjustTargetTemperatureAc);
  acDevice.onThermostatMode(onThermostatModeAc);

  SinricPro.onConnected([]() {
    LockGuard lock(stateMutex);
    cloudConnected = true;
    connectionState = CloudConnectionState::CloudConnected;
    cloudRetryBackoffMs = AppConfig::Timing::kCloudRetryInitialMs;
    nextCloudRetryAt = 0;
    cloudHandleWindowUntil = 0;
    Serial.println("Connected to SinricPro");
  });

  SinricPro.onDisconnected([]() {
    const unsigned long now = millis();
    LockGuard lock(stateMutex);
    cloudConnected = false;
    cloudHandleWindowUntil = 0;
    if (WiFi.status() == WL_CONNECTED) {
      connectionState = CloudConnectionState::CloudConnecting;
      scheduleCloudRetryLocked(now);
    } else {
      connectionState = CloudConnectionState::WiFiDisconnected;
    }
    Serial.println("Disconnected from SinricPro");
  });
}

void ensureSinricInitialized() {
  if (sinricInitialized) {
    return;
  }

  setupCallbacks();
  SinricPro.begin(AppConfig::Sinric::kAppKey, AppConfig::Sinric::kAppSecret);
  sinricInitialized = true;
}

void cloudTask(void *) {
  configureWiFi();
  ensureSinricInitialized();
  scheduleWiFiAttempt(millis() - AppConfig::Timing::kWiFiRetryIntervalMs);

  for (;;) {
    const unsigned long now = millis();
    const wl_status_t wifiStatus = WiFi.status();

    if (wifiStatus != WL_CONNECTED) {
      {
        LockGuard lock(stateMutex);
        cloudConnected = false;
        cloudHandleWindowUntil = 0;
        if (connectionState != CloudConnectionState::WiFiConnecting) {
          connectionState = CloudConnectionState::WiFiDisconnected;
        }
      }

      scheduleWiFiAttempt(now);
      vTaskDelay(pdMS_TO_TICKS(AppConfig::Timing::kCloudTaskDelayMs));
      continue;
    }

    bool logWiFiConnection = false;
    {
      LockGuard lock(stateMutex);
      if (connectionState == CloudConnectionState::WiFiConnecting ||
          connectionState == CloudConnectionState::WiFiDisconnected) {
        connectionState = CloudConnectionState::InternetUnavailable;
        cloudRetryBackoffMs = AppConfig::Timing::kCloudRetryInitialMs;
        nextCloudRetryAt = now;
        cloudHandleWindowUntil = 0;
        logWiFiConnection = true;
      }
    }

    if (logWiFiConnection) {
      const IPAddress localIp = WiFi.localIP();
      Serial.printf("[WiFi] Connected: %d.%d.%d.%d\r\n", localIp[0], localIp[1],
                    localIp[2], localIp[3]);
    }

    bool connected = false;
    bool withinHandleWindow = false;
    bool shouldProbeCloud = false;
    {
      LockGuard lock(stateMutex);
      connected = cloudConnected;
      withinHandleWindow =
          cloudHandleWindowUntil != 0 && now <= cloudHandleWindowUntil;
      shouldProbeCloud =
          !connected && !withinHandleWindow && now >= nextCloudRetryAt;
    }

    if (connected || withinHandleWindow) {
      SinricPro.handle();
      flushPendingEvents();
      vTaskDelay(pdMS_TO_TICKS(AppConfig::Timing::kCloudTaskDelayMs));
      continue;
    }

    if (shouldProbeCloud) {
      if (!probeInternetReachability()) {
        LockGuard lock(stateMutex);
        connectionState = CloudConnectionState::InternetUnavailable;
        cloudHandleWindowUntil = 0;
        scheduleCloudRetryLocked(now);
      } else {
        {
          LockGuard lock(stateMutex);
          connectionState = CloudConnectionState::CloudConnecting;
          cloudHandleWindowUntil =
              now + AppConfig::Timing::kCloudHandleWindowMs;
          scheduleCloudRetryLocked(now);
        }
        Serial.println("[Cloud] Endpoint reachable, attempting SinricPro connection");
      }
    }

    vTaskDelay(pdMS_TO_TICKS(AppConfig::Timing::kCloudTaskDelayMs));
  }
}

}  // namespace

void begin() {
  if (stateMutex == nullptr) {
    stateMutex = xSemaphoreCreateMutex();
  }

  if (cloudTaskHandle == nullptr) {
    xTaskCreatePinnedToCore(cloudTask, "CloudService", kCloudTaskStackSize,
                            nullptr, 1, &cloudTaskHandle, tskNO_AFFINITY);
  }
}

bool isCloudConnected() {
  LockGuard lock(stateMutex);
  return cloudConnected;
}

CloudConnectionState getConnectionState() {
  LockGuard lock(stateMutex);
  return connectionState;
}

void notifyRelayState(const RelayId relayId, const bool power,
                      const ControlSource source) {
  (void)power;
  if (source == ControlSource::Cloud) {
    return;
  }

  LockGuard lock(stateMutex);
  pendingRelayMask |= relayChangeBit(relayId);
}

void notifyAcState(const ControlSource source) {
  if (source == ControlSource::Cloud) {
    return;
  }

  LockGuard lock(stateMutex);
  pendingAcSync = true;
}

}  // namespace CloudService
