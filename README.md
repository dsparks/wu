# NWS Forecast — v4 (WUnderground-style facets)

Features:
- Vertically **faceted** charts (temperature/dew, humidity/cloud, precip, wind, pressure).
- Light **nighttime shading** using `forecastHourly.isDaytime` to generate bands.
- **Vertical crosshair** synced across all facets + a consolidated hover readout (no emoji in tooltips).
- Daily strip at the top using **emoji** (🌞, 🌥️, 🌧️, ⛈️, ❄️, 🌫️, …) mapped from `shortForecast`.
- Fully static; GitHub Pages ready; no API keys.

File list:
- `index.html` — markup
- `styles.css` — WUnderground-like light theme
- `app.js` — data fetching, series prep, charts, shading, crosshair
