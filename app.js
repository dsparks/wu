/* v4 — WUnderground-style facets with night shading + crosshair and emoji day strip.
 * Client-side only; GitHub Pages ready.
 */
const els = {
  place: document.getElementById('placeName'),
  updated: document.getElementById('updatedAt'),
  dayStrip: document.getElementById('dayStrip'),
  hoverReadout: document.getElementById('hoverReadout'),
  form: document.getElementById('searchForm'),
  input: document.getElementById('searchInput'),
  myLocBtn: document.getElementById('useMyLocation'),
  canvases: {
    temp: document.getElementById('chart-temp'),
    humid: document.getElementById('chart-humid'),
    precip: document.getElementById('chart-precip'),
    wind: document.getElementById('chart-wind'),
    press: document.getElementById('chart-press'),
  }
};

// Shared crosshair timestamp (ms). All charts read this and draw a vertical line.
let CROSSHAIR_TS = null;
let charts = {}; // facet -> Chart instance
let lastSeries = null; // hold full series for readout

// ---- Units & helpers ----
const c2f = c => (c == null ? null : (c * 9) / 5 + 32);
const mm2in = mm => (mm == null ? null : mm / 25.4);
const kmh2mph = kmh => (kmh == null ? null : kmh * 0.621371);
const pa2inhg = pa => (pa == null ? null : pa / 3386.389);
const fmtPct = v => (v == null ? '—' : `${Math.round(v)}%`);
const fmtF = v => (v == null ? '—' : `${Math.round(v)}°F`);
const fmtIn = v => (v == null ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)} in`);
const fmtMph = v => (v == null ? '—' : `${Math.round(v)} mph`);
const fmtInHg = v => (v == null ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)} inHg`);
const fmtTime = ms => new Date(ms).toLocaleString([], {weekday:'short', month:'short', day:'numeric', hour:'numeric'});

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

