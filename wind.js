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
   * Return bounding GRIB indices around a time in hours:
   * gribLimits.timeStamps[iTInf] <= tHours <= gribLimits.timeStamps[iTSup]
   *
   * @param {number} tHours
   * @returns {{iTInf:number, iTSup:number}}
   */
  function findTimeAround(tHours) {
    const ts = gribLimits.timeStamps;
    const n = gribLimits.nTimeStamp;

    if (!Number.isFinite(tHours) || tHours < ts[0]) return { iTInf: 0, iTSup: 0 };

    for (let k = 0; k < n; k++) {
      if (tHours === ts[k]) return { iTInf: k, iTSup: k };
      if (tHours < ts[k]) return { iTInf: k - 1, iTSup: k };
    }
    return { iTInf: n - 1, iTSup: n - 1 };
  }

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
   * Choose a coarser stride when zoomed out to reduce density.
   * @param {number} zoom
   * @returns {number}
   */
  function getWindStride(zoom) {
    if (zoom <= 4) return 6;
    if (zoom <= 6) return 4;
    if (zoom <= 8) return 3;
    return 2;
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

  /**
   * Draw a wind barb symbol at (x, y).
   * u, v are wind components in m/s (u: east-west, v: north-south).
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} u
   * @param {number} v
   * @returns {void}
   */
  function drawWindBarb(ctx, x, y, u, v) {
    let speedKts = Math.sqrt(u * u + v * v) * MS_TO_KN;

    // Calm wind: draw a small circle
    if (!isFinite(speedKts) || speedKts < 2) {
      const r = 3;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    // Small visual bias (kept from original implementation)
    speedKts += 2.5;

    const mag = Math.sqrt(u * u + v * v);
    if (mag < 0.5 || !isFinite(mag)) return;

    // On screen: x right, y down
    const dirX = -u / mag;
    const dirY = v / mag;

    const halfShaft = 9;
    const tailX = x - dirX * halfShaft;
    const tailY = y - dirY * halfShaft;
    const headX = x + dirX * halfShaft;
    const headY = y + dirY * halfShaft;

    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(headX, headY);
    ctx.stroke();

    const barbLength = 7;
    const halfBarbLength = barbLength * 0.5;
    const barbSpacing = 4;

    const perpX = -dirY;
    const perpY = dirX;

    const n50 = Math.floor(speedKts / 50);
    let remainder = speedKts - n50 * 50;

    const n10 = Math.floor(remainder / 10);
    remainder -= n10 * 10;

    const has5 = remainder >= 5 ? 1 : 0;

    let currentOffset = 0;

    // 50 kt pennants
    for (let i = 0; i < n50; i++) {
      const baseHeadX = headX - dirX * currentOffset;
      const baseHeadY = headY - dirY * currentOffset;

      const baseTailX = baseHeadX - dirX * barbSpacing;
      const baseTailY = baseHeadY - dirY * barbSpacing;

      const tipX = baseTailX + perpX * barbLength;
      const tipY = baseTailY + perpY * barbLength;

      ctx.beginPath();
      ctx.moveTo(baseHeadX, baseHeadY);
      ctx.lineTo(baseTailX, baseTailY);
      ctx.lineTo(tipX, tipY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      currentOffset += barbSpacing;
    }

    // 10 kt barbs
    for (let i = 0; i < n10; i++) {
      const baseX = headX - dirX * currentOffset;
      const baseY = headY - dirY * currentOffset;

      const endX = baseX + perpX * barbLength;
      const endY = baseY + perpY * barbLength;

      ctx.beginPath();
      ctx.moveTo(baseX, baseY);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      currentOffset += barbSpacing;
    }

    // 5 kt half-barb
    if (has5) {
      const baseX = headX - dirX * currentOffset;
      const baseY = headY - dirY * currentOffset;

      const endX = baseX + perpX * halfBarbLength;
      const endY = baseY + perpY * halfBarbLength;

      ctx.beginPath();
      ctx.moveTo(baseX, baseY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    }
  }

  return { set, setRouteState, redraw };
})();

