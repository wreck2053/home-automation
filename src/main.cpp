#include <Arduino.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <SinricPro.h>
#include <SinricProSwitch.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#define WIFI_SSID "Rahul"
#define WIFI_PASS "chennai@123"

#define APP_KEY "12fbb630-3465-4e47-a312-7888355266b4"
#define APP_SECRET                                                  \
    "1b0bc916-d160-419e-9beb-fd2935a5ddbc-13efd354-02a6-4a0b-8e5c-" \
    "1765edb0b078"

#define LIGHT_RELAY_PIN 5
#define SWITCH_ID_LIGHT "664268b26443b9bfe2b8d715"

AsyncWebServer server(80);

void setupDevices() {
    pinMode(BUILTIN_LED, OUTPUT);
    pinMode(LIGHT_RELAY_PIN, OUTPUT);
}

void setupWiFi() {
    Serial.println(WIFI_SSID);
    Serial.println(WIFI_PASS);

    Serial.print("\nConnecting to Wi-Fi...");
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("");
    Serial.println("Wi-Fi connected");
    Serial.print("IP address: ");
    Serial.println(WiFi.localIP());
}

bool onPowerStateLight(const String& deviceId, bool& state) {
    Serial.printf("Light turned %s\n", state ? "on" : "off");
    digitalWrite(LIGHT_RELAY_PIN, state ? HIGH : LOW);
    return true;
}

void setupSinricPro() {
    // add devices and callbacks to SinricPro
    SinricProSwitch& lightSwitch = SinricPro[SWITCH_ID_LIGHT];
    lightSwitch.onPowerState(onPowerStateLight);

    // setup SinricPro
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
            "<h1>ESP32 Server</h1><button onclick=\"toggleSwitch()\">Toggle "
            "Switch</button><script>function toggleSwitch() {var xhr = new "
            "XMLHttpRequest();xhr.open('GET', '/toggle', "
            "true);xhr.send();}</script>");
    });

    // Route to handle LED toggle
    server.on("/toggle", HTTP_GET, [](AsyncWebServerRequest* request) {
        digitalWrite(LIGHT_RELAY_PIN, !digitalRead(LIGHT_RELAY_PIN));
        request->send(200, "text/plain", "LED toggled");
    });

    server.begin();
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

void loop() { SinricPro.handle(); }
