/* globals Swal, apiUrl, REQ, setRoutePolyline, setBoatPosition, windLayer */

/* =========================================================
   Routing client + playback controller
   ========================================================= */

/**
 * @typedef {{lat:number, lon:number}} LatLon
 * @typedef {{lat:number, lon:number, t:number}} RoutePoint
 * @typedef {{t0Epoch:number, dtRoute:number, pts:RoutePoint[], gribName:string, currentGrib:string}} RouteData
 */

window.lastRouteData = null;        // raw JSON returned by REQ.ROUTING
window.lastCurrentGribFile = "";    // from last route response: "currentGrib"
window.lastGribFile = "";           // from last route response: "grib"

const routeParam = {
  initialAmure: 1,
  model: "GFS",
  timeStep: 7200,
  polar: "pol/class40VR.csv",
  wavePolar: "wavepol/polwave.csv",
  forbid: "false",
  isoc: "false",
  isodesc: "false",
  withWaves: "false",
  withCurrent: "true",
  xWind: 1,
  maxWind: 100,
  penalty0: 180,
  penalty1: 180,
  penalty2: 180,
  motorSpeed: 0,
  threshold: 0,
  dayEfficiency: 1,
  nightEfficiency: 1,
  staminaVR:100,
  cogStep: 5,
  cogRange: 90,
  jFactor: 0,
  kFactor: 1,
  nSectors: 720,
  constWindTws: 0,
  constWindTwd: 0,
  constWave: 0,
  constCurrentS: 0,
  constCurrentD: 0
};

/**
 * Encode waypoints array as "lat,lon;lat,lon;...".
 * @param {LatLon[]} wps
 * @returns {string}
 */
function encodeWaypoints(wps) {
  return wps.map(p => `${p.lat},${p.lon}`).join(";");
}

/**
 * Build server POST payload for REQ.ROUTING.
 * IMPORTANT: no URL encoding because server doesn't decode %xx.
 *
 * Uses settings from `state` for:
 *  - model, timeStep,  polar, wavePolar, currentGrib, forbid, withWaves, withCurrent
 *
 * Other parameters come from `routeParam`.
 *
 * @param {any} state - appState
 * @returns {string}
 */
function buildRoutePostBody(state) {
  const boatName = "banane";

  const boatStr = `boat=${boatName},${state.boat.lat},${state.boat.lon};`;
  const wpsStr = `waypoints=${encodeWaypoints(state.waypoints)}`;

  const parts = [];
  parts.push(`type=${REQ.ROUTING}`);
  parts.push(boatStr);
  parts.push(`epochStart=${state.startEpoch}`);
  parts.push(wpsStr);

  // ---- Settings from UI (⚙️ dialog) ----
  parts.push(`model=${state.model}`);                       // GFS | ECMWF | ARPEGE | UCMC | SYN
  parts.push(`timeStep=${state.timeStep}`);                 // 900 | 1800 | 3600 | 10800
  parts.push(`polar=${state.polar}`);                       // pol/<name>
  parts.push(`wavePolar=${state.wavePolar}`);               // wavepolar name
  parts.push(`currentGrib=${state.currentGrib}`);           // current grib name
  parts.push(`forbid=${state.forbid ? "true" : "false"}`);  // true | false
  parts.push(`withWaves=${state.withWaves ? "true" : "false"}`);  // true | false
  parts.push(`withCurrent=${state.withCurrent ? "true" : "false"}`);  // true | false
  parts.push(`xWind=${state.xWind}`);                       // expert parameter
  parts.push(`maxWind=${state.maxWind}`);                       // expert parameter
  parts.push(`penalty0=${state.penalty0}`);                       // expert parameter
  parts.push(`penalty1=${state.penalty1}`);                       // expert parameter
  parts.push(`penalty2=${state.penalty2}`);                       // expert parameter
  parts.push(`motorSpeed=${state.motorSpeed}`);                       // expert parameter
  parts.push(`threshold=${state.threshold}`);                       // expert parameter
  parts.push(`dayEfficiency=${state.dayEfficiency}`);                       // expert parameter
  parts.push(`nightEfficiency=${state.nightEfficiency}`);                       // expert parameter
  parts.push(`staminaVR=${state.staminaVR}`);                       // expert parameter
  parts.push(`initialAmure=${state.initialAmure}`);                       // expert parameter

  for (const [k, v] of Object.entries(routeParam)) {
    // IMPORTANT: do NOT duplicate parameters already set above
    if ([
      "model",
      "timeStep",
      "polar",
      "forbid",
      "withWaves",
      "withCurrent",
      "currentGrib",
      "wavePolar",
      "xWind",
      "maxWind",
      "penalty0",
      "penalty1",
      "penalty2",
      "motorSpeed",
      "threshold",
      "dayEfficiency",
      "nightEfficiency",
      "staminaVR",
      "initialAmure" // 0=st
    ].includes(k)) continue;

    parts.push(`${k}=${v}`);
  }

  return parts.join("&");
}

