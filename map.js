/* globals L, appState, addWaypoint */

/* =========================================================
   Leaflet map layer for rcube iOS client
   Public API is exposed via window.*
   ========================================================= */

let map;
let landLayer;

let boatMarker;
let wpMarkers = [];
let routeLine;

let windPane;
let windCanvas;

let tapMode = "boat"; // "boat" or "wp"

let orthoLines = []; // Leaflet polylines for great-circle segments

function fmtNm(x) { return Number.isFinite(x) ? `${x.toFixed(2)} nm` : "—"; }
function fmtDeg(x) { return Number.isFinite(x) ? `${x.toFixed(0)}°` : "—"; }

/** @type {L.LayerGroup|null} */
let forbidZonesLayer = null;

/**
 * Fetch and draw forbidden zones polygons from the server (type=3).
 * Each polygon is an array of [lat, lon] points.
 */
window.drawForbidZones = async function drawForbidZones() {
  try {
    // Remove previous forbid zones layer if any
    if (forbidZonesLayer) {
      map.removeLayer(forbidZonesLayer);
      forbidZonesLayer = null;
    }

    // POST request (form-urlencoded)
    const res = await fetch("https://rcube.ddns.net/post-api/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: `type=${REQ.FORBID_ZONE}`,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    /** @type {Array<Array<[number, number]>>} */
    const polygons = await res.json();

    // Create a new layer group for all forbid zones
    forbidZonesLayer = L.layerGroup();

    polygons.forEach((poly, i) => {
      if (!Array.isArray(poly) || poly.length < 3) return;

      // Remove invalid points and consecutive duplicates
      const latlngs = [];
      let prev = null;

      for (const p of poly) {
        if (!Array.isArray(p) || p.length < 2) continue;

        const lat = Number(p[0]);
        const lon = Number(p[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const cur = [lat, lon];
        if (!prev || prev[0] !== cur[0] || prev[1] !== cur[1]) {
          latlngs.push(cur);
          prev = cur;
        }
      }

      if (latlngs.length < 3) return;

      // Create and style the polygon
      const leafletPoly = L.polygon(latlngs, {
        weight: 2,
        opacity: 0.9,
        fillOpacity: 0.25,
      });

      // Optional popup
      leafletPoly.bindPopup(`Forbid zone #${i + 1}`);

      leafletPoly.addTo(forbidZonesLayer);
    });

    // Add all forbid zones to the map
    forbidZonesLayer.addTo(map);

    return forbidZonesLayer;
  } catch (err) {
    console.error("drawForbidZones error:", err);
    return null;
  }
};

/**
 * Rebuild and render orthodromic (great-circle) segments:
 * Boat->WP1, WP1->WP2, ...
 *
 * @returns {void}
 */
function redrawOrthoLines() {
  // Remove old lines
  orthoLines.forEach(l => l.remove());
  orthoLines = [];

  const boat = appState.boat;
  const hasBoat = Number.isFinite(boat.lat) && Number.isFinite(boat.lon);
  if (!hasBoat) return;

  const wps = appState.waypoints;
  if (!wps || wps.length === 0) return;

  // Build segments
  let prev = { lat: boat.lat, lon: boat.lon };

  for (let i = 0; i < wps.length; i++) {
    const wp = wps[i];
    if (!Number.isFinite(wp.lat) || !Number.isFinite(wp.lon)) continue;

    const path = getGreatCirclePath(prev.lat, prev.lon, wp.lat, wp.lon, 80);

    const line = L.polyline(path, {
      color: "yellow",
      weight: 2,
      opacity: 0.9
    }).addTo(map);

    orthoLines.push(line);
    prev = wp;
  }
  const headingDeg = orthoCap(boat.lat, boat.lon, wps[0].lat, wps[0].lon);
  const tack = Number.isFinite(boat.tack) ? boat.tack : 0;
  window.setBoatVisualState(headingDeg, tack);
}

/**
 * Builds the HTML content of the popup associated with a waypoint.
 *
 * The popup displays:
 *  - Waypoint index (1-based)
 *  - Waypoint coordinates formatted according to user settings
 *    (DMS / DM / DD / BASIC via appState.coordFormat)
 *  - Orthodromic (great-circle) distance from the boat (start)
 *  - Orthodromic distance from the previous point
 *    (previous waypoint, or boat if this is the first waypoint)
 *  - Initial orthodromic bearing from the previous point to this waypoint
 *
 * All distances are expressed in nautical miles.
 * All bearings are expressed in degrees [0..360).
 *
 * This function is intentionally side-effect free:
 * it only reads `appState` and does not modify map state.
 *
 * It is typically used via `marker.bindPopup(() => buildWaypointPopupHtml(i))`
 * so that values are recomputed dynamically when the popup is opened.
 *
 * @function buildWaypointPopupHtml
 * @param {number} iWp
 *        Zero-based index of the waypoint in `appState.waypoints`.
 *
 * @returns {string}
 *        HTML string to be used as Leaflet popup content.
 */
function buildWaypointPopupHtml(iWp /* 0-based */) {
  const idx = iWp + 1;
  const wp = appState.waypoints[iWp];
  const boat = appState.boat;

  const hasBoat = Number.isFinite(boat.lat) && Number.isFinite(boat.lon);

  // previous point: previous WP if exists, else boat if defined
  let prev = null;
  if (iWp >= 1) prev = appState.waypoints[iWp - 1];
  else if (hasBoat) prev = boat;

  let distFromStart = NaN;
  let distFromPrev = NaN;

  distFromStart = cumulativeDistToWp(iWp);

  if (prev && Number.isFinite(prev.lat) && Number.isFinite(prev.lon)) {
    distFromPrev = orthoDist(prev.lat, prev.lon, wp.lat, wp.lon);
  }

  const type = getDMSType ();
  const posStr = (Number.isFinite(wp.lat) && Number.isFinite(wp.lon))
     ? latLonToStr(wp.lat, wp.lon, type)
    : "—";

  return `
    <div style="font-size:13px;line-height:1.35; min-width: 180px;">
      <div><b>Waypoint ${idx}</b></div>
      <div style="opacity:.85;">${posStr}</div>
      <hr style="border:none;border-top:1px solid rgba(0,0,0,.12); margin:8px 0;" />
      <div>From start: <b>${fmtNm(distFromStart)}</b></div>
      <div>From prev: <b>${fmtNm(distFromPrev)}</b></div>
    </div>
  `;
}

/**
 * Computes the cumulative orthodromic distance from the boat start position
 * to the waypoint at index `iWp`.
 *
 * The distance is the sum of great-circle (orthodromic) distances for each
 * segment:
 *   boat → wp[0] → wp[1] → ... → wp[iWp]
 *
 * @param {number} iWp - Index of the waypoint in appState.waypoints.
 * @returns {number} Cumulative distance in nautical miles,
 *                   or NaN if boat position or waypoints are invalid.
 */
function cumulativeDistToWp(iWp) {
  const boat = appState.boat;
  const wps = appState.waypoints;

  if (!Number.isFinite(boat.lat) || !Number.isFinite(boat.lon)) return NaN;
  if (!Array.isArray(wps) || iWp < 0 || iWp >= wps.length) return NaN;

  let sum = 0;
  let prev = { lat: boat.lat, lon: boat.lon };

  for (let i = 0; i <= iWp; i++) {
    const wp = wps[i];
    if (!Number.isFinite(wp.lat) || !Number.isFinite(wp.lon)) return NaN;
    sum += orthoDist(prev.lat, prev.lon, wp.lat, wp.lon);
    prev = wp;
  }
  return sum;
}

/**
 * Initialize Leaflet map, create wind canvas pane, and bind map handlers.
 * Exposes `window.map` and `window.windCanvas`.
 *
 * @returns {void}
 */
window.initMap = function initMap() {
  map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([41.2, -16.8], 6);

  // Custom pane for wind (below markers)
  windPane = map.createPane("windPane");
  windPane.style.zIndex = 350; // above base layers, below overlays/markers
  windCanvas = L.DomUtil.create("canvas", "wind-canvas", windPane);
  windCanvas.style.position = "absolute";
  windCanvas.style.pointerEvents = "none";

  // Wire wind layer redraw triggers
  map.on("moveend zoomend resize", () => {
    if (window.windLayer) window.windLayer.redraw();
  });

  // --- Robust tap/click handler (works on iPhone + avoids accidental waypoint on pan/zoom) ---
  const container = map.getContainer();

  // Global suppression window for any map interactions (drag/zoom/wheel/UI)
  let suppressTapUntil = 0;
  function suppressTap(ms = 450) {
    suppressTapUntil = Math.max(suppressTapUntil, Date.now() + ms);
  }
  function tapSuppressed() {
    return Date.now() < suppressTapUntil;
  }

  // Ignore clicks/taps originating from Leaflet overlay elements (markers, popups, vectors, etc.)
  function isFromLeafletOverlayTarget(target) {
    if (!target || !target.closest) return false;
    return !!target.closest(
      ".leaflet-marker-icon, .leaflet-marker-shadow, .leaflet-popup, .leaflet-interactive"
    );
  }

  // Suppress taps during/after Leaflet interactions
  map.on("dragstart zoomstart movestart", () => suppressTap(700));
  map.on("dragend zoomend moveend", () => suppressTap(300));
  // Desktop wheel / trackpad zoom
  container.addEventListener("wheel", () => suppressTap(700), { passive: true });

  function applyTapAt(latlng) {
    const lat = latlng.lat;
    const lon = latlng.lng;
    if (tapMode === "boat") window.setStartBoat(lat, lon);
    else window.addWaypoint(lat, lon);
  }

  // ----- Desktop: prevent "mouseup click" after dragging -----
  let mouseDownPt = null;
  let mouseMoved = false;
  const MOUSE_MOVE_PX = 6;

  function dist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  container.addEventListener("mousedown", (ev) => {
    mouseDownPt = { x: ev.clientX, y: ev.clientY };
    mouseMoved = false;
  }, { passive: true });

  container.addEventListener("mousemove", (ev) => {
    if (!mouseDownPt) return;
    const cur = { x: ev.clientX, y: ev.clientY };
    if (dist2(cur, mouseDownPt) > (MOUSE_MOVE_PX * MOUSE_MOVE_PX)) mouseMoved = true;
  }, { passive: true });

  container.addEventListener("mouseup", () => {
    if (mouseMoved) suppressTap(450);
    mouseDownPt = null;
  }, { passive: true });

  // Desktop click mouse -> add only if not suppressed, and not on markers/popups/overlays
  container.addEventListener("click", (ev) => {
    if (tapSuppressed()) return;

    // NEW: ignore clicks on markers/popups/interactive overlays
    if (isFromLeafletOverlayTarget(ev.target)) return;

    // Extra safety if Leaflet thinks it is moving
    if (map && map.dragging && map.dragging._draggable && map.dragging._draggable._moving) return;

    const latlng = map.mouseEventToLatLng(ev);
    applyTapAt(latlng);
  }, { passive: true });

  // ----- Touch: prevent waypoint on pan/pinch zoom -----
  let touchStartPt = null;
  let touchMoved = false;
  let multiTouch = false;
  const TAP_MOVE_PX = 10;

  container.addEventListener("touchstart", (ev) => {
    // Any multitouch means pinch/zoom -> do not create point
    multiTouch = (ev.touches && ev.touches.length > 1);
    touchMoved = false;

    const t = ev.touches && ev.touches[0];
    if (!t) return;
    touchStartPt = { x: t.clientX, y: t.clientY };
  }, { passive: true });

  container.addEventListener("touchmove", (ev) => {
    if (!touchStartPt) return;
    if (ev.touches && ev.touches.length > 1) {
      multiTouch = true;
      return;
    }
    const t = ev.touches && ev.touches[0];
    if (!t) return;

    const cur = { x: t.clientX, y: t.clientY };
    if (dist2(cur, touchStartPt) > (TAP_MOVE_PX * TAP_MOVE_PX)) {
      touchMoved = true;
    }
  }, { passive: true });

  container.addEventListener("touchend", (ev) => {
    // If Leaflet interaction happened (pinch/zoom/move), ignore
    if (tapSuppressed()) return;

    // NEW: ignore taps on markers/popups/interactive overlays
    const touchTarget =
      (ev.changedTouches && ev.changedTouches[0] && ev.changedTouches[0].target) || ev.target;

    if (isFromLeafletOverlayTarget(touchTarget)) {
      // suppress synthetic click after marker tap (iOS)
      suppressTap(600);
      touchStartPt = null;
      touchMoved = false;
      multiTouch = false;
      return;
    }

    // If pinch zoom (multi touch) happened, ignore
    if (multiTouch) {
      multiTouch = false;
      touchStartPt = null;
      touchMoved = false;
      // suppress synthetic click after pinch end
      suppressTap(600);
      return;
    }

    // If finger moved, it was a pan -> ignore
    if (touchMoved) {
      touchStartPt = null;
      touchMoved = false;
      // suppress synthetic click after pan
      suppressTap(450);
      return;
    }

    const t = ev.changedTouches && ev.changedTouches[0];
    if (!t) return;

    const latlng = map.mouseEventToLatLng(t);
    applyTapAt(latlng);

    // Suppress the synthetic click that iOS may fire after touchend
    suppressTap(600);

    touchStartPt = null;
  }, { passive: true });

  // expose
  window.map = map;
  window.windCanvas = windCanvas;

  // Prevent UI clicks/taps from reaching the map + close popups
  const ui = document.getElementById("ui");
  if (ui) {
    L.DomEvent.disableClickPropagation(ui);
    L.DomEvent.disableScrollPropagation(ui);

    const stopUi = (e) => {
      e.stopPropagation();
      if (map) map.closePopup();
      suppressTap(700); // block any immediate "ghost click" on the map
    };

    ui.addEventListener("click", stopUi, { passive: true });
    ui.addEventListener("touchstart", stopUi, { passive: true });
    ui.addEventListener("touchend", stopUi, { passive: true });
  }
};

/**
 * Load and render land polygons GeoJSON layer (land = light gray).
 *
 * @param {string} url - URL/path to GeoJSON file (e.g. "geo/land_polygons.geojson")
 * @returns {Promise<void>}
 * @throws {Error} if GeoJSON cannot be loaded
 */
window.setLandGeoJson = async function setLandGeoJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`GeoJSON load failed: ${res.status}`);
  const geo = await res.json();

  if (landLayer) landLayer.remove();

  landLayer = L.geoJSON(geo, {
    style: {
      color: "#9ca3af",
      weight: 1,
      fillColor: "#d1d5db",
      fillOpacity: 1.0
    }
  }).addTo(map);

  try {
    map.fitBounds(landLayer.getBounds());
  } catch (err) {
    // Ignore: empty or invalid GeoJSON bounds
  }
};

/**
 * Set tap mode on the map.
 * - "boat": next tap sets boat position
 * - "wp": next taps add waypoints
 *
 * @param {"boat"|"wp"} m
 * @returns {void}
 */
window.setTapMode = function setTapMode(m) {
  tapMode = m;
};

/**
 * Build HTML content for the boat marker popup.
 *
 * Displays the current boat latitude and longitude using the
 * {@link latLonToStr} formatter.
 *
 * The content is evaluated at popup open time, so it always reflects
 * the latest boat position stored in {@link appState.boat}.
 *
 * @function buildBoatPopupHtml
 * @returns {string} HTML string used as Leaflet popup content.
 */
function buildBoatPopupHtml() {
  const type = getDMSType ();
  const boat = appState.boat;
  return `
    <div class="boat-popup">
      <div><b>Boat</b></div>
      <div style="opacity:.85;"> ${latLonToStr(boat.lat, boat.lon, type)}</div>
    </div>
  `;
}

/**
 * Creates the boat marker if needed and sets its initial position.
 * The boat icon is oriented toward North by default (0°).
 *
 * @param {number} lat - Latitude in degrees
 * @param {number} lon - Longitude in degrees
 * @param {number} [tack=0] - Tack side (0=starboard/green, 1=port/red)
 * @returns {void}
 */
window.setStartBoat = function setStartBoat(lat, lon, tack = 0) {
  // Keep app state consistent
  const prev = appState.boat || {};
  const heading = Number.isFinite(prev.heading) ? prev.heading : 0;

  appState.boat = { lat, lon, tack, heading };

  if (!boatMarker) {
    const html = buildBoatSvgHtml(tack);

    const icon = L.divIcon({
      html,
      className: "boatMarker",
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });

    boatMarker = L.marker([lat, lon], { icon }).addTo(map);

    boatMarker.bindPopup(() => buildBoatPopupHtml(), {
      closeButton: true,
      autoClose: true,
      closeOnClick: false,
      className: "boatPopup"
    });
  } else {
    boatMarker.setLatLng([lat, lon]);
  }
  // Also clear route + playback state
  if (window.clearRoute) window.clearRoute();
  if (window.player && window.player.reset) window.player.reset();

  // Optional: clear wind time sync / redraw
  if (window.windLayer) {
    window.windLayer.setRouteState(null);
    window.windLayer.redraw();
  }
  lastRouteData = null; // global
  window.player.syncSlider();
  redrawOrthoLines();
  saveSession(appState);
};

/**
 * Updates the boat visual state:
 * - orientation (heading)
 * - tack color (tribord / babord)
 *
 * Heading convention:
 *   0°   = North (up)
 *   90°  = East (right)
 *   180° = South
 *   270° = West
 * Rotation is clockwise.
 *
 * Tack convention:
 *   0 = starboard (green)
 *   1 = port (red)
 *
 * @param {number} headingDeg - Boat heading in degrees (0..360)
 * @param {number} tack - Tack side (0=starboard, 1=port)
 * @returns {void}
 */
window.setBoatVisualState = function setBoatVisualState(headingDeg, tack) {
  if (!boatMarker) return;

  const el = boatMarker.getElement?.();
  if (!el) return;

  const iconEl = el.querySelector(".boat-icon");
  if (!iconEl) return;

  /* --- heading --- */
  const heading = ((headingDeg % 360) + 360) % 360;
  iconEl.style.transform = `rotate(${heading}deg)`;

  /* --- tack color --- */
  const color = tack === 1 ? "#d00000" : "#008000";
  iconEl.style.setProperty("--boat-color", color);

  /* --- keep state in sync (optional but useful) --- */
  if (appState?.boat) {
    appState.boat.heading = heading;
    appState.boat.tack = tack;
  }
};

/**
 * Retrieve current GPS position and set boat position on the map.
 *
 * @returns {Promise<{lat:number, lon:number}>}
 */
window.setBoatFromGPS = function setBoatFromGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not supported by this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        window.setStartBoat(lat, lon);

        // Optional: center map
        if (map) map.setView([lat, lon], Math.max(map.getZoom(), 8));

        resolve({ lat, lon });
      },
      (err) => {
        const msg = err && err.message ? err.message : "Geolocation error";
        reject(new Error(msg));
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  });
};

