/* globals Swal, REQ, apiUrl */

/* =========================================================
   GRIB client (meta + binary dump) with cache (V1.1)
   ========================================================= */

let dataGrib = {};       // latest field
let gribLimits = {};     // latest meta
window.dataGrib = dataGrib;
window.gribLimits = gribLimits;

/**
 * Condense list of time stamps in concise way 
 * @param {number[]} timeStamps
 * @returns {string}
 */
function condenseTimeStamps (timeStamps) {
   let result = [];
   if (!timeStamps || timeStamps.length === 0) return "[]";
   if (timeStamps.length < 5) {
      for (let i = 0; i < timeStamps.length; i++) {
         result.push (timeStamps [i]);
      }
      return "[" + result.join(", ") + "]";
   }

   let start = timeStamps[0];
   let prev = start;
   let timeStep = null;
   let diff = null;
   let afterStart = timeStamps [1];
   for (let i = 1; i < timeStamps.length; i++) {
      diff = timeStamps[i] - prev;

      if (timeStep === null) {
         timeStep = diff; // Initialize first time step
      }

      if (diff !== timeStep) {
         // New sequence found
         if (prev !== start) {
            result.push(start + (prev !== start + timeStep ? ", " + afterStart + ".." + prev : ""));
            afterStart = start + diff;
         } else {
            result.push(start);
         }
         start = timeStamps[i];
         timeStep = diff;
      }

      prev = timeStamps[i];
   }
   afterStart = start + diff;

   // Add last segment
   if (prev !== start) result.push(start + ", " + afterStart + ".." + prev);
   else result.push(start);

   return "[" + result.join(", ") + "]";
}

/**
 * Fetches and displays metadata of a GRIB file (wind or current) from the server.
 *
 * This function requests GRIB metadata using {@link gribMetaAndLoad} with
 * `load=false` (no binary data), updates the global {@link gribLimits} object,
 * and displays a formatted summary in a SweetAlert2 dialog.
 *
 * The GRIB source is selected in one of two ways:
 * - If `model` is provided, the server will select the GRIB corresponding
 *   to that weather model (e.g. "GFS", "ECMWF", "ARPEGE", "UCMC", "SYN").
 * - Otherwise, `gribName` is used and resolved relative to `dir`
 *   (e.g. "grib/<file>" or "currentgrib/<file>").
 *
 * Typical use cases:
 * - Show metadata of the wind GRIB: `gribInfo("grib", appState.model, "")`
 * - Show metadata of the current GRIB: `gribInfo("currentgrib", "", fileName)`
 *
 * The function shows a loading modal while the request is in progress
 * and then displays a detailed table including:
 * - GRIB centre and edition
 * - run time and validity period
 * - grid geometry (lat/lon range and resolution)
 * - available parameters (short names)
 * - available timestamps
 *
 * @async
 * @function gribInfo
 *
 * @param {string} dir
 *        GRIB directory on the server, typically `"grib"` or `"currentgrib"`.
 *
 * @param {string} model
 *        Weather model name (e.g. `"GFS"`, `"ECMWF"`, `"ARPEGE"`, `"UCMC"`, `"SYN"`).
 *        If non-empty, the GRIB is selected by model and `gribName` is ignored.
 *
 * @param {string} gribName
 *        Name of a GRIB file inside `dir` (e.g. `"gfs_20250307_00.grb"`),
 *        or empty string when selecting by model.
 *
 * @returns {Promise<void|false>}
 *          Resolves when the dialog is closed.
 *          Returns `false` when no model and no GRIB name are provided.
 */
async function gribInfo(dir, model, gribName) {
   const formatLat = x => (x < 0) ? -x + "°S" : x + "°N";
   const formatLon = x => (x < 0) ? -x + "°W" : x + "°E";

   if (!model && (!gribName || gribName.length === 0)) {
      await Swal.fire("Warning", "No grib", "warning");
      return false;
   }

   Swal.fire({
      title: "Loading...",
      didOpen: () => Swal.showLoading(),
      allowOutsideClick: false,
      showConfirmButton: false
   });

   const out = await gribMetaAndLoad(dir, model, gribName, false);
   if (out === false)  return;
   const meta = out.meta;
   
   if (!meta || meta.centreName === undefined) return;
   const shortNames = Array.isArray(meta.shortNames) ? meta.shortNames.join(", ") : "NA";
   const centreName = (meta.centreName && meta.centreName.length > 0) ? `${meta.centreName}, ` : "";

   let rows = [
      ["Centre", `${centreName}ID: ${meta.centreID}, Ed: ${meta.edNumber ?? "NA"}`],
      ["Time Run", `${meta.runStart.slice(11, 13)}Z`],
      ["From To UTC", `${meta.runStart} - ${meta.runEnd}`],
      ["File", `${meta.name} (${meta.fileSize.toLocaleString("fr-FR")} bytes, ${meta.fileTime})`],
      ["latStep lonStep", `${meta.latStep}° / ${meta.lonStep}°`],
      ["Zone", `${meta.nLat} x ${meta.nLon} values: lat: ${formatLat (meta.topLat)} to ${formatLat (meta.bottomLat)}, lon: ${formatLon (meta.leftLon)} to ${formatLon (meta.rightLon)}`],
      ["Short Names", shortNames],
      ["Time Stamps", `${meta.nTimeStamp} values: ${condenseTimeStamps(meta.timeStamps)}`]
   ];
  if (meta.info && meta.info.length >= 2) rows.push (["Info", `${meta.info}`]);

   const content = `
   <div style="padding: 16px; font-family: Arial, sans-serif;">
      <table style="border-collapse: collapse; width: 100%; text-align: left; font-size: 14px;">
         <tbody>
            ${rows.map(([key, value], index) => `
               <tr style="background-color: ${index % 2 === 0 ? '#f9f9f9' : '#ffffff'}; text-align: left;" >
                  <td style="padding: 8px 12px; font-weight: bold; border-bottom: 1px solid #ddd; text-align: left; min-width: 80px" >${key}</td>
                  <td style="padding: 8px 12px; border-bottom: 1px solid #ddd; text-align: left;" >${value}</td>
               </tr>
           `).join('')}
        </tbody>
      </table>
   </div>`;

   await Swal.fire({
      title: "Grib Info",
      width: '600px',
      html: content,
      icon: "success",
      confirmButtonText: "OK"
   });
}