/**
 * Parse server routing response and extract minimal route data needed by client:
 * - epochStart
 * - isocTimeStep
 * - track => {lat,lon,t}
 * - grib name
 *
 * @param {any} json
 * @returns {RouteData}
 * @throws {Error} on server error or invalid response
 */
function parseRouteResponse(json) {
  if (!json || typeof json !== "object") {
    throw new Error("Invalid route response: not a JSON object");
  }

  if (json._Error) {
    throw new Error(`Server error: ${json._Error}`);
  }

  // Find first entry that looks like a boat result with a track
  let foundKey = null;
  for (const [k, v] of Object.entries(json)) {
    if (v && typeof v === "object" && Array.isArray(v.track) && v.track.length > 0) {
      foundKey = k;
      break;
    }
  }

  if (!foundKey) {
    const keys = Object.keys(json);
    const preview = JSON.stringify(json).slice(0, 800);
    throw new Error(`Invalid route response: missing track. Keys=${keys.join(", ")} Preview=${preview}`);
  }

  const r = json[foundKey];

  const t0Epoch = r.epochStart;
  const dtRoute = r.isocTimeStep;

  if (!Number.isFinite(t0Epoch) || !Number.isFinite(dtRoute)) {
    throw new Error("Invalid route response: missing epochStart/isocTimeStep");
  }

  const pts = r.track.map(row => ({ lat: row[1], lon: row[2], t: t0Epoch + row[3] }));
  const currentGrib = r.currentGrib || "";
  const gribName = r.grib || "";



  return { t0Epoch, dtRoute, pts, gribName, currentGrib };
}

/* =========================================================
   Player (global)
   ========================================================= */
/**
 * Simple route playback controller ("tape deck").
 */