/**
 * @deprecated Use setBoatFromGPS()
 */
window.setBoatFromGps = window.setBoatFromGPS;

/**
 * Add a waypoint if does not exist.
 * Show marker at (lat, lon) whatever
 * Waypoints order matters: last waypoint is destination.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {void}
 */
window.addWaypoint = function addWaypoint(lat, lon) {
  const BIND_POPUP_TIMEOUT = 2000; // ms
  appState.waypoints.push({ lat, lon });

  const iWp = appState.waypoints.length - 1; // 0-based
  const idx = iWp + 1;

  const html = `<div style="background:#111827;color:#fff;border-radius:999px;padding:2px 7px;font-size:12px;transform: translate(-50%,-50%);">${idx}</div>`;
  const icon = L.divIcon({ html, className: "", iconSize: [0,0] });

  const m = L.marker([lat, lon], { icon }).addTo(map);
  wpMarkers.push(m);

  m.bindPopup(() => buildWaypointPopupHtml(iWp), {
    closeButton: true,
    autoClose: true,
    closeOnClick: false,
    className: "wpPopup"
  });

  // When user taps an existing waypoint marker: open popup
  m.on("click", () => {
    m.openPopup();
  });
  // Open immediately after adding
  m.openPopup();
  setTimeout(() => {
    if (map.hasLayer(m) && m.isPopupOpen()) {
      m.closePopup();
    }
  }, BIND_POPUP_TIMEOUT);

  redrawOrthoLines();
  saveSession(appState);
};

