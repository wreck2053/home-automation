#include <Arduino.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <IRsend.h>
#include <SinricPro.h>
#include <SinricProSwitch.h>
#include <SinricProWindowAC.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ir_Coolix.h>

#define WIFI_SSID "YOUR_SSID"
#define WIFI_PASS "YOUR_PASS"

#define APP_KEY "12fbb630-3465-4e47-a312-7888355266b4"
#define APP_SECRET                                                  \
    "1b0bc916-d160-419e-9beb-fd2935a5ddbc-13efd354-02a6-4a0b-8e5c-" \
    "1765edb0b078"

int previousLightState = LOW;
#define LIGHT_RELAY_PIN 18
#define LIGHT_SWITCH_PIN 12
#define SWITCH_ID_LIGHT "664268b26443b9bfe2b8d715"

int previousFanState = LOW;
#define FAN_RELAY_PIN 5
#define FAN_SWITCH_PIN 13
#define SWITCH_ID_FAN "6644c9cf6443b9bfe2b9dfb5"

#define IR_TRANSMITTER_PIN 4
IRsend irsend(IR_TRANSMITTER_PIN);
IRCoolixAC ac(IR_TRANSMITTER_PIN);
#define AC_ID "665cdc416e1af35935ffafc0"

AsyncWebServer server(80);

void setupDevices() {
    pinMode(BUILTIN_LED, OUTPUT);
    pinMode(LIGHT_RELAY_PIN, OUTPUT);
    pinMode(LIGHT_SWITCH_PIN, INPUT_PULLUP);
    pinMode(FAN_RELAY_PIN, OUTPUT);
    pinMode(FAN_SWITCH_PIN, INPUT_PULLUP);

    irsend.begin();
    ac.begin();
    ac.stateReset();
}

void setupWiFi() {
    Serial.println(WIFI_SSID);
    Serial.println(WIFI_PASS);

    Serial.print("\nConnecting to Wi-Fi...");
    WiFi.begin(WIFI_SSID, WIFI_PASS);
}

bool onPowerStateLight(const String& deviceId, bool& state) {
    Serial.printf("Light turned %s\n", state ? "on" : "off");
    digitalWrite(LIGHT_RELAY_PIN, state ? LOW : HIGH);
    return true;
}

bool onPowerStateFan(const String& deviceId, bool& state) {
    Serial.printf("Fan turned %s\n", state ? "on" : "off");
    digitalWrite(FAN_RELAY_PIN, state ? LOW : HIGH);
    return true;
}

bool onPowerStateAC(const String& deviceId, bool& state) {
    Serial.printf("AC turned %s\n", state ? "on" : "off");
    ac.setPower(state ? true : false);
    // automatically set to COOL mode when AC is turned on
    if (state) ac.setMode(kCoolixCool);
    ac.send();
    return true;
}

// increase or decrease fan speed
bool onAdjustRangeValueAC(const String& deviceId, int& rangeValue) {
    // first set to COOL
    ac.setMode(kCoolixCool);

    Serial.printf("AC range value changed by %d\n", rangeValue);
    int fanSpeed = ac.getFan();
    if (rangeValue > 0) {
        if (fanSpeed < kCoolixFanMax) {
            ac.setFan(fanSpeed + 1);
            ac.send();
        }
    } else {
        if (fanSpeed > kCoolixFanMin) {
            ac.setFan(fanSpeed - 1);
            ac.send();
        }
    }
    return true;
}

// increase or decrease temperature
bool onAdjustTargetTemperature(const String& deviceId, float& temperature) {
    Serial.printf("AC target temperature changed by %f\n", temperature);
    int temp = ac.getTemp();
    if (temperature > 0) {
        if (temp < 30) {
            ac.setTemp(temp + 1);
            ac.send();
        }
    } else {
        if (temp > 17) {
            ac.setTemp(temp - 1);
            ac.send();
        }
    }
    return true;
}