window.player = (function makePlayer() {
  let timer = null;
  let playing = false;

  /** @type {RouteData|null} */
  let route = null;

  let k = 0;
  const stepMs = 300;

  function setIndex(newK) {
    if (!route) return;
    const kk = Math.max(0, Math.min(route.pts.length - 1, Number(newK)));
    k = kk;
    update();
  }

  /**
   * Attach a route to the player and reset position to beginning.
   * @param {RouteData} r
   * @returns {void}
   */
  function setRoute(r) {
    route = r;
    k = 0;
    syncSlider();
    update();
  }

  /**
   * Returns the first boat object stored in `lastRouteData` without assuming its name.
   *
   * @param {object} lastRouteData - The raw JSON object returned by the server (may contain multiple boats).
   * @returns {object|null} The first boat entry (e.g. lastRouteData["banane"]) or null if not found.
   */
  function getFirstBoatData(lastRouteData) {
    if (!lastRouteData || typeof lastRouteData !== "object") return null;

    const keys = Object.keys(lastRouteData);
    if (keys.length === 0) return null;

    const boat = lastRouteData[keys[0]];
    return (boat && typeof boat === "object") ? boat : null;
}

  /**
   * Extracts TWA (True Wind Angle) from `lastRouteData` for step index k.
   * According to your data layout, TWA is the 10th element in track[k] => index 9.
   *
   * @param {object} lastRouteData - The raw JSON object returned by the server.
   * @param {number} k - Step index in the track array.
   * @returns {number|null} TWA in degrees, or null if unavailable/out of range.
   */
  function getTwaFromLastRouteData(lastRouteData, k) {
    const boat = getFirstBoatData(lastRouteData);
    const track = boat?.track;

    if (!Array.isArray(track)) return null;
    if (!Number.isInteger(k) || k < 0 || k >= track.length) return null;

    const row = track[k];
    if (!Array.isArray(row) || row.length < 10) return null;

    const twa = row[9]; // 10th element
    return (typeof twa === "number" && Number.isFinite(twa)) ? twa : null;
  }

  /**
   * Updates the playback step:
   * - moves the boat marker to route.pts[k]
   * - updates the boat heading using the next point when available
   * - synchronizes and redraws the wind layer for the same step
   * - updates the status text and slider UI
   *
   * @returns {void}
   */
  let lastCap = 0;
  function update() {
    if (!route) return;

    const p = route.pts[k];
    const pNext = (k < route.pts.length - 1) ? route.pts[k+1] : null;
    const cap = pNext ? orthoCap(p.lat, p.lon, pNext.lat, pNext.lon) : lastCap;
    setBoatPosition(p.lat, p.lon);
    const twa = getTwaFromLastRouteData (window.lastRouteData, k);
    // console.log (JSON.stringify (window.lastRouteData));
    const tack = twa > 0 ? 0 : 1; // tribord=0, babord=1
    setBoatVisualState(cap, tack);
    lastCap = cap;

    windLayer.setRouteState({ t0Epoch: route.t0Epoch, dtRoute: route.dtRoute, k });
    windLayer.redraw();

    const s = document.getElementById("status");
    if (s) {
      const d = new Date(p.t * 1000);
      const model = appState.model ?? "";
      const polarShort = formatPolarName(appState.polar, 15);
      const boat = getFirstBoatData(lastRouteData);
      const waves = (boat.wavePolar && boat.wavePolar.length > 0) ? "W" : "";
      const curr = (boat.currentGrib && boat.currentGrib.length > 0) ? "C" :""
    
      s.innerHTML = `
        <div class="left">
          <span class="modelName"><b>${esc(model)} ${waves} ${curr}</b></span>
          <span class="polarName">${esc(polarShort)}</span>
        </div>
        <div class="right">
          ${esc(`${k + 1}/${route.pts.length}  ${dateToStr(d)}`)}
        </div>
      `;
    }
    syncSlider(); 
}

  function syncSlider() {
    const sl = document.getElementById("routeSlider");
    if (!sl) return;

    if (!route) {
      sl.min = "0";
      sl.max = "0";
      sl.value = "0";
      sl.disabled = true;
      return;
    }
    sl.disabled = false;
    sl.min = "0";
    sl.max = String(route.pts.length - 1);
    sl.value = String(k);
  }

  /** @returns {void} */
  function gotoBeg() {
    if (!route) return;
    k = 0;
    stop();
    update();
  }

  /** @returns {void} */
  function gotoEnd() {
    if (!route) return;
    k = route.pts.length - 1;
    stop();
    update();
  }

  /**
   * Step by +/-1.
   * @param {number} dir
   * @returns {void}
   */
  function step(dir) {
    if (!route) return;
    k = Math.max(0, Math.min(route.pts.length - 1, k + dir));
    update();
  }

  /** @returns {void} */
  function tick() {
    if (!route) return stop();
    if (k >= route.pts.length - 1) return stop();
    k++;
    update();
  }

  /** @returns {void} */
  function play() {
    if (!route || playing) return;
    playing = true;
    document.getElementById("btnPlay").textContent = "Pause";
    timer = setInterval(tick, stepMs);
  }

  /** @returns {void} */
  function stop() {
    playing = false;
    document.getElementById("btnPlay").textContent = "Play";
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** @returns {void} */
  function togglePlay() {
    playing ? stop() : play();
  }

  function reset() {
    stop();
    route = null;
    k = 0;
    const s = document.getElementById("status");
    if (s) s.textContent = "";
  }

  return { setRoute, gotoBeg, gotoEnd, step, togglePlay, reset, setIndex, syncSlider };
})();

/* =========================================================
   Compute route + load GRIB + draw wind
   ========================================================= */

/**
 * Compute route using REQ.ROUTING, render polyline + boat, then ensure GRIB is loaded and redraw wind.
 *
 * @param {any} state - appState (boat, waypoints, startEpoch, settings)
 * @returns {Promise<void>}
 * @throws {Error} on server errors or invalid responses
 */
window.computeRouteAndWind = async function computeRouteAndWind(state) {
  const body = buildRoutePostBody(state);
  const headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };

  const res = await fetch(apiUrl, { method: "POST", headers, body, cache: "no-store" });
  if (!res.ok) throw new Error(`Routing HTTP error ${res.status}`);


  const json = await res.json();
  const route = parseRouteResponse(json);

  window.lastRouteData = json;                          // store in globals
  window.lastCurrentGribFile = route.currentGrib || "";
  window.lastGribFile = route.gribName || "";

  // Draw route polyline
  const latlngs = route.pts.map(p => [p.lat, p.lon]);
  setRoutePolyline(latlngs);

  // Attach route to player
  window.player.setRoute(route);

  // Wind: cache + reload only if GRIB changed
  const model = state.model || routeParam.model;
  const routeGribName = route.gribName || "";
  const onlyUV = !!state.onlyUV;

  const cache = window.gribCache;
  const cachedName = cache && cache.key ? cache.key.split("/").slice(1).join("/").split("?")[0] : "";
  const needReload = routeGribName && cachedName && (cachedName !== routeGribName);

  const status = document.getElementById("status");
  if (status) status.textContent = needReload ? "Reloading GRIB…" : "";

  const { meta, field } = needReload
    ? await window.forceReloadGrib(model, routeGribName, onlyUV)
    : await window.ensureGribLoaded(model, routeGribName, onlyUV);

  windLayer.set(meta, field);
  windLayer.setRouteState({ t0Epoch: route.t0Epoch, dtRoute: route.dtRoute, k: 0 });
  windLayer.redraw();
};