/**
 * Remove last waypoint (if any) and renumber markers.
 * @returns {void}
 */
window.undoWaypoint = function undoWaypoint() {
  if (appState.waypoints.length === 0) return;

  appState.waypoints.pop();
  const m = wpMarkers.pop();
  if (m) m.remove();

  // Renumber
  wpMarkers.forEach((mk, i) => {
    const html = `<div style="background:#111827;color:#fff;border-radius:999px;padding:2px 7px;font-size:12px;transform: translate(-50%,-50%);">${i + 1}</div>`;
    mk.setIcon(L.divIcon({ html, className: "", iconSize: [0, 0] }));
  });
  // Rebind popups with updated waypoint indices
  wpMarkers.forEach((mk, i) => {
    mk.bindPopup(() => buildWaypointPopupHtml(i), {
      closeButton: true,
      autoClose: true,
      closeOnClick: false,
      className: "wpPopup"
    });
  });
  redrawOrthoLines();
  saveSession(appState);
};

/**
 * Clear all waypoints and markers.
 * @returns {void}
 */
window.clearWaypoints = function clearWaypoints() {
  appState.waypoints = [];
  wpMarkers.forEach(m => m.remove());
  wpMarkers = [];

  // Also clear route + playback state
  if (window.clearRoute) window.clearRoute();
  if (window.player && window.player.reset) window.player.reset();

  // Optional: clear wind time sync / redraw
  if (window.windLayer) {
    window.windLayer.setRouteState(null);
    window.windLayer.redraw();
  }
  redrawOrthoLines();
  lastRouteData = null; // global
  window.player.syncSlider();
  saveSession(appState);
};

