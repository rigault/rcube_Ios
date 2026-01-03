/* globals Swal, initMap, setLandGeoJson, setTapMode, setBoatFromGPS,
           setStartBoat, addWaypoint, undoWaypoint, clearWaypoints,
           computeRouteAndWind, player, ensureGribLoaded */

const geoFile = "geo/land_polygons.geojson";

// Remote (LAN) API
const apiUrl = "https://rcube.ddns.net/post-api/";

// REQ enum (server side aligned)
const REQ = {
  TEST: 0, ROUTING: 1, COORD: 2, FORBID_ZONE: 3, POLAR: 4,
  GRIB: 5, DIR: 6, PAR_RAW: 7, PAR_JSON: 8,
  INIT: 9, FEEDBACK: 10, DUMP_FILE: 11, NEAREST_PORT: 12,
  MARKS: 13, GRIB_CHECK: 14, GPX_ROUTE: 15, GRIB_DUMP: 16
};

// Expose globally for grib.js
window.apiUrl = apiUrl;
window.REQ = REQ;

/** @type {AppState} */
window.appState = {
  apiUrl,
  boat: { lat: null, lon: null },
  waypoints: [],
  startEpoch: null,
  model: "GFS",
  timeStep: 1800,
  //currentGrib: "",
  polar: "pol/class40VR.csv",
  wavePolar: "wavepol/polwave.csv",
  forbid: false,
  withWaves: false,
  withCurrent: false,
  onlyUV: true,
  xWind: 1.0,
  maxWind: 100,
  penalty0: 0,
  penalty1: 0,
  penalty2: 0,
  motorSpeed: 2.0,
  threshold: 2.0,
  dayEfficiency: 1.0,
  nightEfficiency: 1.0,
  staminaVR: 100,
  initialAmure: 0,
  coordFormat: "DMS"
};


/**
 * @typedef {Object} AppState
 * @property {string} apiUrl
 * @property {{lat:number|null, lon:number|null}} boat
 * @property {Array<{lat:number, lon:number}>} waypoints
 * @property {number|null} startEpoch
 * @property {"GFS"|"ECMWF"|"ARPEGE"|"UCMC"|"SYN"} model
 * @property {number} timeStep - seconds (900/1800/3600/10800)
 * @property {string} polar - "pol/<filename>"
 * @property {string} wavePolar - "pol/ve<filename>"
 * @property {boolean} forbid
 * @property {boolean} withWaves
 * @property {boolean} withCurrent
 * @property {boolean} onlyUV
 * @property {"DMS"|"DM"|"DD"|"BASIC"} coordFormat
 */

// ---- localStorage persistence (iOS/Safari friendly) ----

const STORAGE_KEY = "rcube:session:v1";

function saveSession(state) {
  try {
    const payload = {
      version: 1,
      savedAt: Date.now(),
      state
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (e) {
    console.warn("saveSession failed:", e);
    return false;
  }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object") return null;

    // If you want to handle future migrations:
    if (payload.version !== 1) {
      console.warn("Unknown session version:", payload.version);
      // return null; or migrate...
    }

    return payload.state ?? null;
  } catch (e) {
    console.warn("loadSession failed:", e);
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (e) {
    console.warn("clearSession failed:", e);
    return false;
  }
}


function lockIOSZoomForModal() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return () => {};

  const prev = meta.getAttribute("content") || "";

  // Preserve viewport-fit=cover if present
  const hasFitCover = /viewport-fit\s*=\s*cover/.test(prev);

  const locked = [
    "width=device-width",
    "initial-scale=1",
    "maximum-scale=1",
    "user-scalable=no",
    hasFitCover ? "viewport-fit=cover" : null
  ].filter(Boolean).join(", ");

  meta.setAttribute("content", locked);

  // Return unlock function restoring previous content
  return () => meta.setAttribute("content", prev);
}

/* =========================================================
   Time helpers
   ========================================================= */

/**
 * Build a datetime-local input value from current local time (yyyy-MM-ddThh:mm).
 * @returns {string}
 */
function nowToDatetimeLocalValue() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Convert a datetime-local value (e.g. "2025-12-19T18:30") to unix epoch seconds.
 * @param {string} v
 * @returns {number}
 */
function datetimeLocalToEpochSeconds(v) {
  return Math.floor(new Date(v).getTime() / 1000);
}

/* =========================================================
   Settings helpers
   ========================================================= */

const models = ["GFS", "ECMWF", "ARPEGE", "UCMC", "SYN"];

/**
 * Fetch list of available polars from server directory `pol` using REQ.DIR.
 * Server returns an array of [name, size, time], we keep only the name.
 *
 * @returns {Promise<string[]>}
 * @throws {Error}
 */
async function fetchPolarList(dir) {
  const body = `type=${REQ.DIR}&dir=${dir}&sortByName=true`;

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
    cache: "no-store"
  });

  if (!res.ok) throw new Error(`DIR HTTP error ${res.status}`);

  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error("Unexpected DIR response");

  return arr.map(x => x[0]).filter(Boolean);
}