/**
 * @typedef {Object} GribField
 * @property {Float32Array} values
 * @property {(tIndex:number, iLat:number, iLon:number) => {u:number, v:number, g:number, w:number}} getUVGW
 * @property {(tIndex:number, iLat:number, iLon:number) => number} indexOf
 * @property {number} nLat
 * @property {number} nLon
 * @property {number} nTime
 * @property {number} nShortName
 * @property {string} shortnames
 */

/**
 * @typedef {Object} GribMeta
 * @property {number} epochStart
 * @property {number} topLat
 * @property {number} bottomLat
 * @property {number} leftLon
 * @property {number} rightLon
 * @property {number} latStep
 * @property {number} lonStep
 * @property {number} nLat
 * @property {number} nLon
 * @property {number} nTimeStamp
 * @property {number} nShortName
 * @property {number[]} timeStamps
 * @property {string[]} shortNames
 * @property {string} name
 */

/* =========================================================
   GRIB cache (V1.1 + onlyUV)
   ========================================================= */

/**
 * @typedef {Object} GribCache
 * @property {string|null} key - `${model}/${realGribName}?onlyUV=0|1`
 * @property {GribMeta|null} meta
 * @property {GribField|null} field
 * @property {boolean} loading
 */

/** @type {GribCache} */
window.gribCache = {
  key: null,
  meta: null,
  field: null,
  loading: false
};

/**
 * Ensure GRIB is loaded in cache (meta + field). Uses cache when possible.
 * If `onlyUV=true`, appends `&onlyUV=true` to the REQ.GRIB_DUMP (type=16) request.
 *
 * @param {string} model
 * @param {string} [gribNameOptional=""]
 * @param {boolean} [onlyUV=false]
 * @returns {Promise<{meta:GribMeta, field:GribField}>}
 */
window.ensureGribLoaded = async function ensureGribLoaded(model, gribNameOptional = "", onlyUV = false) {
  const cache = window.gribCache;
  const wantedKey = `${model}/${gribNameOptional || ""}?onlyUV=${onlyUV ? 1 : 0}`;

  if (cache.loading) return { meta: cache.meta, field: cache.field };

  if (cache.key === wantedKey && cache.meta && cache.field && cache.field.getUVGW) {
    return { meta: cache.meta, field: cache.field };
  }

  cache.loading = true;
  try {
    const { meta, field } = await window.gribMetaAndLoad("grib", model, gribNameOptional, true, onlyUV);

    const realName = (meta && meta.name) ? meta.name : (gribNameOptional || "");
    cache.key = `${model}/${realName}?onlyUV=${onlyUV ? 1 : 0}`;
    cache.meta = meta;
    cache.field = field;

    return { meta, field };
  } finally {
    cache.loading = false;
  }
};

/**
 * Force GRIB reload even if cached.
 * Clears cache and calls ensureGribLoaded() with same parameters.
 *
 * @param {string} model
 * @param {string} [gribNameOptional=""]
 * @param {boolean} [onlyUV=false]
 * @returns {Promise<{meta:GribMeta, field:GribField}>}
 */
window.forceReloadGrib = async function forceReloadGrib(model, gribNameOptional = "", onlyUV = false) {
  const cache = window.gribCache;
  cache.key = null;
  cache.meta = null;
  cache.field = null;
  cache.loading = false;

  return await window.ensureGribLoaded(model, gribNameOptional, onlyUV);
};

/* =========================================================
   Low-level loaders
   ========================================================= */

/**
 * Download binary GRIB dump and decode to Float32Array.
 * Server tells components via `X-Shortnames` header ("uv", "uvg", "uvw", "uvgw").
 *
 * @param {string} dir
 * @param {string|null} model
 * @param {string} gribName
 * @param {number} nTime
 * @param {number} nLat
 * @param {number} nLon
 * @param {number} nName - expected component count from meta (warning only)
 * @param {boolean} [onlyUV=false] - request lighter dump (`onlyUV=true`) if supported by server
 * @returns {Promise<GribField>}
 * @throws {Error} on HTTP errors, missing headers or inconsistent binary size
 */
