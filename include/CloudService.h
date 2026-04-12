#pragma once

#include "AppTypes.h"

namespace CloudService {

void begin();
bool isCloudConnected();
CloudConnectionState getConnectionState();

void notifyRelayState(RelayId relayId, bool power, ControlSource source);
void notifyAcState(ControlSource source);

}  // namespace CloudService
