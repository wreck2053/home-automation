#pragma once

#include <Arduino.h>

namespace AcSwitchController {

bool begin();
bool service();
uint32_t getPhysicalEdgeCount();

}  // namespace AcSwitchController