/**
 * Opens the Expert Settings dialog.
 * Apply -> returns an object containing ONLY the edited fields (flat).
 * Back  -> returns null (no apply).
 *
 * @param {object} currentState - Current appState (flat settings).
 * @returns {Promise<object|null>}
 */
async function expertSettingsDialog(currentState) {
  const defaults = {
    xWind: 1.0,
    maxWind: 100,
    penalty0: 0,
    penalty1: 0,
    penalty2: 0,
    motorSpeed: 2.0,
    threshold: 2.0,
    dayEfficiency: 1.0,
    nightEfficiency: 1.0,
    staminaVR: 100,
    initialAmure: 0 // 0=starboard tribord, 1=port babord
  };

  const cur = { ...defaults, ...(currentState || {}) };
  const type = getDMSType ();
  const html = `
    <div class="settingsBox" style="text-align:left;display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;align-items:center;">
      <label><b>X Wind</b></label>
      <input id="exXWind" type="text" step="0.01" inputmode="decimal" value="${cur.xWind}"/>

      <label><b>Max Wind (kn)</b></label>
      <input id="exMaxWind" type="text" step="1" inputmode="numeric" value="${cur.maxWind}"/>

      <label><b>Tack (sec)</b></label>
      <input id="exTack" type="text" step="1" inputmode="numeric" value="${cur.penalty0}"/>

      <label><b>Gybe (sec)</b></label>
      <input id="exGybe" type="text" step="1" inputmode="numeric" value="${cur.penalty1}"/>

      <label><b>Sail Change (sec)</b></label>
      <input id="exSailChange" type="text" step="1" inputmode="numeric" value="${cur.penalty2}"/>

      <label><b>Motor Speed (kn)</b></label>
      <input id="exMotorSpeed" type="text" step="0.1" inputmode="decimal" value="${cur.motorSpeed}"/>

      <label><b>Threshold Motor (kn)</b></label>
      <input id="exMotorThreshold" type="text" step="0.1" inputmode="decimal" value="${cur.threshold}"/>

      <label><b>Day Efficiency</b></label>
      <input id="exDayEff" type="text" step="0.01" inputmode="decimal" value="${cur.dayEfficiency}"/>

      <label><b>Night Efficiency</b></label>
      <input id="exNightEff" type="text" step="0.01" inputmode="decimal" value="${cur.nightEfficiency}"/>

      <label><b>Stamina</b></label>
      <input id="exStamina" type="text" step="1" inputmode="numeric" value="${cur.staminaVR}"/>

      <label><b>Initial</b></label>
      <div style="display:flex;gap:14px;align-items:center;">
        <label style="display:flex;gap:6px;align-items:center;">
          <input type="radio" name="exInitialTack" value="0" ${cur.initialAmure === 0 ? "checked" : ""}/>
          <span style="color:#008000;">starb.</span>
        </label>
        <label style="display:flex;gap:6px;align-items:center;">
          <input type="radio" name="exInitialTack" value="1" ${cur.initialAmure === 1 ? "checked" : ""}/>
          <span style="color:#d00000;">port</span>
        </label>
      </div>
      <b>Boat Coord.</b></label>
      <input id="exCoord" type="text" value="${latLonToStr(cur.boat.lat, cur.boat.lon, type)}"/>
    </div>
  `;

  const result = await Swal.fire({
    title: "Expert settings",
    html,
    showCancelButton: true,
    confirmButtonText: "Apply",
    cancelButtonText: "Back",
    focusConfirm: false,
    inputAutoFocus: false,
    heightAuto: false,
    scrollbarPadding: false,
  
    didOpen: () => {
      // Lock iOS zoom while modal is open
      unlockZoom = lockIOSZoomForModal();
      // Prevent focus -> no keyboard + no auto zoom
      document.activeElement?.blur?.();
  
      // Focus popup itself (not an input)
      Swal.getPopup()?.setAttribute("tabindex", "-1");
      Swal.getPopup()?.focus({ preventScroll: true });
    },
    willClose: () => {
      if (typeof unlockZoom === "function") {
      unlockZoom();
      unlockZoom = null;
      }
      document.activeElement?.blur?.();
    },
    preConfirm: () => {
      const num = (id) => {
        const v = document.getElementById(id)?.value ?? "";
        const n = Number(String(v).replace(",", "."));
        return Number.isFinite(n) ? n : NaN;
      };
      const int = (id) => {
        const n = num(id);
        return Number.isFinite(n) ? Math.trunc(n) : NaN;
      };

      const xWind = num("exXWind");
      const maxWind = int("exMaxWind");
      const penalty0 = int("exTack");
      const penalty1 = int("exGybe");
      const penalty2 = int("exSailChange");
      const motorSpeed = num("exMotorSpeed");
      const threshold = num("exMotorThreshold");
      const dayEfficiency = num("exDayEff");
      const nightEfficiency = num("exNightEff");
      const staminaVR = int("exStamina");
      const initialAmureStr = document.querySelector('input[name="exInitialTack"]:checked')?.value;
      const initialAmure = (initialAmureStr === "1") ? 1 : 0;
      const exCoordStr = document.getElementById("exCoord").value;
      const [latDMS, lonDMS] = exCoordStr.split(' - ');
      const boat = {
        lat: dmsToDecimal(latDMS.trim()),
        lon: dmsToDecimal(lonDMS.trim()),
      };

      if (!Number.isFinite(xWind) || xWind <= 0) return Swal.showValidationMessage("X Wind must be a positive number.");
      if (!Number.isFinite(maxWind) || maxWind < 0) return Swal.showValidationMessage("Max Wind must be a non-negative integer.");
      if (!Number.isFinite(penalty0) || penalty0 < 0) return Swal.showValidationMessage("Tack (sec) must be a non-negative integer.");
      if (!Number.isFinite(penalty1) || penalty1 < 0) return Swal.showValidationMessage("Gybe (sec) must be a non-negative integer.");
      if (!Number.isFinite(penalty2) || penalty2 < 0) return Swal.showValidationMessage("Sail Change (sec) must be a non-negative integer.");
      if (!Number.isFinite(motorSpeed) || motorSpeed < 0) return Swal.showValidationMessage("Motor Speed must be a non-negative number.");
      if (!Number.isFinite(threshold) || threshold < 0) return Swal.showValidationMessage("Threshold Motor must be a non-negative number.");
      if (!Number.isFinite(dayEfficiency) || dayEfficiency <= 0) return Swal.showValidationMessage("Day Efficiency must be a positive number.");
      if (!Number.isFinite(nightEfficiency) || nightEfficiency <= 0) return Swal.showValidationMessage("Night Efficiency must be a positive number.");
      if (!Number.isFinite(staminaVR) || staminaVR < 0) return Swal.showValidationMessage("Stamina must be a non-negative integer.");

      return {
        xWind,
        maxWind,
        penalty0,
        penalty1,
        penalty2,
        motorSpeed,
        threshold,
        dayEfficiency,
        nightEfficiency,
        staminaVR,
        initialAmure,
        boat,
      };

    }
  });

  if (!result.isConfirmed) return null; // Back -> no apply
  return result.value;
}

