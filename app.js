/* Client-side NWS forecast viewer
 * - Geolocates on load; fallback: search city/state or ZIP (ZIP via Zippopotam, place via Nominatim)
 * - Pulls forecast + grid (hourly) from NWS
 * - Renders a single multi-axis Chart.js time-series with interactive tooltip
 * - Units: Fahrenheit default; pressure in inHg; wind mph; precip inches
 */

const els = {
  place: document.getElementById('placeName'),
  updated: document.getElementById('updatedAt'),
  days: document.getElementById('days'),
  chartCanvas: document.getElementById('forecastChart'),
  hoverReadout: document.getElementById('hoverReadout'),
  form: document.getElementById('searchForm'),
  input: document.getElementById('searchInput'),
  myLocBtn: document.getElementById('useMyLocation'),
};

let chart; // Chart.js instance

// ---------- Utilities ----------
const c2f = c => (c == null ? null : (c * 9) / 5 + 32);
const mm2in = mm => (mm == null ? null : mm / 25.4);
const kmh2mph = kmh => (kmh == null ? null : kmh * 0.621371);
const pa2inhg = pa => (pa == null ? null : pa / 3386.389);

/** Parse NWS validTime like "2025-08-29T18:00:00+00:00/PT1H"
 * returns { start: Date, hours: number }
 */
function parseValidTime(validTime) {
  const [startIso, durationIso] = validTime.split('/');
  const start = new Date(startIso);
  let hours = 1;
  if (durationIso) {
    const m = durationIso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?/);
    const d = m && m[1] ? parseInt(m[1], 10) : 0;
    const h = m && m[2] ? parseInt(m[2], 10) : 0;
    hours = d * 24 + h;
    if (hours === 0 && d > 0) hours = d * 24;
    if (hours === 0) hours = 1;
  }
  return { start, hours };
}

/** Build an hourly series for a grid property (values array with validTime + value) */
function expandHourly(values, convertFn) {
  const map = new Map(); // timestamp(ms) -> value
  values.forEach(v => {
    if (v.value == null || !v.validTime) return;
    const { start, hours } = parseValidTime(v.validTime);
    const val = convertFn ? convertFn(v.value) : v.value;
    for (let i = 0; i < hours; i++) {
      const t = new Date(start.getTime() + i * 3600 * 1000).getTime();
      map.set(t, val);
    }
  });
  return map;
}

/** Merge many hourly maps into a sorted array of timestamps present in at least one */
function mergeTimeAxis(...maps) {
  const keys = new Set();
  maps.forEach(m => m && m.forEach((_, k) => keys.add(k)));
  return Array.from(keys).sort((a, b) => a - b);
}

/** Extract value from map (or null) */
const at = (map, t) => (map && map.has(t) ? map.get(t) : null);

/** Formatters */
const fmtPct = v => (v == null ? '—' : `${Math.round(v)}%`);
const fmtF = v => (v == null ? '—' : `${Math.round(v)}°F`);
const fmtIn = v => (v == null ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)} in`);
const fmtMph = v => (v == null ? '—' : `${Math.round(v)} mph`);
const fmtInHg = v => (v == null ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)} inHg`);
const fmtTime = ms => new Date(ms).toLocaleString([], {weekday:'short', month:'short', day:'numeric', hour:'numeric'});

