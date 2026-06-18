#pragma once

#include "AppTypes.h"

namespace CloudService {

struct CallbackStats {
  uint32_t lightPower;
  uint32_t fanPower;
  uint32_t acPower;
  uint32_t acRange;
  uint32_t acAdjustRange;
  uint32_t acTargetTemperature;
  uint32_t acAdjustTemperature;
  uint32_t acMode;
  unsigned long lastCallbackAtMs;
};

void begin();
bool isCloudConnected();
CloudConnectionState getConnectionState();
CallbackStats getCallbackStats();

void notifyRelayState(RelayId relayId, bool power, ControlSource source);
void notifyAcState(ControlSource source);

}  // namespace CloudService
