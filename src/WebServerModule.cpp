#include "WebServerModule.h"

#include <Arduino.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <WiFi.h>

#include "AcController.h"
#include "AppConfig.h"
#include "CloudService.h"
#include "RelayController.h"

namespace WebServerModule {
namespace {

AsyncWebServer server(80);

const char indexHtml[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body {
    font-family: Arial, sans-serif;
    background: linear-gradient(180deg, #000000, #434343);
    color: #f4f4f9;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    padding: 20px;
    box-sizing: border-box;
}
h1, h2, h3 {
    color: #f4f4f9;
}
button {
    background-color: #585858;
    color: white;
    border: none;
    padding: 10px 20px;
    margin: 10px;
    font-size: 16px;
    border-radius: 5px;
    cursor: pointer;
    transition: background-color 0.3s;
}
button:hover {
    background-color: #757575;
}
div.container {
    text-align: center;
    background: rgba(255, 255, 255, 0.1);
    padding: 20px;
    border-radius: 10px;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
    width: 100%;
    max-width: 500px;
}
</style>
<title>NodeMCU-32S Server</title>
</head>
<body>
<div class="container">
<h1>My Bedroom</h1>
<button onclick="toggleLight()">Toggle Light</button>
<br>
<br>
<button onclick="toggleFan()">Toggle Fan</button>
<br>
<br>
<h2>AC Control</h2>
<button onclick="sendCommand('/power/on')">Power On AC</button>
<button onclick="sendCommand('/power/off')">Power Off AC</button>
<br>
<h3>Mode</h3>
<button onclick="sendCommand('/mode/cool')">Cool Mode</button>
<button onclick="sendCommand('/preset-ac')">Preset AC</button>
<br>
<h3>Fan Speed</h3>
<button onclick="sendCommand('/fan/low')">Fan Low</button>
<button onclick="sendCommand('/fan/med')">Fan Medium</button>
<button onclick="sendCommand('/fan/high')">Fan High</button>
<br>
<h3>Temperature</h3>
<button onclick="sendCommand('/temp/up')">Temp Up</button>
<button onclick="sendCommand('/temp/down')">Temp Down</button>
<br>
<h3>Set Specific Temperature</h3>
<button onclick="sendCommand('/temp/set/17')">Set Temp 17 C</button>
<button onclick="sendCommand('/temp/set/18')">Set Temp 18 C</button>
<button onclick="sendCommand('/temp/set/19')">Set Temp 19 C</button>
<button onclick="sendCommand('/temp/set/20')">Set Temp 20 C</button>
<button onclick="sendCommand('/temp/set/21')">Set Temp 21 C</button>
<button onclick="sendCommand('/temp/set/22')">Set Temp 22 C</button>
<button onclick="sendCommand('/temp/set/23')">Set Temp 23 C</button>
<button onclick="sendCommand('/temp/set/24')">Set Temp 24 C</button>
<button onclick="sendCommand('/temp/set/25')">Set Temp 25 C</button>
<button onclick="sendCommand('/temp/set/26')">Set Temp 26 C</button>
<button onclick="sendCommand('/temp/set/27')">Set Temp 27 C</button>
<button onclick="sendCommand('/temp/set/28')">Set Temp 28 C</button>
<button onclick="sendCommand('/temp/set/29')">Set Temp 29 C</button>
<button onclick="sendCommand('/temp/set/30')">Set Temp 30 C</button>
<button onclick="sendCommand('/state/swing')">Swing</button>
<button onclick="sendCommand('/state/led')">Toggle LED</button>
<button onclick="sendCommand('/state/turbo')">Turbo</button>
</div>
<script>
function toggleLight() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/toggle-light', true);
    xhr.send();
}
function toggleFan() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/toggle-fan', true);
    xhr.send();
}
function sendCommand(command) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', command, true);
    xhr.send();
}
</script>
</body>
</html>
)rawliteral";

void sendPlainText(AsyncWebServerRequest *request, const String &message) {
  request->send(200, "text/plain", message);
}

void syncRelayEvent(const RelayId relayId, const ControlSource source) {
  CloudService::notifyRelayState(relayId, RelayController::getPower(relayId),
                                 source);
}

void syncAcEvent(const ControlSource source) {
  CloudService::notifyAcState(source);
}