// fan speeds - low, medium, high
bool onRangeValue(const String& deviceId, int& rangeValue) {
    // first set to COOL
    ac.setMode(kCoolixCool);

    Serial.printf("AC speed set to %d\n", rangeValue);
    if (rangeValue == 1) {
        ac.setFan(kCoolixFanMin);
    } else if (rangeValue == 2) {
        ac.setFan(kCoolixFanMed);
    } else if (rangeValue == 3) {
        ac.setFan(kCoolixFanMax);
    }
    ac.send();
    return true;
}

// set specific temperature
bool onTargetTemperature(const String& deviceId, float& temperature) {
    Serial.printf("AC temperature set to %d\n", (int)temperature);
    ac.setTemp((int)temperature);
    ac.send();
    return true;
}

// ac mode - cool, heat, auto, dry, fan
bool onThermostatMode(const String& deviceId, String& mode) {
    Serial.printf("AC thermostat mode adjusted to %s\n", mode.c_str());
    if (mode == "COOL") {
        ac.setMode(kCoolixCool);
    } else if (mode == "HEAT") {
        ac.setMode(kCoolixHeat);
    } else if (mode == "AUTO") {
        ac.setMode(kCoolixAuto);
    } else if (mode == "DRY") {
        ac.setMode(kCoolixDry);
    } else if (mode == "FAN") {
        ac.setMode(kCoolixFan);
    }
    ac.send();
    return true;
}

void setupSinricPro() {
    // add devices and callbacks to SinricPro
    SinricProSwitch& lightSwitch = SinricPro[SWITCH_ID_LIGHT];
    lightSwitch.onPowerState(onPowerStateLight);

    SinricProSwitch& fanSwitch = SinricPro[SWITCH_ID_FAN];
    fanSwitch.onPowerState(onPowerStateFan);

    SinricProWindowAC& airConditioner = SinricPro[AC_ID];
    airConditioner.onPowerState(onPowerStateAC);
    airConditioner.onAdjustRangeValue(onAdjustRangeValueAC);
    airConditioner.onAdjustTargetTemperature(onAdjustTargetTemperature);
    airConditioner.onRangeValue(onRangeValue);
    airConditioner.onTargetTemperature(onTargetTemperature);
    airConditioner.onThermostatMode(onThermostatMode);

    SinricPro.onConnected(
        []() { Serial.printf("Connected to SinricPro\r\n"); });

    SinricPro.onDisconnected(
        []() { Serial.printf("Disconnected from SinricPro\r\n"); });

    SinricPro.begin(APP_KEY, APP_SECRET);
}