/**
 * Build SweetAlert2 HTML content for Settings dialog.
 * @param {string[]} polarNames
 * @returns {string}
 */
function buildSettingsHtml(polarNames, wavePolarNames) {
  const stepOptions = [
    { label: "15 min", sec: 900 },
    { label: "30 min", sec: 1800 },
    { label: "1 h", sec: 3600 },
    { label: "3 h", sec: 10800 }
  ];

  const coordOptions = [
    { label: "DMS (48°51'24\"N)", val: "DMS" },
    { label: "DM  (48°51.40'N)", val: "DM" },
    { label: "DD  (48.8566° N)", val: "DD" },
    { label: "BASIC (-48.8566)", val: "BASIC" }
  ];

  const coordOpts = coordOptions.map(o =>
    `<option value="${o.val}" ${window.appState.coordFormat === o.val ? "selected" : ""}>${o.label}</option>`
  ).join("");


  const modelOpts = models.map(m =>
    `<option value="${m}" ${window.appState.model === m ? "selected" : ""}>${m}</option>`
  ).join("");

  const stepOpts = stepOptions.map(o =>
    `<option value="${o.sec}" ${window.appState.timeStep === o.sec ? "selected" : ""}>${o.label}</option>`
  ).join("");

  const currentPolarName = (window.appState.polar || "").replace(/^pol\//, "");
  const polarOpts = polarNames.map(name =>
    `<option value="${name}" ${currentPolarName === name ? "selected" : ""}>${name}</option>`
  ).join("");

  const currentWavePolarName = (window.appState.wavePolar || "").replace(/^wavepol\//, "");
  const wavePolarOpts = wavePolarNames.map(name =>
    `<option value="${name}" ${currentWavePolarName === name ? "selected" : ""}>${name}</option>`
  ).join("");

  const forbidChecked = window.appState.forbid ? "checked" : "";
  const wavesChecked = window.appState.withWaves ? "checked" : "";
  const currentChecked = window.appState.withCurrent ? "checked" : "";

  return `
  <div class="settingsBox" style="text-align:left;display:grid;gap:10px;">
    <div>
      <label><b>Model</b></label>
      <select id="setModel">${modelOpts}</select>
    </div>

    <div>
      <label><b>Time step</b></label>
      <select id="setTimeStep">${stepOpts}</select>
    </div>

    <div>
      <label><b>Polar</b></label>
      <select id="setPolar">${polarOpts}</select>
    </div>

    <div>
      <label><b>Wave Polar</b></label>
      <select id="setWavePolar">${wavePolarOpts}</select>
    </div>

    <div style="display:flex; gap:20px; align-items:center;">
      <label style="display:flex; gap:6px; align-items:center;">
        <input id="setForbid" type="checkbox" ${forbidChecked} />
        <b>forbid</b>
      </label>
    
      <label style="display:flex; gap:6px; align-items:center;">
        <input id="setWaves" type="checkbox" ${wavesChecked} />
        <b>waves</b>
      </label>
    
      <label style="display:flex; gap:6px; align-items:center;">
        <input id="setCurrent" type="checkbox" ${currentChecked} />
        <b>current</b>
      </label>
    </div>
    
    <div>
      <label><b>Coord format</b></label>
      <select id="setCoordFmt">${coordOpts}</select>
    </div>
  </div>`;
}

/**
 * Opens the "Settings" dialog.
 *
 * This dialog allows the user to configure routing parameters that will be
 * applied to the next route computation:
 *   - Weather model (GFS, ECMWF, ARPEGE, UCMC, SYN)
 *   - Routing time step (in seconds, selected via hours/minutes UI)
 *   - Wind polar file
 *   - Forbid zones flag
 *
 * Polar files are retrieved dynamically from the server using `REQ.DIR`.
 * If the polar list cannot be loaded, the dialog still opens with the currently
 * selected polar to ensure usability.
 *
 * The selected values are stored in `window.appState` when the user confirms
 * the dialog. No route is recomputed automatically; changes take effect on the
 * next "Compute" action.
 *
 * @async
 * @function openSettingsDialog
 * @returns {Promise<void>} Resolves when the dialog is closed.
 */
async function openSettingsDialog() {
  const allWays = true;
  while (allWays) {
    let polarNames = [];
    try {
      polarNames = await fetchPolarList("pol");
    } catch (e) {
      console.error(e);
      const cur = (window.appState.polar || "").replace(/^pol\//, "");
      polarNames = cur ? [cur] : [];
    }

    let wavePolarNames = [];
    try {
      wavePolarNames = await fetchPolarList("wavepol");
    } catch (e) {
      console.error(e);
      const cur = (window.appState.wavePolar || "").replace(/^wavepol\//, "");
      wavePolarNames = cur ? [cur] : [];
    }

    const result = await Swal.fire({
      title: "Settings",
      html: buildSettingsHtml(polarNames, wavePolarNames),
      focusConfirm: false,
      showCancelButton: true,
      showDenyButton: true,
      confirmButtonText: "Apply",
      denyButtonText: "More",
      cancelButtonText: "Cancel",
      preConfirm: () => ({
        model: document.getElementById("setModel").value,
        timeStep: Number(document.getElementById("setTimeStep").value),
        polar: `pol/${document.getElementById("setPolar").value}`,
        wavePolar: `wavepol/${document.getElementById("setWavePolar").value}`,
        forbid: document.getElementById("setForbid").checked,
        withWaves: document.getElementById("setWaves").checked,
        withCurrent: document.getElementById("setCurrent").checked,
        coordFormat: document.getElementById("setCoordFmt").value
      })
    });
    if (result.isDenied) {
      const updated = await expertSettingsDialog(window.appState);
      if (updated) {
        // Apply expert changes at the same level as appState
        Object.assign(window.appState, updated);
        setStartBoat(appState.boat.lat, appState.boat.lon); 
        redrawOrthoLines ();
        saveSession (window.appState);
      }
      // Always return to Settings
      continue;
    }
    if (result.isConfirmed) {
      Object.assign(window.appState, result.value);
      saveSession (window.appState);
      return; // Exit the whole settings flow
    }

    // Cancel -> exit the whole settings flow
    return;
  }
}

/** 
 * select Action based on menu proposal
 * @param {string} action
 */
function handleViewMenuAction(action) {
  switch (action) {
    case 'viewPolar':
      window.polarInfo(POL_TYPE.WIND_POLAR, window.appState.polar);
      break;
    case 'viewWavePolar':
      window.polarInfo(POL_TYPE.WAVE_POLAR, window.appState.wavePolar);
      break;
    case 'viewGribMeta':
      window.gribInfo("grib", window.appState.model, "");
      break;
    case 'viewCurrentGribMeta':
      window.gribInfo("currentgrib", "", window.lastCurrentGribFile);
      break;
    case 'viewRoute':
      window.showRouteReport(window.lastRouteData);
      break;
    case 'dumpRoute':
      window.dumpRoute(window.lastRouteData, getDMSType (), 1);
      break;
  }
}

/**
 * Opens a contextual "View" menu using SweetAlert2.
 *
 * The menu is displayed as an iOS-style settings list and allows the user
 * to select different visualization or diagnostic views.
 *
 * Each menu item triggers an action handled by {@link handleViewMenuAction}.
 *
 * @async
 * @function openViewMenu
 * @returns {Promise<void>} Resolves when the modal is closed.
 */
async function openViewMenu() {
  const html = `
    <div class="ios-settings" id="iosSettingsMenu">
      <div class="ios-item" data-action="viewPolar">
        <span class="ios-icon">📈</span><span class="ios-label">Polar View</span>
      </div>

      <div class="ios-item" data-action="viewWavePolar">
        <span class="ios-icon">🌊</span><span class="ios-label">Wave Polar View</span>
      </div>

      <div class="ios-separator"></div>

      <div class="ios-item" data-action="viewGribMeta">
        <span class="ios-icon">🧾</span><span class="ios-label">Grib Meta</span>
      </div>

      <div class="ios-item" data-action="viewCurrentGribMeta">
        <span class="ios-icon">🌀</span><span class="ios-label">Current Grib Meta</span>
      </div>

      <div class="ios-separator"></div>

      <div class="ios-item" data-action="viewRoute">
        <span class="ios-icon">🗺️</span><span class="ios-label">Route View</span>
      </div>

      <div class="ios-item" data-action="dumpRoute">
        <span class="ios-icon">📤</span><span class="ios-label">Route Dump</span>
      </div>
    </div>
  `;

  await Swal.fire({
    html,
    showConfirmButton: false,
    showCancelButton: true,
    cancelButtonText: 'Cancel',
    customClass: { popup: 'ios-popup' },

    didOpen: (popup) => {
      const menu = popup.querySelector('#iosSettingsMenu');
      if (!menu) return;

      // One listener for all items (robust, fast)
      menu.addEventListener('click', (e) => {
        const item = e.target.closest('.ios-item');
        if (!item) return;

        const action = item.dataset.action;
        // debug: vérifie que ça clique bien
        // alert(action);

        Swal.close();
        handleViewMenuAction(action);
      });
    }
  });
}

/**
 * Builds the HTML content for the Help dialog.
 *
 * The content has two modes:
 * - short mode: header only (application name, version, copyright)
 * - full mode: header + additional technical information returned by the server
 *
 * @param {object} data - JSON object returned by the server for REQ.TEST.
 * @param {boolean} full - Whether to include the full technical information.
 * @returns {string} HTML string to be injected into a SweetAlert2 dialog.
 */
function helpInfoHtml(data, full) {
  const head = `
    <style>
      .swal-links { color:#444; text-decoration:none; font-weight:bold; }
      .swal-links:hover { text-decoration:underline; color:#222; }
    </style>
    <strong>Rcube:</strong><br>
    <strong>Version:</strong> 1.0.0<br><br>
    <strong>© 2025 rene.rigault@wanadoo.fr</strong><br><br>
  `;

  const bodyFull = `
    <strong>from server:</strong><br>
    ${data["Prog-version"]}<br>
    GRIB Wind Memory: ${data["Memory for Grib Wind"]}<br>
    GRIB Current Memory: ${data["Memory for Grib Current"]}<br>
    Memory usage in KB: ${data["Memory usage in KB"]}<br>
    Compilation-date: ${data["Compilation-date"]}<br>
  `;

  return full ? head + bodyFull : head; // court = seulement l'en-tête
}

/**
 ! Request Help file and return it
 */
async function loadHelp4IosHtml() {
  const r = await fetch("help4Ios.html", { cache: "no-store" });
  if (!r.ok) throw new Error(`Cannot load help4Ios.html (HTTP ${r.status})`);
  return await r.text();
}


/**
 * Requests help information from the server and displays it using SweetAlert2.
 *
 * Behavior:
 * - "More" / "Less" toggles the amount of information shown (short vs full).
 * - "Doc" loads and displays the local help documentation (help4Ios.html)
 *   inside a second SweetAlert2 dialog.
 * - "Back" always returns to the previous Help dialog state.
 *
 * This function is designed to work reliably on iOS (Safari):
 * - avoids window.open()
 * - uses scrollable SweetAlert2 content
 * - preserves navigation flow between Help and Documentation dialogs
 *
 * @param {boolean} [full=false] - Initial display mode (false = short, true = full).
 * @returns {Promise<void>}
 */
/*async function openHelpInfo (full = false) {
   const formData = `type=${REQ.TEST}`;
   const headers = { "Content-Type": "application/x-www-form-urlencoded" };
   console.log ("Request sent:", formData);
   fetch (apiUrl, {
      method: "POST",
      headers,
      body: formData,
      cache: "no-store"
   })
   .then(response => response.json())
   .then(data => {
      console.log (JSON.stringify(data));
      // Dialog box display
      Swal.fire({
         title: "Help Info",
         html:  helpInfoHtml(data, full),
         icon: "info",
         showCancelButton: true,
         confirmButtonText: full ? "Less" : "More",
         showDenyButton: true,
         denyButtonText: "Doc",
         customClass: { popup: "swal-wide" },
      }).then((result) => {
         if (result.isConfirmed) openHelpInfo(!full);
         if (result.isDenied) window.open (`help4Ios.html`);
      });
   })
   .catch (error => {
      console.error("Error requesting help:", error);
      Swal.fire("Erreur", "Impossible to access server", "error");
   });
}
*/
async function openHelpInfo(full = false) {
  const formData = `type=${REQ.TEST}`;
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  console.log("Request sent:", formData);

  fetch(apiUrl, {
    method: "POST",
    headers,
    body: formData,
    cache: "no-store"
  })
  .then(response => response.json())
  .then(data => {
    console.log(JSON.stringify(data));

    Swal.fire({
      title: "Help Info",
      html: helpInfoHtml(data, full),
      icon: "info",
      showCancelButton: true,
      cancelButtonText: "Back",
      confirmButtonText: full ? "Less" : "More",
      showDenyButton: true,
      denyButtonText: "Doc",
      customClass: { popup: "swal-wide" },

      // iOS friendliness
      heightAuto: false,
      scrollbarPadding: false
    })
    .then(async (result) => {
      if (result.isConfirmed) {
        openHelpInfo(!full);
        return;
      }

      if (result.isDenied) {
        try {
          const docHtml = await loadHelp4IosHtml();

          // Show doc in a Swal (scrollable)
          const docRes = await Swal.fire({
            title: "Documentation",
            html: `<div style="max-height:60vh;overflow:auto;-webkit-overflow-scrolling:touch;">${docHtml}</div>`,
            icon: "info",
            showCancelButton: true,
            cancelButtonText: "Back",
            showConfirmButton: false,
            customClass: { popup: "swal-wide" },
            heightAuto: false,
            scrollbarPadding: false
          });

          // Back (cancel/dismiss) -> reopen help at same full/less state
          if (docRes.isDismissed) openHelpInfo(full);

        } catch (e) {
          console.error(e);
          Swal.fire("Erreur", "Impossible de charger la documentation", "error");
        }
      }
      // Cancel (Back) on Help -> do nothing (caller decides what to show next)
    });
  })
  .catch(error => {
    console.error("Error requesting help:", error);
    Swal.fire("Erreur", "Impossible to access server", "error");
  });
}

window.redrawAllWaypoints = function () {
  // Supprimer tous les markers existants
  /*for (const m of wpMarkers) {
    map.removeLayer(m);
  }
  wpMarkers.length = 0;
*/
  // Recréer les markers depuis l'état
  for (const wp of appState.waypoints) {
    addWaypoint(wp.lat, wp.lon);
  }
};


/* =========================================================
   Main
   ========================================================= */

document.addEventListener("DOMContentLoaded", async () => {
  Swal.fire({
    title: "Map Loading…",
    didOpen: () => Swal.showLoading(),
    allowOutsideClick: false,
    showConfirmButton: false
  });
  initMap();
  await setLandGeoJson(geoFile);
  Swal.update({ title: "Grib Loading…" });
  Swal.showLoading();
  const saved = loadSession();
  if (saved) {
    appState = { ...appState, ...saved };
    setStartBoat(saved.boat.lat, saved.boat.lon); 
    clearWaypoints (); // yes not elegant. We clear all way points then add all waypoints
    for (const wp of saved.waypoints) {
      addWaypoint(wp.lat, wp.lon);
    }
  }
  await drawForbidZones();
  // V1.1: preload GRIB once (lighter if onlyUV=true)
  try {
    await ensureGribLoaded(window.appState.model, "", window.appState.onlyUV);
  } catch (e) {
    console.error(e);
  }
  if (Swal.isVisible()) Swal.close();

  const startTime = document.getElementById("startTime");
  startTime.value = nowToDatetimeLocalValue();

  document.getElementById("btnGps").addEventListener("click", async () => {
    try {
      const pos = await setBoatFromGPS();
      window.appState.boat = pos;
    } catch (e) {
      Swal.fire("GPS error", e.message || String(e), "error");
    }
  });

  document.getElementById("btnBoatTap").addEventListener("click", () => {
    setTapMode("boat");
    document.getElementById("btnBoatTap").classList.add("btnOn");
    document.getElementById("btnWpTap").classList.remove("btnOn");
  });

  document.getElementById("btnWpTap").addEventListener("click", () => {
    setTapMode("wp");
    document.getElementById("btnWpTap").classList.add("btnOn");
    document.getElementById("btnBoatTap").classList.remove("btnOn");
  });

  document.getElementById("btnSettings").addEventListener("click", () => {
    openSettingsDialog().catch(e =>
      Swal.fire("Settings error", e.message || String(e), "error")
    );
  });

  document.getElementById("btnView").addEventListener("click", () => {
    openViewMenu().catch(err => {
      console.error(err);
      Swal.fire("View error", err.message || String(err), "error");
    });
  });

  document.getElementById("btnHelp").addEventListener("click", () => {
    openHelpInfo().catch(err => {
      console.error(err);
      Swal.fire("Help info error", err.message || String(err), "error");
    });
  });

  document.getElementById("btnUndoWp").addEventListener("click", undoWaypoint);
  document.getElementById("btnClearWp").addEventListener("click", clearWaypoints);

  document.getElementById("btnCompute").addEventListener("click", async () => {
    const v = startTime.value;
    if (!v) return Swal.fire("Missing start date", "", "warning");

    window.appState.startEpoch = datetimeLocalToEpochSeconds(v);

    if (!Number.isFinite(window.appState.boat.lat)) {
      return Swal.fire("Boat position missing", "", "warning");
    }
    if (window.appState.waypoints.length < 1) {
      return Swal.fire("Waypoints missing", "", "warning");
    }

    try {
      window.player.gotoBeg (); // force update
      await computeRouteAndWind(window.appState);
    } catch (e) {
      Swal.fire("Compute error", e.message || String(e), "error");
    }
  });

  // Player controls
  document.getElementById("btnBeg").addEventListener("click", player.gotoBeg);
  document.getElementById("btnEnd").addEventListener("click", player.gotoEnd);
  document.getElementById("btnPrev").addEventListener("click", () => player.step(-1));
  document.getElementById("btnNext").addEventListener("click", () => player.step(+1));
  document.getElementById("btnPlay").addEventListener("click", player.togglePlay);

  const slider = document.getElementById("routeSlider");
  if (slider) {
    slider.addEventListener("input", (e) => {
      if (!window.lastRouteData) { // slider can be used only if a route is calculared
         e.target.value = 0;       // optionnal: reset
         return;
      }
      const v = Number(e.target.value);
      if (window.player && window.player.setIndex) window.player.setIndex(v);
    });
  }

  setTapMode("boat");

  // add ports
  initPorts (map, ports);
});