async function gribLoad(dir, model, gribName, nTime, nLat, nLon, nName, onlyUV = false) {
  const gribParam = model ? `model=${model}` : `grib=${dir}/${gribName}`;
  const uvParam = onlyUV ? `&onlyUV=true` : "";
  const formData = `type=${REQ.GRIB_DUMP}&${gribParam}${uvParam}`;

  const headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };
  const res = await fetch(apiUrl, { method: "POST", headers, body: formData, cache: "no-store" });
  if (!res.ok) throw new Error(`gribLoad HTTP error ${res.status}`);

  // Custom headers are sometimes hidden by proxy/CORS misconfig.
  // Try both common casings.
  const shortnamesStr = res.headers.get("X-Shortnames") || res.headers.get("x-shortnames");
  if (!shortnamesStr) throw new Error("Missing X-Shortnames header");

  const hasU = shortnamesStr.includes("u");
  const hasV = shortnamesStr.includes("v");
  const hasG = shortnamesStr.includes("g");
  const hasW = shortnamesStr.includes("w");
  if (!hasU || !hasV) console.warn("X-Shortnames does not contain both u and v:", shortnamesStr);

  let nShortName = 2;
  if (hasG) nShortName++;
  if (hasW) nShortName++;

  // If nName provided, just warn (do not fail)
  if (Number.isFinite(nName) && nName > 0 && nName !== nShortName) {
    console.warn("gribLoad: nShortName mismatch", "found", nShortName, "expected", nName);
  }

  const buf = await res.arrayBuffer();
  const values = new Float32Array(buf);

  const expected = nTime * nLat * nLon * nShortName;
  if (values.length !== expected) {
    throw new Error(`gribLoad: unexpected size got=${values.length} expected=${expected}`);
  }

  /**
   * Compute base index into Float32Array for (t, iLat, iLon).
   * Order: t -> lat -> lon -> [u, v, (g), (w)]
   *
   * @param {number} tIndex
   * @param {number} iLat
   * @param {number} iLon
   * @returns {number}
   */
  function indexOf(tIndex, iLat, iLon) {
    return (((tIndex * nLat) + iLat) * nLon + iLon) * nShortName;
  }

  /**
   * Read u/v/(g)/(w) at a given grid point.
   *
   * @param {number} tIndex
   * @param {number} iLat
   * @param {number} iLon
   * @returns {{u:number, v:number, g:number, w:number}}
   */
  function getUVGW(tIndex, iLat, iLon) {
    const idx = indexOf(tIndex, iLat, iLon);
    const u = values[idx];
    const v = values[idx + 1];

    let g = 0;
    let w = 0;
    let offset = 2;

    if (hasG) {
      g = values[idx + offset];
      offset += 1;
    }
    if (hasW) {
      w = values[idx + offset];
    }
    return { u, v, g, w };
  }

  return { values, getUVGW, indexOf, nLat, nLon, nTime, nShortName, shortnames: shortnamesStr };
}

/**
 * Fetch GRIB meta (REQ.GRIB) and optionally load binary dump (REQ.GRIB_DUMP).
 * Updates global `gribLimits` and `dataGrib`.
 *
 * @param {string} dir
 * @param {string|null} model
 * @param {string} gribName
 * @param {boolean} load
 * @param {boolean} [onlyUV=false]
 * @returns {Promise<{meta:GribMeta, field:GribField}>}
 * @throws {Error} on HTTP errors or server meta error
 */
async function gribMetaAndLoad(dir, model, gribName, load, onlyUV = false) {
  let gribParam = "";
  if (model) gribParam = `model=${model}`;
  else {
   if (!gribName || gribName.length === 0) {
      return false;
   } 
   if (gribName.startsWith ("grib/") || gribName.startsWith ("currentgrib/")) gribParam = `grib=${gribName}`;
   else gribParam = `grib=${dir}/${gribName}`;
  }

  const formData = `type=${REQ.GRIB}&${gribParam}`;

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const response = await fetch(apiUrl, { method: "POST", headers, body: formData, cache: "no-store" });
  if (!response.ok) throw new Error(`gribMetaAndLoad HTTP error ${response.status}`);

  const data = await response.json();

  if (data._Error) throw new Error(`Server GRIB meta error: ${data._Error}`);
  if (!data || Object.keys(data).length === 0) throw new Error("Empty GRIB meta");

  Object.assign(gribLimits, data);
  window.gribLimits = gribLimits;

  if (load) {
    const field = await gribLoad(dir, model, gribName, data.nTimeStamp, data.nLat, data.nLon, data.nShortName, onlyUV);
    dataGrib = field;
    window.dataGrib = dataGrib;
  }

  return { meta: gribLimits, field: dataGrib };
}

window.gribLoad = gribLoad;
window.gribMetaAndLoad = gribMetaAndLoad;