function buildBoatSvgHtml(tack = 0) {
  const color = tack === 1 ? "#d00000" : "#008000"; // 0 tribord=vert, 1 babord=rouge

  return `
    <div class="boat-icon" style="--boat-color:${color}">
      <svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true">
        <!-- One single outline (no inner seam) -->
        <path class="boat-shape"
          d="
            M22 56
            L42 56
            L42 30
            L32 0
            L22 30
            Z
          "/>
      </svg>
    </div>
  `;
}

/**
 * Render route polyline on the map and fit bounds.
 *
 * @param {Array<[number,number]>} latlngs - list of [lat, lon]
 * @returns {void}
 */
window.setRoutePolyline = function setRoutePolyline(latlngs) {
  if (routeLine) routeLine.remove();
  routeLine = L.polyline(latlngs, {
    color: "#dc2626",   // rouge (Tailwind red-600)
    weight: 3,
    opacity: 1.0
  }).addTo(map);

  try {
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  } catch (err) {
    // Ignore: route may have a single point or invalid bounds
  }
};

/**
 * Updates the boat geographic position.
 * Does not modify heading or tack.
 *
 * @param {number} lat - Latitude in degrees
 * @param {number} lon - Longitude in degrees
 * @returns {void}
 */
window.setBoatPosition = function setBoatPosition(lat, lon) {
  if (!boatMarker) return;

  appState.boat.lat = lat;
  appState.boat.lon = lon;

  boatMarker.setLatLng([lat, lon]);

  if (boatMarker.isPopupOpen?.()) {
    boatMarker.setPopupContent(buildBoatPopupHtml());
  }
};

/**
 * Remove the current route polyline from the map (if any).
 * @returns {void}
 */
window.clearRoute = function clearRoute() {
  if (routeLine) {
    routeLine.remove();
    routeLine = null;
  }
  if (map) map.closePopup();
};

/**
 * Return Leaflet map instance.
 * @returns {any} Leaflet map object
 */
window.getMap = () => map;

