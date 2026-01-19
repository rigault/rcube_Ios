/* globals L, map, windCanvas */

/**
 * @typedef {Object} RouteState
 * @property {number} t0Epoch - route start epoch (seconds)
 * @property {number} dtRoute - route step (seconds)
 * @property {number} k - current step index in the route
 */

/**
 * Wind rendering layer (barbs) on a Leaflet canvas pane.
 * Needs:
 *  - GRIB meta (grid geometry + timestamps)
 *  - GRIB field (Float32Array + getUVGW())
 *  - optional routeState to synchronize wind time with route playback
 */
window.windLayer = (function makeWindLayer() {
  /** @type {any|null} GRIB meta */
  let gribLimits = null;

  /** @type {{values:Float32Array, getUVGW:function}|null} GRIB field */
  let dataGrib = null;

  /** @type {RouteState|null} */
  let routeState = null;

  /**
   * Convert an epoch time (seconds) into the nearest GRIB time index.
   * @param {number} currentEpoch
   * @returns {number} iTimeStamp
   */
  function getGribTimeIndexFromEpoch(currentEpoch) {
    const diffHours = (currentEpoch - gribLimits.epochStart) / 3600;
    const { iTInf, iTSup } = findTimeAround(diffHours);

    return (gribLimits.timeStamps[iTSup] - diffHours) < (diffHours - gribLimits.timeStamps[iTInf])
      ? iTSup
      : iTInf;
  }

  /**
   * Set GRIB meta + field used for drawing.
   * @param {any} meta
   * @param {any} field
   * @returns {void}
   */
  function set(meta, field) {
    gribLimits = meta;
    dataGrib = field;
  }

  /**
   * Update route time state used to choose GRIB timestamp.
   * @param {RouteState} rs
   * @returns {void}
   */
  function setRouteState(rs) {
    routeState = rs;
  }

  /**
   * Whether wind layer has everything needed to draw.
   * @returns {boolean}
   */
  function ready() {
    return !!(map && windCanvas && gribLimits && dataGrib && dataGrib.getUVGW);
  }

  /**
   * Redraw wind barbs for current map viewport.
   * @returns {void}
   */
  function redraw() {
    if (!ready()) return;

    const ctx = windCanvas.getContext("2d");
    const {
      nTimeStamp, nLat, nLon,
      bottomLat, leftLon,
      latStep, lonStep, nShortName
    } = gribLimits;

    const expected = nTimeStamp * nLat * nLon * nShortName;
    const got = dataGrib.values.length;
    if (expected !== got) {
      console.warn("Wind redraw: inconsistent GRIB size", got, expected);
      // Keep drawing anyway (u/v access still works if layout is consistent)
    }

    // Visible bounds
    const mapBounds = map.getBounds();
    const topLeft = map.latLngToLayerPoint(mapBounds.getNorthWest());
    const bottomRight = map.latLngToLayerPoint(mapBounds.getSouthEast());
    const size = bottomRight.subtract(topLeft);

    L.DomUtil.setPosition(windCanvas, topLeft);
    windCanvas.width = Math.max(1, Math.floor(size.x));
    windCanvas.height = Math.max(1, Math.floor(size.y));
    ctx.clearRect(0, 0, windCanvas.width, windCanvas.height);

    const zoom = map.getZoom();
    const stride = getWindStride(zoom);

    const cellSize = 25; // px
    const usedCells = new Set();

    // Choose time
    const currentEpoch = routeState
      ? (routeState.t0Epoch + routeState.k * routeState.dtRoute)
      : gribLimits.epochStart;

    const iTimeStamp = getGribTimeIndexFromEpoch(currentEpoch);

    for (let iLat = 0; iLat < nLat; iLat += stride) {
      const lat = bottomLat + iLat * latStep;

      for (let iLon = 0; iLon < nLon; iLon += stride) {
        const lon = leftLon + iLon * lonStep;

        // Geographic culling
        if (lat < mapBounds.getSouth() - 1 || lat > mapBounds.getNorth() + 1 ||
            lon < mapBounds.getWest() - 1 || lon > mapBounds.getEast() + 1) {
          continue;
        }

        const { u, v } = dataGrib.getUVGW(iTimeStamp, iLat, iLon);

        const pt = map.latLngToLayerPoint([lat, lon]);
        const x = pt.x - topLeft.x;
        const y = pt.y - topLeft.y;

        if (x < 0 || y < 0 || x > windCanvas.width || y > windCanvas.height) continue;

        const cx = Math.floor(x / cellSize);
        const cy = Math.floor(y / cellSize);
        const key = `${cx},${cy}`;
        if (usedCells.has(key)) continue;
        usedCells.add(key);

        drawWindBarb(ctx, x, y, u, v);
      }
    }
  }
  return { set, setRouteState, redraw };
})();

