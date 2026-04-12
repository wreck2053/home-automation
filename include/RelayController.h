#pragma once

#include "AppTypes.h"

namespace RelayController {

void begin();
uint8_t service();
bool setPower(RelayId relayId, bool power, ControlSource source);
bool toggle(RelayId relayId, ControlSource source);
bool getPower(RelayId relayId);
RelayState getState(RelayId relayId);

}  // namespace RelayController
