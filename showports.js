const ZOOM_SHOW_MARKERS = 7;      // marks can be viewed
const ZOOM_SHOW_NAMES   = 11;     // name can be viewed

const portsLayer = L.layerGroup();

const portIcon = L.divIcon({
  className: "port-icon",
  html: `
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <!-- pastille noire -->
      <circle cx="12" cy="12" r="9" fill="#000" />
      <!-- léger liseré blanc -->
      <circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-width="1.6" />

      <!-- ancre blanche -->
      <g transform="translate(12 12)" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <!-- oeil -->
        <circle cx="0" cy="-6.2" r="1.3"/>
        <!-- tige -->
        <path d="M0 -4.8 V5.2"/>
        <!-- barre -->
        <path d="M-4.2 -3.2 H4.2"/>
        <!-- pattes -->
        <path d="M0 5.2 C-1.8 5.2 -3.7 4.3 -4.6 2.9"/>
        <path d="M0 5.2 C1.8 5.2 3.7 4.3 4.6 2.9"/>
        <!-- petit point bas -->
        <circle cx="0" cy="5.5" r="0.6" fill="#fff" stroke="none"/>
      </g>
    </svg>
  `,
  iconSize: [24, 24],
  iconAnchor: [12, 12],     // exact center
  tooltipAnchor: [0, -14]
});

/**
 * Creates Leaflet markers for all ports and registers them in the global port layer.
 *
 * Each port is represented by:
 * - A custom marine-style icon (SHOM-like)
 * - A permanent tooltip containing the port name (hidden by default)
 *
 * The markers are not directly added to the map; they are managed through `portsLayer`
 * and displayed depending on the zoom level via `updatePortsVisibility()`.
 *
 * @returns {L.Marker[]} Array of Leaflet Marker objects corresponding to all ports.
 */
const portMarkers = ports.map(p => {
  const m = L.marker([p.lat, p.lon], {
    icon: portIcon,
    title: p.name.replaceAll("_", " ")
  });

  m.bindTooltip(p.name.replaceAll("_", " "), {
    permanent: true,
    direction: "top",
    offset: [0, -10],
    opacity: 0.9,
    className: "port-label"
  });

  m.closeTooltip();

  m.bindPopup(`<b>${p.name}</b>`);

  return m;
});

/**
 * Updates the visibility of port markers and their labels based on the current map zoom level.
 *
 * Behaviour:
 * - Below ZOOM_SHOW_MARKERS: no port markers are displayed.
 * - From ZOOM_SHOW_MARKERS to ZOOM_SHOW_NAMES: port icons are visible, but names are hidden.
 * - From ZOOM_SHOW_NAMES and above: both port icons and port names (tooltips) are visible.
 *
 * This function must be called:
 * - After the map is created
 * - Each time the zoom level changes
 *
 * @param {L.Map} map - The Leaflet map instance.
 */
function updatePortsVisibility(map) {
  const z = map.getZoom();

  const markersShouldBeVisible = z >= ZOOM_SHOW_MARKERS;
  const layerOnMap = map.hasLayer(portsLayer);

  if (markersShouldBeVisible && !layerOnMap) {
    portsLayer.addTo(map);
  } else if (!markersShouldBeVisible && layerOnMap) {
    map.removeLayer(portsLayer);
  }

  const namesShouldBeVisible = z >= ZOOM_SHOW_NAMES;

  if (markersShouldBeVisible) {
    portMarkers.forEach(m => {
      if (namesShouldBeVisible) m.openTooltip();
      else m.closeTooltip();
    });
  }
}
