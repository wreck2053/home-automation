#include "OtaService.h"

#include <Arduino.h>
#include <ArduinoOTA.h>
#include <WiFi.h>

#include "AppConfig.h"

namespace OtaService {
namespace {

bool started = false;

void configureCallbacks() {
  ArduinoOTA.onStart([]() {
    Serial.println("[OTA] Update started");
  });

  ArduinoOTA.onEnd([]() {
    Serial.println();
    Serial.println("[OTA] Update complete");
  });

  ArduinoOTA.onProgress([](const unsigned int progress,
                           const unsigned int total) {
    const unsigned int percent = total == 0 ? 0 : progress / (total / 100);
    Serial.printf("[OTA] Progress: %u%%\r", percent);
  });

  ArduinoOTA.onError([](const ota_error_t error) {
    Serial.printf("\n[OTA] Error %u: ", error);
    switch (error) {
      case OTA_AUTH_ERROR:
        Serial.println("authentication failed");
        break;
      case OTA_BEGIN_ERROR:
        Serial.println("update could not begin");
        break;
      case OTA_CONNECT_ERROR:
        Serial.println("connection failed");
        break;
      case OTA_RECEIVE_ERROR:
        Serial.println("receive failed");
        break;
      case OTA_END_ERROR:
        Serial.println("update could not finish");
        break;
      default:
        Serial.println("unknown error");
        break;
    }
  });
}

}  // namespace

void begin() {
  ArduinoOTA.setHostname(AppConfig::Ota::kHostname);
  if (AppConfig::Ota::kPassword[0] != '\0') {
    ArduinoOTA.setPassword(AppConfig::Ota::kPassword);
  }
  configureCallbacks();
}

void service() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  if (!started) {
    ArduinoOTA.begin();
    started = true;

    const IPAddress ip = WiFi.localIP();
    Serial.printf("[OTA] Ready at %s.local (%d.%d.%d.%d)\r\n",
                  AppConfig::Ota::kHostname, ip[0], ip[1], ip[2], ip[3]);
  }

  ArduinoOTA.handle();
}

}  // namespace OtaService
