# NWS Forecast Viewer — v2

Fixes & changes:
- Prevents initial vertical stretch by giving the canvas parent a fixed height (520px) and disabling Chart.js animations.
- Hover now always works: a manual nearest-x mouse/touch tracker updates the readout even when the library doesn’t select an element.
- Visuals are closer to WUnderground: tuned colors, subtle grid, smoothed temp/dew lines, filled PoP & cloud.

Files:
- index.html
- styles.css
- app.js