// ---------- Data fetchers ----------
async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/geo+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function geocodeQuery(q) {
  const zip = q.trim().match(/^\d{5}$/);
  if (zip) {
    // Zippopotam.us for US ZIP → lat/lon
    const j = await fetchJSON(`https://api.zippopotam.us/us/${zip[0]}`);
    const place = j.places && j.places[0];
    if (!place) throw new Error('ZIP not found.');
    return {
      lat: parseFloat(place.latitude),
      lon: parseFloat(place.longitude),
      label: `${j['post code']} ${place['place name']}, ${place['state abbreviation']}`
    };
  } else {
    // Nominatim for general place search (US-biased)
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}&addressdetails=1&email=noreply@example.com`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('Place search failed.');
    const arr = await res.json();
    if (!arr.length) throw new Error('No results.');
    const r = arr[0];
    const label = r.display_name;
    return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), label };
  }
}

async function loadByLatLon(lat, lon) {
  const points = await fetchJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const props = points.properties;
  const place =
    (props.relativeLocation?.properties?.city || '') +
    (props.relativeLocation?.properties?.state ? `, ${props.relativeLocation.properties.state}` : '');

  const foreUrl = props.forecast;
  const gridUrl = props.forecastGridData;

  // Fetch daily (icons) + grid (hourly)
  const [daily, grid] = await Promise.all([fetchJSON(foreUrl), fetchJSON(gridUrl)]);

  return { place: place || 'Selected location', daily, grid };
}

// ---------- Rendering ----------
function renderDailyCards(forecastJSON) {
  const daysEl = els.days;
  daysEl.innerHTML = '';

  const periods = (forecastJSON.properties?.periods || []).filter(p => p.isDaytime);
  periods.forEach(p => {
    const date = new Date(p.startTime);
    const name = date.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
    const card = document.createElement('div');
    card.className = 'day';
    card.innerHTML = `
      <div class="name">${name}</div>
      <img class="icon" alt="${p.shortForecast}" src="${p.icon}" />
      <div class="temps"><span class="hi">${p.temperature}°F</span><span class="lo">${findNightLowFor(p, forecastJSON)}°F</span></div>
      <div class="desc">${p.shortForecast}</div>
    `;
    daysEl.appendChild(card);
  });

  function findNightLowFor(dayPeriod, forecastJSON) {
    const all = forecastJSON.properties?.periods || [];
    const idx = all.findIndex(pp => pp.number === dayPeriod.number);
    if (idx >= 0 && all[idx+1] && !all[idx+1].isDaytime) {
      return all[idx+1].temperature;
    }
    return '—';
  }
}

function buildChartDatasets(grid) {
  const g = grid.properties;

  // Expand each grid series to hourly maps
  const temp = expandHourly(g.temperature.values, c2f);
  const dew = expandHourly(g.dewpoint.values, c2f);
  const rh = expandHourly(g.relativeHumidity.values, v => v);
  const cloud = expandHourly(g.skyCover.values, v => v);
  const pop = expandHourly(g.probabilityOfPrecipitation.values, v => v);
  const qpf = expandHourly(g.quantitativePrecipitation.values, mm2in);
  const wspd = expandHourly(g.windSpeed.values, kmh2mph);
  const press = expandHourly(g.pressure.values, pa2inhg);

  const tAxis = mergeTimeAxis(temp, dew, rh, cloud, pop, qpf, wspd, press);
  let accum = 0;
  const series = {
    tAxis,
    temperature: [],
    dewpoint: [],
    humidity: [],
    cloud: [],
    pop: [],
    qpfHourly: [],
    qpfAccum: [],
    wind: [],
    pressure: [],
  };

  tAxis.forEach(ms => {
    const q = at(qpf, ms);
    accum += q || 0;
    series.temperature.push(at(temp, ms));
    series.dewpoint.push(at(dew, ms));
    series.humidity.push(at(rh, ms));
    series.cloud.push(at(cloud, ms));
    series.pop.push(at(pop, ms));
    series.qpfHourly.push(q);
    series.qpfAccum.push(accum);
    series.wind.push(at(wspd, ms));
    series.pressure.push(at(press, ms));
  });

  return series;
}

function renderChart(series) {
  const ctx = els.chartCanvas.getContext('2d');
  const labels = series.tAxis;

  const data = {
    labels,
    datasets: [
      { // Temperature
        label: 'Temperature (°F)',
        data: series.temperature,
        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--temp').trim(),
        backgroundColor: 'transparent',
        tension: 0.25, pointRadius: 1.5, yAxisID: 'y',
      },
      { // Dew Point
        label: 'Dew Point (°F)',
        data: series.dewpoint,
        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--dew').trim(),
        backgroundColor: 'transparent',
        tension: 0.25, pointRadius: 1.5, yAxisID: 'y',
      },
      { // Chance of Precip
        label: 'Chance of Precip (%)',
        data: series.pop,
        borderColor: 'transparent',
        backgroundColor: hexWithAlpha(getCSS('--pop'), 0.35),
        fill: true, yAxisID: 'yPct',
      },
      { // Cloud Cover
        label: 'Cloud Cover (%)',
        data: series.cloud,
        borderColor: 'transparent',
        backgroundColor: hexWithAlpha(getCSS('--cloud'), 0.25),
        fill: true, yAxisID: 'yPct',
      },
      { // Humidity
        label: 'Humidity (%)',
        data: series.humidity,
        borderColor: getCSS('--hum'),
        backgroundColor: 'transparent',
        tension: 0.2, pointRadius: 0, yAxisID: 'yPct',
      },
      { // Wind
        label: 'Wind (mph)',
        data: series.wind,
        borderColor: getCSS('--wind'),
        backgroundColor: 'transparent',
        pointRadius: 0, tension: 0.2, yAxisID: 'yWind',
      },
      { // Pressure
        label: 'Pressure (inHg)',
        data: series.pressure,
        borderColor: getCSS('--press'),
        backgroundColor: 'transparent',
        pointRadius: 0, tension: 0.2, yAxisID: 'yPress',
      },
      { // QPF hourly
        type: 'bar',
        label: 'Hourly Liquid (in)',
        data: series.qpfHourly,
        backgroundColor: getCSS('--qpf'),
        yAxisID: 'yQpf',
        borderWidth: 0,
        barPercentage: 1.0,
        categoryPercentage: 1.0,
      },
      { // QPF accum
        label: 'Precip Accum (in)',
        data: series.qpfAccum,
        borderColor: getCSS('--qpfacc'),
        backgroundColor: 'transparent',
        pointRadius: 0, tension: 0.2, yAxisID: 'yQpf',
      },
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title(items){
            const i = items[0].dataIndex;
            return new Date(series.tAxis[i]).toLocaleString([], {weekday:'short', month:'short', day:'numeric', hour:'numeric'});
          },
          label(ctx){
            const ds = ctx.dataset.label || '';
            const v = ctx.raw;
            if (ds.includes('Temperature') || ds.includes('Dew')) return ` ${ds}: ${fmtF(v)}`;
            if (ds.includes('Humidity') || ds.includes('Cloud') || ds.includes('Chance')) return ` ${ds}: ${fmtPct(v)}`;
            if (ds.includes('Wind')) return ` ${ds}: ${fmtMph(v)}`;
            if (ds.includes('Pressure')) return ` ${ds}: ${fmtInHg(v)}`;
            if (ds.includes('Hourly Liquid')) return ` ${ds}: ${fmtIn(v)}`;
            if (ds.includes('Precip Accum')) return ` ${ds}: ${fmtIn(v)}`;
            return ` ${ds}: ${v}`;
          }
        }
      }
    },
    scales: {
      x: {
        type: 'time',
        time: { unit: 'hour', tooltipFormat: 'EEE MMM d h a' },
        ticks: { color: '#a6b0bf' },
        grid: { color: 'rgba(255,255,255,.06)' }
      },
      y: { // °F
        position:'left',
        ticks: { color: getCSS('--temp') },
        grid: { color: 'rgba(255,255,255,.06)' }
      },
      yPct: { // %
        position:'right',
        min:0, max:100,
        ticks: { color: '#8fb3ff' }
      },
      yWind: {
        position:'right',
        ticks: { color: getCSS('--wind') },
        grid: { display:false }
      },
      yPress: {
        position:'left',
        ticks: { color: getCSS('--press') },
        grid: { display:false }
      },
      yQpf: {
        position:'right',
        ticks: { color: getCSS('--qpf') },
        grid: { display:false }
      }
    },
    onHover(evt, elems){
      const p = chart?.getElementsAtEventForMode(evt, 'index', {intersect:false}, true);
      if (p && p.length){
        const i = p[0].index;
        updateHoverReadout(series, i);
      }
    }
  };

  if (chart) chart.destroy();
  chart = new Chart(ctx, { type: 'line', data, options });
}

function updateHoverReadout(series, i){
  const t = series.tAxis[i];
  const text =
    `${fmtTime(t)} — ` +
    `Temp ${fmtF(series.temperature[i])} | ` +
    `Dew ${fmtF(series.dewpoint[i])} | ` +
    `RH ${fmtPct(series.humidity[i])} | ` +
    `Cloud ${fmtPct(series.cloud[i])} | ` +
    `PoP ${fmtPct(series.pop[i])} | ` +
    `Wind ${fmtMph(series.wind[i])} | ` +
    `Press ${fmtInHg(series.pressure[i])} | ` +
    `QPF ${fmtIn(series.qpfHourly[i])} (acc ${fmtIn(series.qpfAccum[i])})`;
  els.hoverReadout.textContent = text;
}

function getCSS(varName){ return getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); }
function hexWithAlpha(hex, alpha){
  const h = hex.replace('#','');
  const r = parseInt(h.substring(0,2),16);
  const g = parseInt(h.substring(2,4),16);
  const b = parseInt(h.substring(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------- Controller ----------
async function showForecast(lat, lon, labelOverride){
  els.days.innerHTML = '';
  els.place.textContent = 'Loading…';
  els.updated.textContent = '';

  try{
    const { place, daily, grid } = await loadByLatLon(lat, lon);
    const label = labelOverride || place || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    els.place.textContent = label;
    const upd = grid.properties.updateTime || daily.properties.updated || new Date().toISOString();
    els.updated.textContent = `Updated ${new Date(upd).toLocaleString()}`;

    renderDailyCards(daily);
    const series = buildChartDatasets(grid);
    renderChart(series);

  }catch(err){
    console.error(err);
    els.place.textContent = 'Error loading forecast';
    els.updated.textContent = String(err.message || err);
  }
}

async function useBrowserLocation(){
  if (!('geolocation' in navigator)) {
    els.updated.textContent = 'Geolocation not supported in this browser.';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude } = pos.coords;
      showForecast(latitude, longitude);
    },
    err => {
      els.updated.textContent = 'Geolocation failed or was blocked. Use the search box.';
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 }
  );
}

// Search handlers
els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = els.input.value.trim();
  if (!q) return;
  try{
    const g = await geocodeQuery(q);
    showForecast(g.lat, g.lon, g.label);
  }catch(err){
    els.updated.textContent = `Search error: ${err.message}`;
  }
});
els.myLocBtn.addEventListener('click', () => useBrowserLocation());

// Init
useBrowserLocation();