function expandHourly(values, convertFn) {
  const map = new Map();
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
const at = (map, t) => (map && map.has(t) ? map.get(t) : null);

function mergeTimeAxis(...maps) {
  const keys = new Set();
  maps.forEach(m => m && m.forEach((_, k) => keys.add(k)));
  return Array.from(keys).sort((a, b) => a - b);
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/geo+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---- Emoji mapping for day strip ----
function forecastToEmoji(shortForecast) {
  const s = (shortForecast || '').toLowerCase();
  if (s.includes('thunder')) return '⛈️';
  if (s.includes('snow') || s.includes('flurr')) return '❄️';
  if (s.includes('sleet')) return '🌨️';
  if (s.includes('rain') || s.includes('showers') || s.includes('shower')) return '🌧️';
  if (s.includes('fog')) return '🌫️';
  if (s.includes('haze') || s.includes('smoke')) return '🌫️';
  if (s.includes('clear') && s.includes('partly')) return '🌤️';
  if (s.includes('mostly sunny')) return '🌤️';
  if (s.includes('partly sunny')) return '🌥️';
  if (s.includes('partly cloudy')) return '🌥️';
  if (s.includes('mostly cloudy')) return '☁️';
  if (s.includes('cloudy')) return '☁️';
  if (s.includes('sunny') || s.includes('clear')) return '🌞';
  return '🌡️';
}

// ---- Build the day strip ----
function renderDayStrip(daily, qpfByDay) {
  const daysEl = els.dayStrip;
  daysEl.innerHTML = '';
  const periods = (daily.properties?.periods || []).filter(p => p.isDaytime);
  periods.forEach(p => {
    const date = new Date(p.startTime);
    const name = date.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
    const emoji = forecastToEmoji(p.shortForecast);
    const qpf = qpfByDay.get(date.toDateString()) || 0;
    const card = document.createElement('div');
    card.className = 'day';
    card.innerHTML = `
      <div class="name">${name}</div>
      <div class="emoji" aria-hidden="true">${emoji}</div>
      <div class="temps"><span class="hi">${p.temperature}°F</span><span class="lo">${findNightLowFor(p, daily)}°F</span></div>
      <div class="precip">${qpf.toFixed(2)} in</div>
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

// ---- Series construction (grid + hourly) ----
function buildSeries(grid, hourly) {
  const g = grid.properties;
  const temp = expandHourly(g.temperature.values, c2f);
  const dew = expandHourly(g.dewpoint.values, c2f);
  const rh = expandHourly(g.relativeHumidity.values, v => v);
  const cloud = expandHourly(g.skyCover.values, v => v);
  const pop = expandHourly(g.probabilityOfPrecipitation.values, v => v);
  const qpf = expandHourly(g.quantitativePrecipitation.values, mm2in);
  const wspd = expandHourly(g.windSpeed.values, kmh2mph);
  const press = expandHourly(g.pressure.values, pa2inhg);

  // tAxis
  const tAxis = mergeTimeAxis(temp, dew, rh, cloud, pop, qpf, wspd, press);

  // night intervals from hourly isDaytime
  const h = hourly.properties?.periods || [];
  const nightBands = [];
  for (let i=0; i<h.length; i++){
    if (h[i].isDaytime === false){
      const start = new Date(h[i].startTime).getTime();
      let end = start + 3600*1000;
      // extend while consecutive hours are night
      while (i+1 < h.length && h[i+1].isDaytime === false){
        i++; end += 3600*1000;
      }
      nightBands.push([start, end]);
    }
  }

  // accumulate per day precip for strip
  const qpfByDay = new Map();
  qpf.forEach((val, t) => {
    const d = new Date(t).toDateString();
    qpfByDay.set(d, (qpfByDay.get(d) || 0) + (val || 0));
  });

  // build regular arrays
  let accum = 0;
  const series = {
    tAxis, nightBands, qpfByDay,
    temperature: [], dewpoint: [], humidity: [], cloud: [], pop: [],
    qpfHourly: [], qpfAccum: [], wind: [], pressure: [],
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

// ---- Chart factory with plugins for night shading + crosshair ----
function makeFacetChart(canvas, cfg){
  const ctx = canvas.getContext('2d');
  const ch = new Chart(ctx, {
    type: 'line',
    data: { labels: cfg.labels, datasets: cfg.datasets },
    options: {
      responsive: false,       // we control size manually
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          callbacks: cfg.tooltipCallbacks || {}
        },
        // night shading
        nightShade: {
          bands: cfg.nightBands || [],
          color: 'rgba(125,125,125,0.08)'
        },
        // crosshair vertical line
        crosshair: { color: 'rgba(0,0,0,0.35)', width: 1 }
      },
      scales: cfg.scales
    },
    plugins: [{
      id: 'nightShade',
      beforeDatasetsDraw(chart, args, pluginOpts){
        const bands = chart.options.plugins.nightShade?.bands || [];
        const color = chart.options.plugins.nightShade?.color || 'rgba(0,0,0,0.05)';
        const x = chart.scales.x;
        const y = chart.scales[Object.keys(chart.scales).find(k=>k!=='x')];
        const ctx = chart.ctx;
        ctx.save();
        ctx.fillStyle = color;
        bands.forEach(([ts0, ts1]) => {
          const x0 = x.getPixelForValue(ts0);
          const x1 = x.getPixelForValue(ts1);
          ctx.fillRect(Math.min(x0,x1), y.top, Math.abs(x1-x0), y.bottom - y.top);
        });
        ctx.restore();
      },
      afterDatasetsDraw(chart){
        if (CROSSHAIR_TS == null) return;
        const x = chart.scales.x;
        const ctx = chart.ctx;
        const xpix = x.getPixelForValue(CROSSHAIR_TS);
        ctx.save();
        ctx.strokeStyle = chart.options.plugins.crosshair?.color || 'rgba(0,0,0,0.35)';
        ctx.lineWidth = chart.options.plugins.crosshair?.width || 1;
        ctx.beginPath();
        ctx.moveTo(xpix, chart.chartArea.top);
        ctx.lineTo(xpix, chart.chartArea.bottom);
        ctx.stroke();
        ctx.restore();
      }
    }]
  });
  return ch;
}

// set canvas size based on container width and fixed height
function sizeCanvasToParent(canvas){
  const parent = canvas.parentElement;
  const width = Math.floor(parent.clientWidth - 20); // padding guard
  const height = canvas.getAttribute('height'); // fixed per facet
  canvas.width = width;
  canvas.height = parseInt(height, 10);
}

// update readout for ts nearest to CROSSHAIR_TS
function updateReadout(series, ts){
  if (!series || !series.tAxis.length) { els.hoverReadout.textContent=''; return; }
  // find nearest index via binary search
  const tArr = series.tAxis;
  let lo = 0, hi = tArr.length - 1, mid;
  while (hi - lo > 1) { mid = (hi + lo) >> 1; if (tArr[mid] < ts) lo = mid; else hi = mid; }
  const idx = (Math.abs(tArr[lo] - ts) < Math.abs(tArr[hi] - ts)) ? lo : hi;

  const txt = `${fmtTime(tArr[idx])} — ` +
    `Temp ${fmtF(series.temperature[idx])} | ` +
    `Dew ${fmtF(series.dewpoint[idx])} | ` +
    `RH ${fmtPct(series.humidity[idx])} | ` +
    `Cloud ${fmtPct(series.cloud[idx])} | ` +
    `PoP ${fmtPct(series.pop[idx])} | ` +
    `Wind ${fmtMph(series.wind[idx])} | ` +
    `Press ${fmtInHg(series.pressure[idx])} | ` +
    `QPF ${fmtIn(series.qpfHourly[idx])} (acc ${fmtIn(series.qpfAccum[idx])})`;
  els.hoverReadout.textContent = txt;
}

// ---- Main controller ----
async function geocodeQuery(q) {
  const zip = q.trim().match(/^\d{5}$/);
  if (zip) {
    const j = await fetchJSON(`https://api.zippopotam.us/us/${zip[0]}`);
    const place = j.places && j.places[0];
    if (!place) throw new Error('ZIP not found.');
    return {
      lat: parseFloat(place.latitude),
      lon: parseFloat(place.longitude),
      label: `${j['post code']} ${place['place name']}, ${place['state abbreviation']}`
    };
  } else {
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
  const hourlyUrl = props.forecastHourly;

  const [daily, grid, hourly] = await Promise.all([fetchJSON(foreUrl), fetchJSON(gridUrl), fetchJSON(hourlyUrl)]);
  return { place: place || 'Selected location', daily, grid, hourly };
}

function buildAllCharts(series){
  // size all canvases first
  Object.values(els.canvases).forEach(sizeCanvasToParent);

  // build datasets per facet
  const labels = series.tAxis;
  charts.temp = makeFacetChart(els.canvases.temp, {
    labels,
    nightBands: series.nightBands,
    datasets: [
      { label:'Temperature (°F)', data: series.temperature, borderColor:getCSS('--temp'), backgroundColor:'transparent', yAxisID:'y', tension:0.3, pointRadius:0, spanGaps:true },
      { label:'Dew Point (°F)', data: series.dewpoint, borderColor:getCSS('--dew'), backgroundColor:'transparent', yAxisID:'y', tension:0.3, pointRadius:0, spanGaps:true },
    ],
    scales: {
      x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
      y: { position:'left', ticks:{ color:getCSS('--temp') }, grid:{ color:getCSS('--grid') } }
    }
  });

  charts.humid = makeFacetChart(els.canvases.humid, {
    labels,
    nightBands: series.nightBands,
    datasets: [
      { label:'Humidity (%)', data: series.humidity, borderColor:getCSS('--humid'), backgroundColor:'transparent', yAxisID:'y', tension:0.2, pointRadius:0, spanGaps:true },
      { label:'Cloud Cover (%)', data: series.cloud, borderColor:'transparent', backgroundColor:hexWithAlpha(getCSS('--cloud'),0.3), yAxisID:'y', type:'line', fill:true, pointRadius:0, spanGaps:true },
    ],
    scales: {
      x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
      y: { position:'left', min:0, max:100, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } }
    }
  });

  charts.precip = makeFacetChart(els.canvases.precip, {
    labels,
    nightBands: series.nightBands,
    datasets: [
      { label:'Hourly Liquid (in)', data: series.qpfHourly, type:'bar', yAxisID:'y', backgroundColor:getCSS('--qpf'), borderWidth:0 },
      { label:'Precip Accum (in)', data: series.qpfAccum, borderColor:getCSS('--qpf'), backgroundColor:'transparent', yAxisID:'y', tension:0.2, pointRadius:0, spanGaps:true },
      { label:'Chance of Precip (%)', data: series.pop, borderColor:'transparent', backgroundColor:hexWithAlpha(getCSS('--pop'),0.35), yAxisID:'y2', type:'line', fill:true, pointRadius:0, spanGaps:true },
    ],
    scales: {
      x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
      y: { position:'left', ticks:{ color:getCSS('--qpf') }, grid:{ color:getCSS('--grid') } },
      y2:{ position:'right', min:0, max:100, ticks:{ color:getCSS('--pop') }, grid:{ display:false } }
    }
  });

  charts.wind = makeFacetChart(els.canvases.wind, {
    labels,
    nightBands: series.nightBands,
    datasets: [
      { label:'Wind (mph)', data: series.wind, borderColor:getCSS('--wind'), backgroundColor:'transparent', yAxisID:'y', tension:0.2, pointRadius:2, spanGaps:true },
    ],
    scales: {
      x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
      y: { position:'left', ticks:{ color:getCSS('--wind') }, grid:{ color:getCSS('--grid') } }
    }
  });

  charts.press = makeFacetChart(els.canvases.press, {
    labels,
    nightBands: series.nightBands,
    datasets: [
      { label:'Pressure (inHg)', data: series.pressure, borderColor:getCSS('--press'), backgroundColor:'transparent', yAxisID:'y', tension:0.2, pointRadius:0, spanGaps:true },
    ],
    scales: {
      x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
      y: { position:'left', ticks:{ color:getCSS('--press') }, grid:{ color:getCSS('--grid') } }
    }
  });

  // crosshair sync: listen on top facet for mousemove/touch and update all
  const topCanvas = els.canvases.temp;
  const handler = (evt) => {
    const rect = topCanvas.getBoundingClientRect();
    const x = (evt.touches && evt.touches[0]) ? (evt.touches[0].clientX - rect.left) : (evt.clientX - rect.left);
    const xScale = charts.temp.scales.x;
    const ts = xScale.getValueForPixel(x);
    if (!ts) return;
    CROSSHAIR_TS = ts;
    Object.values(charts).forEach(ch => ch.update('none'));
    updateReadout(lastSeries, ts);
  };
  topCanvas.addEventListener('mousemove', handler);
  topCanvas.addEventListener('touchmove', handler, { passive:true });

  // handle window resize (manual)
  window.addEventListener('resize', () => {
    for (const [k,canvas] of Object.entries(els.canvases)){
      sizeCanvasToParent(canvas);
      charts[k].resize(canvas.width, canvas.height);
      charts[k].update('none');
    }
  });
}

function getCSS(varName){ return getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); }
function hexWithAlpha(hex, alpha){
  const h = hex.replace('#','');
  const r = parseInt(h.substring(0,2),16);
  const g = parseInt(h.substring(2,4),16);
  const b = parseInt(h.substring(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

async function showForecast(lat, lon, labelOverride){
  els.place.textContent = 'Loading…';
  els.updated.textContent = '';

  const { place, daily, grid, hourly } = await loadByLatLon(lat, lon);
  const label = labelOverride || place || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  els.place.textContent = label;
  const upd = grid.properties.updateTime || daily.properties.updated || new Date().toISOString();
  els.updated.textContent = `Updated ${new Date(upd).toLocaleString()}`;

  const series = buildSeries(grid, hourly);
  lastSeries = series;

  renderDayStrip(daily, series.qpfByDay);
  buildAllCharts(series);

  // initialize readout at first timestamp
  if (series.tAxis.length){
    CROSSHAIR_TS = series.tAxis[0];
    updateReadout(series, CROSSHAIR_TS);
    Object.values(charts).forEach(ch => ch.update('none'));
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
