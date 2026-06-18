#pragma once

#include <Arduino.h>

#include "AppTypes.h"
#include <ir_Coolix.h>

#if __has_include("Secrets.h")
#include "Secrets.h"
#endif

namespace AppConfig {

namespace Wifi {
#ifndef APP_WIFI_SSID
#define APP_WIFI_SSID "YOUR_SSID"
#endif

#ifndef APP_WIFI_PASSWORD
#define APP_WIFI_PASSWORD "YOUR_PASS"
#endif

constexpr char kSsid[] = APP_WIFI_SSID;
constexpr char kPassword[] = APP_WIFI_PASSWORD;
}  // namespace Wifi

namespace Ota {
#ifndef APP_OTA_HOSTNAME
#define APP_OTA_HOSTNAME "home-automation"
#endif

#ifndef APP_OTA_PASSWORD
#define APP_OTA_PASSWORD ""
#endif

constexpr char kHostname[] = APP_OTA_HOSTNAME;
constexpr char kPassword[] = APP_OTA_PASSWORD;
}  // namespace Ota

namespace Sinric {
constexpr char kAppKey[] = "12fbb630-3465-4e47-a312-7888355266b4";
constexpr char kAppSecret[] =
    "1b0bc916-d160-419e-9beb-fd2935a5ddbc-13efd354-02a6-4a0b-8e5c-"
    "1765edb0b078";

constexpr char kLightSwitchId[] = "664268b26443b9bfe2b8d715";
constexpr char kFanSwitchId[] = "6644c9cf6443b9bfe2b9dfb5";
constexpr char kAcId[] = "665cdc416e1af35935ffafc0";
}  // namespace Sinric

namespace Pins {
constexpr uint8_t kBuiltInLed = BUILTIN_LED;
constexpr DevicePins kLight{18, 12, true};
constexpr DevicePins kFan{5, 13, true};
constexpr uint8_t kAcSwitch = 19;
constexpr uint8_t kIrTransmitter = 4;

// ESP32 boot strap notes:
// GPIO12 influences flash voltage on boot, so keep the external switch wiring stable.
// GPIO5 is also a strapping pin; avoid forcing it low during reset.
}  // namespace Pins

namespace Timing {
constexpr unsigned long kSwitchDebounceMs = 5;
constexpr unsigned long kHeapLogIntervalMs = 30000;
constexpr unsigned long kWiFiRetryIntervalMs = 5000;
constexpr unsigned long kCloudRetryInitialMs = 10000;
constexpr unsigned long kCloudRetryMaxMs = 60000;
constexpr unsigned long kCloudHandleWindowMs = 15000;
constexpr unsigned long kCloudTaskDelayMs = 20;
constexpr unsigned long kAcPresetCommandGapMs = 500;
constexpr int kInternetProbeTimeoutMs = 5000;
}  // namespace Timing

namespace AcDefaults {
constexpr uint8_t kMinTemperature = kCoolixTempMin;
constexpr uint8_t kMaxTemperature = kCoolixTempMax;
constexpr uint8_t kPresetTemperature = 24;
constexpr uint8_t kPresetMode = kCoolixCool;
constexpr int kPresetFanLevel = 2;
constexpr bool kPresetSwing = true;
constexpr bool kPresetLed = false;
constexpr bool kPresetTurbo = false;
}  // namespace AcDefaults

}  // namespace AppConfig