const char *cloudStateName(const CloudConnectionState state) {
  switch (state) {
    case CloudConnectionState::WiFiDisconnected:
      return "wifi_disconnected";
    case CloudConnectionState::WiFiConnecting:
      return "wifi_connecting";
    case CloudConnectionState::InternetUnavailable:
      return "internet_unavailable";
    case CloudConnectionState::CloudConnecting:
      return "cloud_connecting";
    case CloudConnectionState::CloudConnected:
      return "cloud_connected";
  }
  return "unknown";
}

}  // namespace

void begin() {
  server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send_P(200, "text/html", indexHtml);
  });

  server.on("/diagnostics", HTTP_GET, [](AsyncWebServerRequest *request) {
    const IPAddress ip = WiFi.localIP();
    String response;
    response.reserve(256);
    response += "uptime_ms=" + String(millis()) + "\n";
    response += "free_heap=" + String(ESP.getFreeHeap()) + "\n";
    response += "wifi_status=" + String(static_cast<int>(WiFi.status())) + "\n";
    response += "wifi_ip=" + ip.toString() + "\n";
    response += "wifi_rssi_dbm=" + String(WiFi.RSSI()) + "\n";
    response += "cloud_state=" +
                String(cloudStateName(CloudService::getConnectionState())) +
                "\n";
    response += "cloud_connected=" +
                String(CloudService::isCloudConnected() ? "true" : "false") +
                "\n";
    sendPlainText(request, response);
  });

  server.on("/toggle-light", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (RelayController::toggle(RelayId::Light, ControlSource::Http)) {
      syncRelayEvent(RelayId::Light, ControlSource::Http);
    }
    sendPlainText(request, "Light toggled");
  });

  server.on("/toggle-fan", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (RelayController::toggle(RelayId::Fan, ControlSource::Http)) {
      syncRelayEvent(RelayId::Fan, ControlSource::Http);
    }
    sendPlainText(request, "Fan toggled");
  });

  server.on("/toggle-nl", HTTP_GET, [](AsyncWebServerRequest *request) {
    digitalWrite(AppConfig::Pins::kBuiltInLed,
                 !digitalRead(AppConfig::Pins::kBuiltInLed));
    sendPlainText(request, "Night Lamp toggled");
  });

  server.on("/power/on", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::setPower(true)) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Power On");
  });

  server.on("/power/off", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::setPower(false)) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Power Off");
  });

  server.on("/preset-ac", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::togglePreset()) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Preset AC");
  });

  server.on("/mode/cool", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::setMode(kCoolixCool)) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Cool Mode");
  });

  server.on("/mode/heat", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::setMode(kCoolixHeat)) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Heat Mode");
  });

  server.on("/fan/low", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::setFanLevel(1)) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Fan Low");
  });

  server.on("/fan/med", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::setFanLevel(2)) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Fan Medium");
  });

  server.on("/fan/high", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::setFanLevel(3)) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Fan High");
  });

  server.on("/temp/up", HTTP_GET, [](AsyncWebServerRequest *request) {
    float absoluteTemperature = 0;
    if (AcController::adjustTemperature(1.0f, absoluteTemperature)) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Temperature Up");
  });

  server.on("/temp/down", HTTP_GET, [](AsyncWebServerRequest *request) {
    float absoluteTemperature = 0;
    if (AcController::adjustTemperature(-1.0f, absoluteTemperature)) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Temperature Down");
  });

  server.on("/state/swing", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::toggleSwing()) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Swing");
  });

  server.on("/state/led", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::toggleLed()) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Toggle LED");
  });

  server.on("/state/turbo", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (AcController::toggleTurbo()) {
      syncAcEvent(ControlSource::Http);
    }
    sendPlainText(request, "Turbo");
  });

  for (int temperature = AppConfig::AcDefaults::kMinTemperature;
       temperature <= AppConfig::AcDefaults::kMaxTemperature; ++temperature) {
    const String route = "/temp/set/" + String(temperature);
    server.on(route.c_str(), HTTP_GET,
              [temperature](AsyncWebServerRequest *request) {
                if (AcController::setTemperature(
                        static_cast<float>(temperature))) {
                  syncAcEvent(ControlSource::Http);
                }
                sendPlainText(request, "Temperature Set to " +
                                           String(temperature) + " C");
              });
  }

  server.begin();
}

}  // namespace WebServerModule