void setupServer() {
    // Route for root / web page
    server.on("/", HTTP_GET, [](AsyncWebServerRequest* request) {
        request->send(
            200, "text/html",
            "<!DOCTYPE html>"
            "<html lang=\"en\">"
            "<head>"
            "<meta charset=\"UTF-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, "
            "initial-scale=1.0\">"
            "<style>"
            "body {"
            "    font-family: Arial, sans-serif;"
            "    background: linear-gradient(180deg, #000000, #434343);"
            "    color: #f4f4f9;"
            "    display: flex;"
            "    flex-direction: column;"
            "    align-items: center;"
            "    justify-content: center;"
            "    min-height: 100vh;"
            "    margin: 0;"
            "    padding: 20px;"
            "    box-sizing: border-box;"
            "}"
            "h1, h2, h3 {"
            "    color: #f4f4f9;"
            "}"
            "button {"
            "    background-color: #585858;"
            "    color: white;"
            "    border: none;"
            "    padding: 10px 20px;"
            "    margin: 10px;"
            "    font-size: 16px;"
            "    border-radius: 5px;"
            "    cursor: pointer;"
            "    transition: background-color 0.3s;"
            "}"
            "button:hover {"
            "    background-color: #757575;"
            "}"
            "div.container {"
            "    text-align: center;"
            "    background: rgba(255, 255, 255, 0.1);"
            "    padding: 20px;"
            "    border-radius: 10px;"
            "    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);"
            "    width: 100%;"
            "    max-width: 500px;"
            "}"
            "</style>"
            "<title>NodeMCU-32S Server</title>"
            "</head>"
            "<body>"
            "<div class=\"container\">"
            "<h1>My Bedroom</h1>"
            "<button onclick=\"toggleLight()\">Toggle Light</button>"
            "<br>"
            "<br>"
            "<button onclick=\"toggleFan()\">Toggle Fan</button>"
            "<br>"
            "<br>"
            "<h2>AC Control</h2>"
            "<button onclick=\"sendCommand('/power/on')\">Power On AC</button>"
            "<button onclick=\"sendCommand('/power/off')\">Power Off "
            "AC</button>"
            "<br>"
            "<h3>Mode</h3>"
            "<button onclick=\"sendCommand('/mode/cool')\">Cool Mode</button>"
            "<button onclick=\"sendCommand('/preset-ac')\">Preset AC</button>"
            "<br>"
            "<h3>Fan Speed</h3>"
            "<button onclick=\"sendCommand('/fan/low')\">Fan Low</button>"
            "<button onclick=\"sendCommand('/fan/med')\">Fan Medium</button>"
            "<button onclick=\"sendCommand('/fan/high')\">Fan High</button>"
            "<br>"
            "<h3>Temperature</h3>"
            "<button onclick=\"sendCommand('/temp/up')\">Temp Up</button>"
            "<button onclick=\"sendCommand('/temp/down')\">Temp Down</button>"
            "<br>"
            "<h3>Set Specific Temperature</h3>"
            "<button onclick=\"sendCommand('/temp/set/17')\">Set Temp 17 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/18')\">Set Temp 18 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/19')\">Set Temp 19 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/20')\">Set Temp 20 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/21')\">Set Temp 21 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/22')\">Set Temp 22 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/23')\">Set Temp 23 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/24')\">Set Temp 24 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/25')\">Set Temp 25 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/26')\">Set Temp 26 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/27')\">Set Temp 27 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/28')\">Set Temp 28 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/29')\">Set Temp 29 "
            "C</button>"
            "<button onclick=\"sendCommand('/temp/set/30')\">Set Temp 30 "
            "C</button>"

            "<button onclick=\"sendCommand('/state/swing')\">Swing"
            "</button>"
            "<button onclick=\"sendCommand('/state/led')\">Toggle LED"
            "</button>"
            "<button onclick=\"sendCommand('/state/turbo')\">Turbo"
            "</button>"

            "</div>"
            "<script>"
            "function toggleLight() {"
            "    var xhr = new XMLHttpRequest();"
            "    xhr.open('GET', '/toggle-light', true);"
            "    xhr.send();"
            "}"
            "function toggleFan() {"
            "    var xhr = new XMLHttpRequest();"
            "    xhr.open('GET', '/toggle-fan', true);"
            "    xhr.send();"
            "}"
            "function sendCommand(command) {"
            "    var xhr = new XMLHttpRequest();"
            "    xhr.open('GET', command, true);"
            "    xhr.send();"
            "}"
            "</script>"
            "</body>"
            "</html>");
    });

    // Route to handle Light toggle
    server.on("/toggle-light", HTTP_GET, [](AsyncWebServerRequest* request) {
        digitalWrite(LIGHT_RELAY_PIN, !digitalRead(LIGHT_RELAY_PIN));
        request->send(200, "text/plain", "Light toggled");
    });

    // Route to handle Fan toggle
    server.on("/toggle-fan", HTTP_GET, [](AsyncWebServerRequest* request) {
        digitalWrite(FAN_RELAY_PIN, !digitalRead(FAN_RELAY_PIN));
        request->send(200, "text/plain", "Fan toggled");
    });

    // Route to handle Night Lamp toggle
    server.on("/toggle-nl", HTTP_GET, [](AsyncWebServerRequest* request) {
        digitalWrite(BUILTIN_LED, !digitalRead(BUILTIN_LED));
        request->send(200, "text/plain", "Night Lamp toggled");
    });

    // Define routes to handle control requests
    server.on("/power/on", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setPower(true);
        // automatically set to COOL mode when AC is turned on
        ac.setMode(kCoolixCool);
        ac.send();
        request->send(200, "text/plain", "Power On");
    });

    server.on("/power/off", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setPower(false);
        ac.send();
        request->send(200, "text/plain", "Power Off");
    });

    // Route to handle AC preset
    server.on("/preset-ac", HTTP_GET, [](AsyncWebServerRequest* request) {
        // get ac state
        bool power = ac.getPower();
        if (power) {  // if AC is already on, turn it off
            ac.setPower(false);
            ac.send();
        } else {
            ac.setPower(true);
            ac.setMode(kCoolixCool);  // automatically set to COOL mode when AC
                                      // is turned on
            ac.setTemp(17);
            ac.send();
            ac.setTurbo();
            ac.send();
            ac.setSwing();
            ac.send();
            ac.setLed();
            ac.send();
        }
        request->send(200, "text/plain", "Preset AC");
    });

    server.on("/mode/cool", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setMode(kCoolixCool);
        ac.send();
        request->send(200, "text/plain", "Cool Mode");
    });

    server.on("/mode/heat", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setMode(kCoolixHeat);
        ac.send();
        request->send(200, "text/plain", "Heat Mode");
    });

    server.on("/fan/low", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setFan(kCoolixFanMin);
        ac.send();
        request->send(200, "text/plain", "Fan Low");
    });

    server.on("/fan/med", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setFan(kCoolixFanMed);
        ac.send();
        request->send(200, "text/plain", "Fan Medium");
    });

    server.on("/fan/high", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setFan(kCoolixFanMax);
        ac.send();
        request->send(200, "text/plain", "Fan High");
    });

    server.on("/temp/up", HTTP_GET, [](AsyncWebServerRequest* request) {
        int temp = ac.getTemp();
        if (temp < 30) {
            ac.setTemp(temp + 1);
            ac.send();
        }
        request->send(200, "text/plain", "Temperature Up");
    });

    server.on("/temp/down", HTTP_GET, [](AsyncWebServerRequest* request) {
        int temp = ac.getTemp();
        if (temp > 17) {
            ac.setTemp(temp - 1);
            ac.send();
        }
        request->send(200, "text/plain", "Temperature Down");
    });

    server.on("/state/swing", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setSwing();
        ac.send();
        request->send(200, "text/plain", "Swing");
    });

    server.on("/state/led", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setLed();
        ac.send();
        request->send(200, "text/plain", "Toggle LED");
    });

    server.on("/state/turbo", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setTurbo();
        ac.send();
        request->send(200, "text/plain", "Turbo");
    });

    // Define routes to set specific temperature
    for (int temp = 17; temp <= 30; temp++) {
        String route = "/temp/set/" + String(temp);
        server.on(
            route.c_str(), HTTP_GET, [temp](AsyncWebServerRequest* request) {
                ac.setTemp(temp);
                ac.send();
                request->send(200, "text/plain",
                              "Temperature Set to " + String(temp) + " C");
            });
    }

    server.begin();
}

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("\nSetup start\n");

    setupDevices();
    setupWiFi();
    setupSinricPro();
    setupServer();

    Serial.println("\nSetup end\n");
}

void loop() {
    SinricPro.handle();

    int currentLightState = digitalRead(LIGHT_SWITCH_PIN);  // light
    if (currentLightState != previousLightState) {
        previousLightState = currentLightState;
        digitalWrite(LIGHT_RELAY_PIN, currentLightState);
    }

    int currentFanState = digitalRead(FAN_SWITCH_PIN);  // fan
    if (currentFanState != previousFanState) {
        previousFanState = currentFanState;
        digitalWrite(FAN_RELAY_PIN, currentFanState);
    }
}
