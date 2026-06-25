#include "WebServerModule.h"

#include <Arduino.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <WiFi.h>

#include "AcController.h"
#include "AcSwitchController.h"
#include "AppConfig.h"
#include "CloudService.h"
#include "RelayController.h"

namespace WebServerModule {
namespace {

AsyncWebServer server(80);
portMUX_TYPE lightColorCycleMux = portMUX_INITIALIZER_UNLOCKED;
bool lightColorCycleInProgress = false;

const char indexHtml[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#15100d">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="manifest" href="/manifest.webmanifest">
<title>ESP32</title>
<style>
:root{color-scheme:dark;--bg:#090706;--surface:rgba(28,22,19,.84);--surface-2:rgba(255,244,235,.055);--line:rgba(255,224,203,.12);--text:#fff5ed;--muted:#b39a88;--accent:#ff8a3d;--accent-soft:rgba(255,138,61,.15);--danger:#ff6258;--shadow:0 28px 70px rgba(0,0,0,.5)}
*{box-sizing:border-box}
html{min-height:100%;background:var(--bg)}
body{min-height:100dvh;margin:0;padding:10px;display:grid;place-items:center;background:radial-gradient(circle at 50% -15%,#4a2919 0,transparent 46%),linear-gradient(160deg,#17100c,#070504 72%);color:var(--text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-tap-highlight-color:transparent}
button{font:inherit;color:inherit;cursor:pointer;touch-action:manipulation}
button:focus-visible,.dial:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.remote{width:min(100%,390px);min-height:min(740px,calc(100dvh - 20px));padding:18px;border:1px solid var(--line);border-radius:32px;background:linear-gradient(145deg,rgba(35,26,22,.94),rgba(15,12,10,.97));box-shadow:var(--shadow),inset 0 1px 0 rgba(255,236,222,.08);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px)}
.topbar{height:34px;display:flex;align-items:center;gap:10px;margin-bottom:14px}.brand-icon{width:28px;height:28px}.room{font-size:13px;font-weight:750;letter-spacing:.13em}.connection{margin-left:auto;display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.08em}.connection-dot{width:7px;height:7px;border-radius:50%;background:#69584d;box-shadow:0 0 0 3px rgba(255,220,194,.07)}.connection.online .connection-dot{background:var(--accent);box-shadow:0 0 12px rgba(255,138,61,.6)}
.quick-grid{display:grid;grid-template-columns:1.12fr .92fr 1fr;gap:10px;margin-bottom:12px}.quick{min-height:50px;padding:0 10px;display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:16px;background:var(--surface-2);font-weight:650;box-shadow:0 3px 10px rgba(0,0,0,.06);transition:opacity .2s,background .2s,border-color .2s,color .2s}.quick svg{width:18px;flex:0 0 18px;color:var(--muted)}.quick span{font-size:13px;white-space:nowrap}.quick .switch{width:24px;height:14px;padding:2px;margin-left:auto;flex:0 0 24px;border-radius:10px;background:#453a34;transition:background .2s}.quick .switch::after{content:"";display:block;width:10px;height:10px;border-radius:50%;background:#ad9a8d;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s,background .2s}.quick.color-toggle{justify-content:center}.quick.active{border-color:rgba(255,138,61,.34);background:var(--accent-soft)}.quick.active svg{color:var(--accent)}.quick.active .switch{background:var(--accent)}.quick.active .switch::after{background:#25140b;transform:translateX(10px)}.quick:disabled{cursor:not-allowed;opacity:.45;transform:none}
.ac-panel{position:relative;padding:14px 12px 10px;border:1px solid var(--line);border-radius:25px;background:linear-gradient(150deg,rgba(255,241,231,.07),rgba(255,138,61,.018));box-shadow:inset 0 1px 0 rgba(255,238,226,.06);overflow:hidden}.panel-head{position:relative;z-index:2;display:flex;align-items:center;padding:0 3px}.eyebrow{font-size:10px;font-weight:800;letter-spacing:.16em;color:var(--muted)}.power{margin-left:auto;width:44px;height:44px;display:grid;place-items:center;border:1px solid rgba(255,98,88,.25);border-radius:50%;background:rgba(255,98,88,.08);color:var(--danger);transition:transform .15s,background .2s,box-shadow .2s}.power svg{width:20px}.power.active{color:#1c0d08;background:var(--danger);box-shadow:0 8px 22px rgba(255,98,88,.28)}.power:active,.step:active,.quick:active,.segment button:active,.feature:active{transform:scale(.96)}
.dial-wrap{height:250px;margin-top:-18px;display:grid;place-items:center}.dial{position:relative;width:250px;height:250px;border-radius:50%;cursor:grab;user-select:none;touch-action:none}.dial.dragging{cursor:grabbing}.dial svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.track{fill:none;stroke:rgba(255,230,213,.09);stroke-width:8;stroke-linecap:round;stroke-dasharray:75 25;transform:rotate(135deg);transform-origin:center}.progress{fill:none;stroke:var(--accent);stroke-width:8;stroke-linecap:round;filter:drop-shadow(0 0 7px rgba(255,138,61,.38));transform:rotate(135deg);transform-origin:center;transition:stroke-dasharray .18s ease}.tick{stroke:rgba(255,224,203,.25);stroke-width:1.5}.tick.active{stroke:var(--accent);stroke-width:2.5}.dial-center{position:absolute;inset:42px;display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid rgba(255,224,203,.08);border-radius:50%;background:radial-gradient(circle at 45% 35%,#2b211c,#0e0b09 74%);box-shadow:inset 0 1px 1px rgba(255,236,222,.07),0 15px 35px rgba(0,0,0,.38);pointer-events:none}.temperature{font-size:55px;font-weight:300;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.06em}.temperature sup{font-size:18px;vertical-align:top;margin-left:5px;color:var(--accent);letter-spacing:0}.state-line{margin-top:9px;color:var(--muted);font-size:10px;font-weight:800;letter-spacing:.14em}.limit{position:absolute;top:190px;color:var(--muted);font-size:10px;font-weight:700}.limit.min{left:20px}.limit.max{right:17px}
.stepper{width:132px;height:44px;margin:-25px auto 2px;padding:3px;position:relative;z-index:3;display:grid;grid-template-columns:1fr 1fr;gap:3px;border:1px solid rgba(255,224,203,.12);border-radius:15px;background:rgba(12,9,8,.84);box-shadow:0 8px 18px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,236,222,.05)}.stepper::after{content:"";position:absolute;left:50%;top:10px;width:1px;height:22px;background:rgba(255,224,203,.09);pointer-events:none}.step{display:grid;place-items:center;border:0;border-radius:10px;background:transparent;color:#d4bbaa;transition:background .18s,color .18s,transform .15s,box-shadow .18s}.step svg{width:18px;height:18px}.step:hover,.step:focus-visible{color:var(--accent);background:var(--accent-soft)}.step.pending{color:var(--accent);background:var(--accent-soft);box-shadow:inset 0 0 0 1px rgba(255,138,61,.18)}
.controls{display:grid;gap:10px;margin-top:12px}.control-row{display:grid;grid-template-columns:48px 1fr;align-items:center;gap:10px}.label{font-size:9px;font-weight:800;letter-spacing:.14em;color:var(--muted)}.segment{height:44px;padding:3px;display:grid;border:1px solid var(--line);border-radius:14px;background:rgba(0,0,0,.2)}.segment.two{grid-template-columns:1fr 1fr}.segment.three{grid-template-columns:repeat(3,1fr)}.segment button{border:0;border-radius:10px;background:transparent;color:var(--muted);font-size:12px;font-weight:700;transition:background .2s,color .2s,transform .15s}.segment button.active{background:rgba(255,138,61,.16);color:#fff5ed;box-shadow:0 3px 10px rgba(0,0,0,.22),inset 0 0 0 1px rgba(255,138,61,.1)}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.feature{min-height:45px;border:1px solid var(--line);border-radius:14px;background:rgba(255,240,229,.025);color:var(--muted);font-size:11px;font-weight:700;transition:background .2s,color .2s,transform .15s}.feature.active{background:var(--accent-soft);border-color:rgba(255,138,61,.3);color:var(--accent)}
.status{height:24px;margin-top:8px;display:flex;align-items:end;justify-content:center;color:var(--muted);font-size:10px;letter-spacing:.03em}.status.success{color:var(--accent)}.status.error{color:#ff8279}button.pending{cursor:wait}
@media(max-width:340px){body{padding:0}.remote{min-height:100dvh;border-radius:0;padding:14px}.quick-grid{gap:7px}.quick{padding:0 8px;gap:5px}.quick svg{width:17px;flex-basis:17px}.quick span{font-size:12px}.quick .switch{width:22px;height:13px;flex-basis:22px}.quick .switch::after{width:9px;height:9px}.quick.active .switch::after{transform:translateX(9px)}.dial-wrap{height:235px}.dial{width:235px;height:235px}.dial-center{inset:40px}.temperature{font-size:49px}.stepper{margin-top:-22px}.controls{margin-top:9px}}
@media(min-width:700px){body{padding:24px}.remote{min-height:0}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
</style>
</head>
<body>
<main class="remote">
  <header class="topbar">
    <img class="brand-icon" src="/favicon.svg" alt="">
    <span class="room">BEDROOM</span>
    <span class="connection" id="connection"><i class="connection-dot"></i><span id="connectionText">CONNECTING</span></span>
  </header>
  <section class="quick-grid" aria-label="Room controls">
    <button class="quick" id="light" data-command="/toggle-light" aria-pressed="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18h6M10 22h4M8.2 14.5A7 7 0 1 1 15.8 14.5C14.7 15.3 14.2 16 14 17h-4c-.2-1-.7-1.7-1.8-2.5Z"/></svg>
      <span>Light</span><i class="switch"></i>
    </button>
    <button class="quick color-toggle" id="color" data-command="/next-color" aria-pressed="false" disabled>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a9 9 0 1 0 9 9c0-1.2-.5-2-1.6-2h-2.1c-.9 0-1.6-.7-1.6-1.6V6.3C15.7 4.5 14.2 3 12 3Z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="14.3" cy="12.8" r="1"/><path d="M12 17h.01"/></svg>
      <span>Color</span>
    </button>
    <button class="quick" id="fan" data-command="/toggle-fan" aria-pressed="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="2"/><path d="M12 10c-1-4 0-7 2-7 3 0 4 5 1 8M14 12c4-1 7 0 7 2 0 3-5 4-8 1M12 14c1 4 0 7-2 7-3 0-4-5-1-8"/></svg>
      <span>Fan</span><i class="switch"></i>
    </button>
  </section>
  <section class="ac-panel" aria-labelledby="acTitle">
    <div class="panel-head"><span class="eyebrow" id="acTitle">AIR CONDITIONER</span>
      <button class="power" id="power" aria-label="Turn air conditioner on" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10M6.3 5.6a8 8 0 1 0 11.4 0"/></svg></button>
    </div>
    <div class="dial-wrap">
      <div class="dial" id="dial" role="slider" tabindex="0" aria-label="Target temperature" aria-valuemin="17" aria-valuemax="30" aria-valuenow="23" aria-valuetext="23 degrees Celsius">
        <svg viewBox="0 0 250 250" aria-hidden="true">
          <circle class="track" cx="125" cy="125" r="105" pathLength="100"/>
          <circle class="progress" id="progress" cx="125" cy="125" r="105" pathLength="100"/>
          <g id="ticks"></g>
        </svg>
        <span class="limit min">17</span><span class="limit max">30</span>
        <div class="dial-center"><div class="temperature"><span id="temperature">23</span><sup>°</sup></div><div class="state-line" id="stateLine">COOL · MED</div></div>
      </div>
    </div>
    <div class="stepper" aria-label="Temperature adjustment">
      <button class="step" data-command="/temp/down" aria-label="Decrease temperature by one degree"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 12h12"/></svg></button>
      <button class="step" data-command="/temp/up" aria-label="Increase temperature by one degree"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg></button>
    </div>
  </section>
  <section class="controls" aria-label="Air conditioner settings">
    <div class="control-row"><span class="label">MODE</span><div class="segment two"><button id="cool" data-command="/mode/cool">Cool</button><button data-command="/preset-ac">Preset</button></div></div>
    <div class="control-row"><span class="label">FAN</span><div class="segment three"><button id="fanLow" data-command="/fan/low">Low</button><button id="fanMed" data-command="/fan/med">Medium</button><button id="fanHigh" data-command="/fan/high">High</button></div></div>
  </section>
  <section class="features" aria-label="Additional controls">
    <button class="feature" id="swing" data-command="/state/swing" aria-pressed="false">Swing</button>
    <button class="feature" id="led" data-command="/state/led" aria-pressed="false">LED</button>
    <button class="feature" id="turbo" data-command="/state/turbo" aria-pressed="false">Turbo</button>
  </section>
  <div class="status" id="status" role="status" aria-live="polite">Ready</div>
</main>
<script>
const MIN=17,MAX=30,dial=document.getElementById('dial'),progress=document.getElementById('progress'),statusEl=document.getElementById('status');
let currentTemp=23,dragging=false,commitTimer=0,wheelTimer=0,state={};
function clamp(v){return Math.max(MIN,Math.min(MAX,Math.round(v)))}
function setTemperature(value,commit){currentTemp=clamp(value);const ratio=(currentTemp-MIN)/(MAX-MIN);document.getElementById('temperature').textContent=currentTemp;progress.style.strokeDasharray=(ratio*75)+' 100';dial.setAttribute('aria-valuenow',currentTemp);dial.setAttribute('aria-valuetext',currentTemp+' degrees Celsius');document.querySelectorAll('.tick').forEach((t,i)=>t.classList.toggle('active',i<=currentTemp-MIN));if(commit)scheduleTemperatureCommit()}
function scheduleTemperatureCommit(){clearTimeout(commitTimer);commitTimer=setTimeout(()=>sendCommand('/temp/set/'+currentTemp,'Set to '+currentTemp+' °C'),260)}
function buildTicks(){const group=document.getElementById('ticks');for(let i=0;i<=MAX-MIN;i++){const angle=(135+(270*i/(MAX-MIN)))*Math.PI/180;const x1=125+91*Math.cos(angle),y1=125+91*Math.sin(angle),x2=125+97*Math.cos(angle),y2=125+97*Math.sin(angle);const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',x1);line.setAttribute('y1',y1);line.setAttribute('x2',x2);line.setAttribute('y2',y2);line.classList.add('tick');group.appendChild(line)}}
function valueFromPointer(event){const rect=dial.getBoundingClientRect(),x=event.clientX-(rect.left+rect.width/2),y=event.clientY-(rect.top+rect.height/2);let angle=Math.atan2(y,x)*180/Math.PI;if(angle<0)angle+=360;let sweep=(angle-135+360)%360;if(sweep>270)sweep=sweep>315?0:270;return MIN+(sweep/270)*(MAX-MIN)}
function showStatus(message,type){statusEl.textContent=message;statusEl.className='status '+(type||'')}
async function sendCommand(path,message,source){showStatus('Sending…');if(source){source.classList.add('pending');source.setAttribute('aria-busy','true');source.disabled=true}try{const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw new Error(await response.text());showStatus('✓ '+(message||await response.text()),'success');setTimeout(loadState,300)}catch(error){showStatus('Could not send command','error')}finally{if(source){source.classList.remove('pending');source.removeAttribute('aria-busy');source.disabled=false}}}
function toggleClass(id,on){const el=document.getElementById(id);el.classList.toggle('active',!!on);if(el.hasAttribute('aria-pressed'))el.setAttribute('aria-pressed',on?'true':'false')}
function renderState(next){state=next;toggleClass('light',next.light);toggleClass('color',next.light);const color=document.getElementById('color');color.disabled=!next.light;color.setAttribute('aria-disabled',next.light?'false':'true');toggleClass('fan',next.fan);toggleClass('power',next.ac.power);toggleClass('swing',next.ac.swing);toggleClass('led',next.ac.led);toggleClass('turbo',next.ac.turbo);toggleClass('cool',(next.ac.mode||'').toLowerCase()==='cool');toggleClass('fanLow',next.ac.fanLevel===1);toggleClass('fanMed',next.ac.fanLevel===2);toggleClass('fanHigh',next.ac.fanLevel===3);document.getElementById('power').setAttribute('aria-label',next.ac.power?'Turn air conditioner off':'Turn air conditioner on');document.getElementById('stateLine').textContent=(next.ac.mode||'COOL').toUpperCase()+' · '+(['AUTO','LOW','MED','HIGH'][next.ac.fanLevel]||'AUTO');setTemperature(next.ac.temperature,false);const connection=document.getElementById('connection');connection.classList.toggle('online',next.connected);document.getElementById('connectionText').textContent=next.connected?'ONLINE':'LOCAL'}
async function loadState(){try{const response=await fetch('/api/state',{cache:'no-store'});if(!response.ok)throw new Error();renderState(await response.json())}catch(error){document.getElementById('connection').classList.remove('online');document.getElementById('connectionText').textContent='OFFLINE'}}
document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>sendCommand(button.dataset.command,'',button)));
document.getElementById('power').addEventListener('click',event=>sendCommand(state.ac&&state.ac.power?'/power/off':'/power/on','',event.currentTarget));
dial.addEventListener('pointerdown',event=>{dragging=true;dial.classList.add('dragging');dial.setPointerCapture(event.pointerId);setTemperature(valueFromPointer(event),false)});
dial.addEventListener('pointermove',event=>{if(dragging)setTemperature(valueFromPointer(event),false)});
dial.addEventListener('pointerup',event=>{if(!dragging)return;dragging=false;dial.classList.remove('dragging');dial.releasePointerCapture(event.pointerId);scheduleTemperatureCommit()});
dial.addEventListener('pointercancel',()=>{dragging=false;dial.classList.remove('dragging')});
dial.addEventListener('wheel',event=>{event.preventDefault();setTemperature(currentTemp+(event.deltaY<0?1:-1),false);clearTimeout(wheelTimer);wheelTimer=setTimeout(scheduleTemperatureCommit,180)},{passive:false});
dial.addEventListener('keydown',event=>{let change=0;if(event.key==='ArrowUp'||event.key==='ArrowRight')change=1;if(event.key==='ArrowDown'||event.key==='ArrowLeft')change=-1;if(event.key==='Home'){setTemperature(MIN,true);event.preventDefault()}else if(event.key==='End'){setTemperature(MAX,true);event.preventDefault()}else if(change){setTemperature(currentTemp+change,true);event.preventDefault()}});
buildTicks();setTemperature(currentTemp,false);loadState();setInterval(loadState,5000);
</script>
</body>
</html>
)rawliteral";

const char faviconSvg[] PROGMEM = R"svg(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="8" y1="5" x2="56" y2="59" gradientUnits="userSpaceOnUse"><stop stop-color="#f32335"/><stop offset="1" stop-color="#c90018"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#g)"/><rect x="15" y="16" width="34" height="32" rx="6" fill="none" stroke="#fff" stroke-width="3"/><rect x="22" y="23" width="20" height="18" rx="3" fill="#fff"/><path d="M20 11v7m8-7v7m8-7v7m8-7v7M20 46v7m8-7v7m8-7v7m8-7v7M10 24h7m-7 8h7m-7 8h7m30-16h7m-7 8h7m-7 8h7" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M27 28h10m-10 5h7m-7 5h9" stroke="#d90820" stroke-width="2" stroke-linecap="round"/></svg>)svg";

const char webManifest[] PROGMEM = R"json({"name":"ESP32","short_name":"ESP32","description":"Bedroom controls hosted by ESP32","start_url":"/","display":"standalone","background_color":"#090706","theme_color":"#15100d","icons":[{"src":"/favicon.svg","sizes":"any","type":"image/svg+xml","purpose":"any maskable"}]})json";

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

bool tryBeginLightColorCycle() {
  bool started = false;
  portENTER_CRITICAL(&lightColorCycleMux);
  if (!lightColorCycleInProgress) {
    lightColorCycleInProgress = true;
    started = true;
  }
  portEXIT_CRITICAL(&lightColorCycleMux);
  return started;
}

void finishLightColorCycle() {
  portENTER_CRITICAL(&lightColorCycleMux);
  lightColorCycleInProgress = false;
  portEXIT_CRITICAL(&lightColorCycleMux);
}

void sendAcCommandResult(AsyncWebServerRequest *request, const bool queued,
                         const String &message) {
  if (!queued) {
    request->send(503, "text/plain", "AC command queue full");
    return;
  }

  syncAcEvent(ControlSource::Http);
  sendPlainText(request, message);
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

  server.on("/favicon.svg", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send_P(200, "image/svg+xml", faviconSvg);
  });

  server.on("/manifest.webmanifest", HTTP_GET,
            [](AsyncWebServerRequest *request) {
              request->send_P(200, "application/manifest+json", webManifest);
            });

  server.on("/api/state", HTTP_GET, [](AsyncWebServerRequest *request) {
    const AcState acState = AcController::getState();
    String response;
    response.reserve(256);
    response += "{\"light\":";
    response += RelayController::getPower(RelayId::Light) ? "true" : "false";
    response += ",\"fan\":";
    response += RelayController::getPower(RelayId::Fan) ? "true" : "false";
    response += ",\"connected\":";
    response += WiFi.status() == WL_CONNECTED ? "true" : "false";
    response += ",\"ac\":{\"power\":";
    response += acState.power ? "true" : "false";
    response += ",\"mode\":\"" + AcController::thermostatModeName() + "\"";
    response += ",\"temperature\":" + String(acState.temperature);
    response += ",\"fanLevel\":" + String(acState.fanLevel);
    response += ",\"swing\":";
    response += acState.swing ? "true" : "false";
    response += ",\"led\":";
    response += acState.led ? "true" : "false";
    response += ",\"turbo\":";
    response += acState.turbo ? "true" : "false";
    response += "}}";
    AsyncWebServerResponse *serverResponse =
        request->beginResponse(200, "application/json", response);
    serverResponse->addHeader("Cache-Control", "no-store");
    request->send(serverResponse);
  });

  server.on("/diagnostics", HTTP_GET, [](AsyncWebServerRequest *request) {
    const IPAddress ip = WiFi.localIP();
    const AcController::Diagnostics acDiagnostics =
        AcController::getDiagnostics();
    const AcState acState = AcController::getState();
    const CloudService::CallbackStats callbacks =
        CloudService::getCallbackStats();
    String response;
    response.reserve(768);
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
    response += "callback_light_power=" + String(callbacks.lightPower) + "\n";
    response += "callback_fan_power=" + String(callbacks.fanPower) + "\n";
    response += "callback_ac_power=" + String(callbacks.acPower) + "\n";
    response += "callback_ac_range=" + String(callbacks.acRange) + "\n";
    response +=
        "callback_ac_adjust_range=" + String(callbacks.acAdjustRange) + "\n";
    response += "callback_ac_target_temperature=" +
                String(callbacks.acTargetTemperature) + "\n";
    response += "callback_ac_adjust_temperature=" +
                String(callbacks.acAdjustTemperature) + "\n";
    response += "callback_ac_mode=" + String(callbacks.acMode) + "\n";
    response +=
        "last_callback_at_ms=" + String(callbacks.lastCallbackAtMs) + "\n";
    response += "ac_executed_commands=" +
                String(acDiagnostics.executedCommands) + "\n";
    response +=
        "ac_ir_transmissions=" + String(acDiagnostics.irTransmissions) + "\n";
    response +=
        "ac_dropped_commands=" + String(acDiagnostics.droppedCommands) + "\n";
    response +=
        "ac_queued_commands=" + String(acDiagnostics.queuedCommands) + "\n";
    response += "ac_queue_high_water_mark=" +
                String(acDiagnostics.queueHighWaterMark) + "\n";
    response += "ac_worker_running=" +
                String(acDiagnostics.workerRunning ? "true" : "false") +
                "\n";
    response += "ac_last_command=" +
                String(AcController::commandTypeName(
                    acDiagnostics.lastCommand)) +
                "\n";
    response += "ac_last_ir_raw=0x" + String(acDiagnostics.lastIrRaw, HEX) +
                "\n";
    response += "ac_power=" + String(acState.power ? "true" : "false") +
                "\n";
    response += "ac_mode=" + AcController::thermostatModeName() + "\n";
    response += "ac_temperature=" + String(acState.temperature) + "\n";
    response += "ac_fan_level=" + String(acState.fanLevel) + "\n";
    response += "ac_physical_edges=" +
                String(AcSwitchController::getPhysicalEdgeCount()) + "\n";
    sendPlainText(request, response);
  });

  server.on("/toggle-light", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (RelayController::toggle(RelayId::Light, ControlSource::Http)) {
      syncRelayEvent(RelayId::Light, ControlSource::Http);
    }
    sendPlainText(request, "Light toggled");
  });

  server.on("/next-color", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (!tryBeginLightColorCycle()) {
      request->send(429, "text/plain",
                    "Light color change already in progress");
      return;
    }

    if (!RelayController::getPower(RelayId::Light)) {
      finishLightColorCycle();
      request->send(409, "text/plain", "Light is off");
      return;
    }

    RelayController::setPower(RelayId::Light, false, ControlSource::Http);
    delay(AppConfig::Timing::kLightColorCyclePulseMs);
    RelayController::setPower(RelayId::Light, true, ControlSource::Http);
    finishLightColorCycle();

    syncRelayEvent(RelayId::Light, ControlSource::Http);
    sendPlainText(request, "Light color advanced");
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
    sendAcCommandResult(request, AcController::setPower(true), "Power On");
  });

  server.on("/power/off", HTTP_GET, [](AsyncWebServerRequest *request) {
    sendAcCommandResult(request, AcController::setPower(false), "Power Off");
  });

  server.on("/preset-ac", HTTP_GET, [](AsyncWebServerRequest *request) {
    sendAcCommandResult(request, AcController::togglePreset(), "Preset AC");
  });

  server.on("/mode/cool", HTTP_GET, [](AsyncWebServerRequest *request) {
    sendAcCommandResult(request, AcController::setMode(kCoolixCool),
                        "Cool Mode");
  });

  server.on("/mode/heat", HTTP_GET, [](AsyncWebServerRequest *request) {
    sendAcCommandResult(request, AcController::setMode(kCoolixHeat),
                        "Heat Mode");
  });

  server.on("/fan/low", HTTP_GET, [](AsyncWebServerRequest *request) {
    sendAcCommandResult(request, AcController::setFanLevel(1), "Fan Low");
  });

  server.on("/fan/med", HTTP_GET, [](AsyncWebServerRequest *request) {
    sendAcCommandResult(request, AcController::setFanLevel(2), "Fan Medium");
  });

  server.on("/fan/high", HTTP_GET, [](AsyncWebServerRequest *request) {
    sendAcCommandResult(request, AcController::setFanLevel(3), "Fan High");
  });

  server.on("/temp/up", HTTP_GET, [](AsyncWebServerRequest *request) {
    float absoluteTemperature = 0;
    sendAcCommandResult(
        request, AcController::adjustTemperature(1.0f, absoluteTemperature),
        "Temperature Up");
  });

  server.on("/temp/down", HTTP_GET, [](AsyncWebServerRequest *request) {
    float absoluteTemperature = 0;
    sendAcCommandResult(
        request, AcController::adjustTemperature(-1.0f, absoluteTemperature),
        "Temperature Down");
  });

  server.on("/state/swing", HTTP_GET, [](AsyncWebServerRequest *request) {
    sendAcCommandResult(request, AcController::toggleSwing(), "Swing");
  });

  server.on("/state/led", HTTP_GET, [](AsyncWebServerRequest *request) {
    sendAcCommandResult(request, AcController::toggleLed(), "Toggle LED");
  });

  server.on("/state/turbo", HTTP_GET, [](AsyncWebServerRequest *request) {
    sendAcCommandResult(request, AcController::toggleTurbo(), "Turbo");
  });

  for (int temperature = AppConfig::AcDefaults::kMinTemperature;
       temperature <= AppConfig::AcDefaults::kMaxTemperature; ++temperature) {
    const String route = "/temp/set/" + String(temperature);
    server.on(route.c_str(), HTTP_GET,
              [temperature](AsyncWebServerRequest *request) {
                sendAcCommandResult(
                    request,
                    AcController::setTemperature(
                        static_cast<float>(temperature)),
                    "Temperature Set to " + String(temperature) + " C");
              });
  }

  server.begin();
}

}  // namespace WebServerModule
