# NWS Forecast Viewer — v3

**Runaway height fix**: The chart container uses `min-height`, `max-height`, `overflow:hidden`, and `contain: layout size paint` to break any ResizeObserver feedback loops. The hover readout is moved outside the chart container. Height is fixed at 520px (responsive width).

Files:
- index.html
- styles.css
- app.js
