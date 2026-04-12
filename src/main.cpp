#include <Arduino.h>

#include "AcController.h"
#include "AppConfig.h"
#include "CloudService.h"
#include "RelayController.h"
#include "WebServerModule.h"

namespace {

void servicePhysicalControls() {
  const uint8_t changeMask = RelayController::service();

  if ((changeMask & kRelayChangeLight) != 0) {
    CloudService::notifyRelayState(RelayId::Light,
                                   RelayController::getPower(RelayId::Light),
                                   ControlSource::PhysicalSwitch);
  }

  if ((changeMask & kRelayChangeFan) != 0) {
    CloudService::notifyRelayState(RelayId::Fan,
                                   RelayController::getPower(RelayId::Fan),
                                   ControlSource::PhysicalSwitch);
  }
}

void serviceHousekeeping() {
  static unsigned long lastHeapPrintAt = 0;
  const unsigned long now = millis();

  if (now - lastHeapPrintAt < AppConfig::Timing::kHeapLogIntervalMs) {
    return;
  }

  Serial.printf("Free heap: %u bytes\r\n", ESP.getFreeHeap());
  lastHeapPrintAt = now;
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(250);

  Serial.println();
  Serial.println("Setup start");
  Serial.println("Boot pin notes: GPIO12 and GPIO5 are strap-sensitive.");

  pinMode(AppConfig::Pins::kBuiltInLed, OUTPUT);
  RelayController::begin();
  AcController::begin();
  CloudService::begin();
  WebServerModule::begin();

  Serial.println("Setup end");
}

void loop() {
  servicePhysicalControls();
  serviceHousekeeping();
}
