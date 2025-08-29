# NWS Forecast Viewer (GitHub Pages)

A single-page, client-side app that fetches NOAA/NWS forecast data and renders a hoverable, multi-series chart (temperature, dew point, precip probability/amount, humidity, wind, pressure), plus day cards with icons and hi/lo.

### How to deploy on GitHub Pages

1. Create a new repo and enable Pages (or use an existing one).
2. Put these files at the repo root:
   - `index.html`
   - `styles.css`
   - `app.js`
3. Commit and push. Open your GitHub Pages URL.

### Notes

- Data source: https://api.weather.gov/ (no API key needed).
- Browser geolocation requires HTTPS (GitHub Pages is HTTPS).
- Hourly grid coverage is ~7 days, so the horizon may be shorter than a strict 10-day.
- Search supports:
  - US ZIP codes (via https://api.zippopotam.us),
  - General place names (via OpenStreetMap Nominatim).
- Everything runs entirely in the browser—no backend or build tools.
