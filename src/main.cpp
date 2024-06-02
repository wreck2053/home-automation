#include <Arduino.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <IRsend.h>
#include <SinricPro.h>
#include <SinricProSwitch.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ir_Coolix.h>

#define WIFI_SSID "Rahul"
#define WIFI_PASS "chennai@123"

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

void setupSinricPro() {
    // add devices and callbacks to SinricPro
    SinricProSwitch& lightSwitch = SinricPro[SWITCH_ID_LIGHT];
    lightSwitch.onPowerState(onPowerStateLight);

    SinricProSwitch& fanSwitch = SinricPro[SWITCH_ID_FAN];
    fanSwitch.onPowerState(onPowerStateFan);

    SinricPro.onConnected([]() {
        Serial.printf("Connected to SinricPro\r\n");
        digitalWrite(LED_BUILTIN, HIGH);
    });

    SinricPro.onDisconnected([]() {
        Serial.printf("Disconnected from SinricPro\r\n");
        digitalWrite(LED_BUILTIN, LOW);
    });

    SinricPro.begin(APP_KEY, APP_SECRET);
}

void setupServer() {
    // Route for root / web page
    server.on("/", HTTP_GET, [](AsyncWebServerRequest* request) {
        request->send(
            200, "text/html",
            "<h1>NodeMCU-32S Server</h1>"
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
            "<button onclick=\"sendCommand('/mode/heat')\">Heat Mode</button>"
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

            "<br>"

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
            "</script>");
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

    // Define routes to handle control requests
    server.on("/power/on", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setPower(true);
        ac.send();
        request->send(200, "text/plain", "Power On");
    });

    server.on("/power/off", HTTP_GET, [](AsyncWebServerRequest* request) {
        ac.setPower(false);
        ac.send();
        request->send(200, "text/plain", "Power Off");
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

void checkConnections() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("Wi-Fi disconnected, reconnecting...");
        setupWiFi();
    } else {
        Serial.println("Wi-Fi connected");
        Serial.print("IP address: ");
        Serial.println(WiFi.localIP());
    }
    if (!SinricPro.isConnected()) {
        Serial.println("SinricPro disconnected, reconnecting...");
    } else {
        Serial.println("SinricPro connected");
    }
    Serial.println("-------------------------------------------");
}

void setup() {
    Serial.begin(9600);
    delay(1000);

    Serial.println("\nSetup start\n");

    setupDevices();
    setupWiFi();
    setupSinricPro();
    setupServer();

    Serial.println("\nSetup end\n");
}

unsigned long lastCheckTime = 0;
const unsigned long checkInterval = 60000;

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

    unsigned long currentTime = millis();
    if (currentTime - lastCheckTime >= checkInterval) {
        lastCheckTime = currentTime;
        checkConnections();
    }
}
