/* v4.2 — date labels, crosshair on all facets, hour-only tooltips,
 * and concise precip descriptors (rain/snow).
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
    hcp: document.getElementById('chart-hcp'),
    precip: document.getElementById('chart-precip'),
    wind: document.getElementById('chart-wind'),
    runindex: document.getElementById('chart-runindex'),
    press: document.getElementById('chart-press'),
  },
  sunFacet: document.getElementById('facet-sun'),
  sunTable: document.getElementById('suntimes-table'),
};

let CROSSHAIR_TS = null;

// === Sun Times helpers ===
const localTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const sunCache = new Map(); // key: `${lat},${lon},${date}` -> data

function dateISO(d){ return d.toISOString().slice(0,10); }
function parseClock(s){
  if (!s) return '—';
  const m = s.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
  return m ? m[1] : s;
}
function goldenFromApi(goldenStr){
  if (!goldenStr) return '—';
  const m = goldenStr.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  return m ? m[1] : parseClock(goldenStr);
}
async function fetchSunForDate(lat, lon, isoDate){
  const key = `${lat.toFixed(5)},${lon.toFixed(5)},${isoDate}`;
  if (sunCache.has(key)) return sunCache.get(key);
  const url = `https://api.sunrisesunset.io/json?lat=${lat}&lng=${lon}&date=${isoDate}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Sun API error');
  const js = await res.json();
  const out = js && js.results ? js.results : null;
  sunCache.set(key, out);
  return out;
}

function renderSunTable(days, lat, lon){
  // days: array of Date objects at local midnight
  const host = els.sunTable;
  if (!host) return;
  host.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'suntimes-grid';

    // One column per day
  Promise.all(days.map(d => fetchSunForDate(lat, lon, dateISO(d)))).then(results => {
    results.forEach((r, idx) => {
      const col = document.createElement('div');
      col.className = 'suntimes-col';
      const dawn = parseClock(r?.dawn || r?.first_light);
      const sunrise = parseClock(r?.sunrise);
      const solarnoon = parseClock(r?.solar_noon);
      const sunset = parseClock(r?.sunset);
      const dusk = parseClock(r?.dusk || r?.last_light);
      const golden = parseClock(r?.golden_hour);

      // Header with Weekday, M/D
      const d = days[idx];
      const header = document.createElement('div');
      header.className = 'suntimes-header';
      header.textContent = d.toLocaleDateString('en-US', {weekday:'short', month:'numeric', day:'numeric'});
      col.appendChild(header);

      const vals = [
        {cls:'dawn', txt:dawn, label:'Dawn'},
        {cls:'sunrise', txt:sunrise, label:'Sunrise'},
        {cls:'solarnoon', txt:solarnoon, label:'Solar noon'},
        {cls:'golden', txt:golden, label:'Golden hour'},
        {cls:'sunset', txt:sunset, label:'Sunset'},
        {cls:'dusk', txt:dusk, label:'Dusk'},
      ];

      vals.forEach(v => {
        const cell = document.createElement('div');
        cell.className = `suntimes-cell ${v.cls}`;
        cell.innerHTML = `<small>${v.txt}</small>`;
        cell.title = `${v.label}: ${v.txt}`;
        col.appendChild(cell);
      });
      wrap.appendChild(col);
    });
    host.appendChild(wrap);
  }).catch(err => {
    host.textContent = 'Sun times unavailable.';
  });
}

let charts = {};
let lastSeries = null;

const c2f = c => (c == null ? null : (c * 9) / 5 + 32);
const mm2in = mm => (mm == null ? null : mm / 25.4);
const kmh2mph = kmh => (kmh == null ? null : kmh * 0.621371);
const pa2inhg = pa => (pa == null ? null : pa / 3386.389);
const fmtPct = v => (v == null ? '—' : `${Math.round(v)}%`);
const fmtF = v => (v == null ? '—' : `${Math.round(v)}°F`);
const fmtIn = v => (v == null ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)} in`);
const fmtMph = v => (v == null ? '—' : `${Math.round(v)} mph`);
const fmtInHg = v => (v == null ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)} inHg`);
const fmtHour = ms => new Date(ms).toLocaleString([], {hour:'numeric'});
const fmtDowHour = ms => {
  const d = new Date(ms);
  const wd = d.toLocaleDateString([], {weekday:'short'});
  const hr = d.toLocaleString([], {hour:'numeric'});
  return `${wd} ${hr}`; // e.g., Mon 2 PM
};

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

// Emoji mapping
function forecastToEmoji(shortForecast) {
  const s = (shortForecast || '').toLowerCase();
  if (s.includes('thunder')) return '⛈️';
  if (s.includes('snow') || s.includes('flurr')) return '❄️';
  if (s.includes('sleet')) return '🌨️';
  if (s.includes('rain') || s.includes('showers') || s.includes('shower')) return '🌧️';
  if (s.includes('fog')) return '🌫️';
  if (s.includes('haze') || s.includes('smoke')) return '🌫️';
  if (s.includes('mostly sunny')) return '🌤️';
  if (s.includes('partly sunny') || s.includes('partly cloudy')) return '🌥️';
  if (s.includes('mostly cloudy') || s.includes('cloudy')) return '☁️';
  if (s.includes('sunny') || s.includes('clear')) return '🌞';
  return '🌡️';
}

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

// Precip descriptor (rain/snow) — concise, 1–3 words
function precipDescriptor(qpfIn, isSnow, snowIn){
  if (!qpfIn || qpfIn <= 0) return '';
  if (isSnow){
    const rate = snowIn != null ? snowIn : qpfIn * 10; // 10:1 fallback
    if (rate < 0.1) return 'flurries';
    if (rate < 0.3) return 'light snow';
    if (rate < 0.6) return 'mod. snow';
    return 'heavy snow';
  } else {
    if (qpfIn < 0.02) return 'misty';
    if (qpfIn < 0.04) return 'drizzle';
    if (qpfIn < 0.06) return 'light rain';
    if (qpfIn < 0.10) return 'moderate';
    return 'downpour';
  }
}


// Running Optimality Index (0–100; higher is better)
function runningOptimalityIndex({ T, DP, RH, PoP, Pamt, Wind }) {
  const tanh = (x) => Math.tanh(x);

  // Penalties
  const pT    = tanh(Math.abs(T - 55) / 15);                 // temp U-shape
  const pDP   = tanh(Math.max(0, DP - 55) / 7);              // muggy air
  const pCold = tanh(Math.max(0, 40 - T) / 20 + Math.max(0, 10 - DP) / 10); // very cold/dry

  // Precip: Option A+
  // Core ramp gets steep after ~0.02 in/hr, then a small extra penalty for amounts beyond 0.02
  const amt = Pamt || 0;
  const core = PoP * (1 - Math.exp(- amt / 0.02));                     // main ramp
  const extra = PoP * 0.10 * tanh(Math.max(0, amt - 0.02) / 0.03);     // + up to ~0.10 when >0.02 in/hr
  const pPrecip = Math.min(1, core + extra);

  // Wind: help when hot, hurt when cold
  const bWind = (T >= 65) ? tanh(Wind / 12) : 0;             // benefit in heat
  const pWind = (T <= 45) ? tanh(Math.max(0, Wind - 5) / 10) : 0; // penalty in cold

  // Combine
  const pBase    = 0.50 * pT + 0.30 * pDP + 0.20 * pCold;
  const pWindAdj = pBase * (1 - 0.35 * bWind) + 0.20 * pWind;
  const pFinal   = Math.min(1, pWindAdj + 0.50 * pPrecip);   // 50% weight on precip (Option A baseline)

  // 0–100 score
  return 100 * (1 - pFinal);
}

function buildSeries(grid, hourly) {
  const g = grid.properties;
  const temp = expandHourly(g.temperature.values, c2f);
  const dew = expandHourly(g.dewpoint.values, c2f);
  const rh = expandHourly(g.relativeHumidity.values, v => v);
  const cloud = expandHourly(g.skyCover.values, v => v);
  const pop = expandHourly(g.probabilityOfPrecipitation.values, v => v);
  const qpf = expandHourly(g.quantitativePrecipitation.values, mm2in);
  const snowfall = g.snowfallAmount?.values ? expandHourly(g.snowfallAmount.values, mm2in) : null;
  const wspd = expandHourly(g.windSpeed.values, kmh2mph);
  const press = g.pressure?.values ? expandHourly(g.pressure.values, pa2inhg) : null;

  const tAxis = mergeTimeAxis(temp, dew, rh, cloud, pop, qpf, wspd, press || new Map());

  // Night bands from hourly isDaytime
  const h = hourly.properties?.periods || [];
  const nightBands = [];
  for (let i=0; i<h.length; i++){
    if (h[i].isDaytime === false){
      const start = new Date(h[i].startTime).getTime();
      let end = start + 3600*1000;
      while (i+1 < h.length && h[i+1].isDaytime === false){
        i++; end += 3600*1000;
      }
      nightBands.push([start, end]);
    }
  }

  // Day divider timestamps (midnight local)
  const dayDivs = [];
  tAxis.forEach(ms => {
    const d = new Date(ms);
    if (d.getHours() === 0) dayDivs.push(ms);
  });

  // Centers between midnights for date labels
  const dateCenters = [];
  for (let i=0; i<dayDivs.length-1; i++){
    dateCenters.push( (dayDivs[i] + dayDivs[i+1]) / 2 );
  }

  // Per-day QPF for strip
  const qpfByDay = new Map();
  qpf.forEach((val, t) => {
    const d = new Date(t).toDateString();
    qpfByDay.set(d, (qpfByDay.get(d) || 0) + (val || 0));
  });

  const series = {
    tAxis, nightBands, dayDivs, dateCenters, qpfByDay,
    temperature: [], dewpoint: [], humidity: [], cloud: [], pop: [],
    qpfHourly: [], wind: [], pressure: press ? [] : null,
    snowfall: snowfall ? [] : null,
    runIndex: [],
  };

  tAxis.forEach(ms => {
    series.temperature.push(at(temp, ms));
    series.dewpoint.push(at(dew, ms));
    series.humidity.push(at(rh, ms));
    series.cloud.push(at(cloud, ms));
    series.pop.push(at(pop, ms));
    series.qpfHourly.push(at(qpf, ms));
    series.wind.push(at(wspd, ms));
    if (press) series.pressure.push(at(press, ms));
    if (snowfall) series.snowfall.push(at(snowfall, ms));

    // Compute Run Index (0–100)
    const T = series.temperature[series.temperature.length-1];
    const DP = series.dewpoint[series.dewpoint.length-1];
    const RH = (series.humidity[series.humidity.length-1] ?? 0) / 100;      // 0–1
    const PoP = (series.pop[series.pop.length-1] ?? 0) / 100;               // 0–1
    const Pamt = series.qpfHourly[series.qpfHourly.length-1] ?? 0;          // inches/hr
    const Wind = series.wind[series.wind.length-1] ?? 0;                    // mph

    series.runIndex.push(runningOptimalityIndex({ T, DP, RH, PoP, Pamt, Wind }));
  });

  return series;
}

// Chart factory with plugins: night shading, crosshair, midnight lines, date labels (on top facet)
function makeFacetChart(canvas, cfg){
  const ctx = canvas.getContext('2d');
  const ch = new Chart(ctx, {
    type: 'line',
    data: { labels: cfg.labels, datasets: cfg.datasets },
    options: {
      responsive: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          backgroundColor: 'rgba(255,255,255,0.96)',
          borderColor: '#e5e7eb',
          borderWidth: 1,
          titleColor: '#111827',
          bodyColor: '#111827',
          displayColors: true,
          boxPadding: 4,
          callbacks: {
            title(items){ const i = items[0].dataIndex; return fmtDowHour(cfg.labels[i]); },
            label: (cfg.tooltipLabel || ((c)=>` ${c.dataset.label}: ${c.raw}`)),
            labelColor(ctx){
              const col = ctx.dataset.borderColor || '#111827';
              return {borderColor: col, backgroundColor: col};
            }
          }
        },
        nightShade: { bands: cfg.nightBands || [], color: 'rgba(125,125,125,0.08)' },
        crosshair: { color: 'rgba(0,0,0,0.35)', width: 1 },
        dayDividers: { times: cfg.dayDivs || [], color: getCSS('--gridMid') },
        dateLabels: { centers: cfg.dateCenters || [], enabled: !!cfg.showDateLabels }
      },
      scales: cfg.scales
    },
    plugins: [{
      id: 'backgroundPlugins',
      beforeDatasetsDraw(chart){
        const bands = chart.options.plugins.nightShade?.bands || [];
        const ncolor = chart.options.plugins.nightShade?.color || 'rgba(0,0,0,0.05)';
        const x = chart.scales.x;
        const area = chart.chartArea;
        const ctx = chart.ctx;
        ctx.save();
        ctx.fillStyle = ncolor;
        bands.forEach(([ts0, ts1]) => {
          const x0 = x.getPixelForValue(ts0);
          const x1 = x.getPixelForValue(ts1);
          ctx.fillRect(Math.min(x0,x1), area.top, Math.abs(x1-x0), area.bottom - area.top);
        });
        ctx.restore();

        const times = chart.options.plugins.dayDividers?.times || [];
        const dcolor = chart.options.plugins.dayDividers?.color || '#c7ceda';
        ctx.save();
        ctx.strokeStyle = dcolor;
        ctx.lineWidth = 1;
        times.forEach(ts => {
          const xp = x.getPixelForValue(ts);
          ctx.beginPath();
          ctx.moveTo(xp, area.top);
          ctx.lineTo(xp, area.bottom);
          ctx.stroke();
        });
        ctx.restore();

        // date labels (only if enabled, typically on top facet)
        const centers = chart.options.plugins.dateLabels?.centers || [];
        if (chart.options.plugins.dateLabels?.enabled){
          ctx.save();
          ctx.fillStyle = '#6b7280';
          ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          centers.forEach(ms => {
            const xmid = x.getPixelForValue(ms);
            const d = new Date(ms);
            const label = d.toLocaleDateString([], { weekday:'short', month:'numeric', day:'numeric' });
            ctx.fillText(label, xmid, area.top + 2);
          });
          ctx.restore();
        }
      },
      afterDatasetsDraw(chart){
        if (CROSSHAIR_TS == null) return;
        const x = chart.scales.x;
        const area = chart.chartArea;
        const ctx = chart.ctx;
        const xpix = x.getPixelForValue(CROSSHAIR_TS);
        ctx.save();
        ctx.strokeStyle = chart.options.plugins.crosshair?.color || 'rgba(0,0,0,0.35)';
        ctx.lineWidth = chart.options.plugins.crosshair?.width || 1;
        ctx.beginPath();
        ctx.moveTo(xpix, area.top);
        ctx.lineTo(xpix, area.bottom);
        ctx.stroke();
        ctx.restore();
      }
    }]
  });
  return ch;
}


function destroyAllCharts(){
  for (const k of Object.keys(charts)){
    try { charts[k]?.destroy(); } catch(e){ /* ignore */ }
  }
  charts = {};
}




function sizeCanvasToParent(canvas){
  const parent = canvas.parentElement;
  const width = Math.floor(parent.clientWidth - 20);
  const height = parseInt(canvas.getAttribute('height'), 10);
  canvas.width = width;
  canvas.height = height;
}

function updateReadout(series, ts){
  if (!series || !series.tAxis.length) { els.hoverReadout.textContent=''; return; }
  const tArr = series.tAxis;
  let lo = 0, hi = tArr.length - 1, mid;
  while (hi - lo > 1) { mid = (hi + lo) >> 1; if (tArr[mid] < ts) lo = mid; else hi = mid; }
  const idx = (Math.abs(tArr[lo] - ts) < Math.abs(tArr[hi] - ts)) ? lo : hi;

  const parts = [
    `${new Date(tArr[idx]).toLocaleString([], {weekday:'short', month:'numeric', day:'numeric', hour:'numeric'})}`,
    `Temp ${fmtF(series.temperature[idx])}`,
    `Dew ${fmtF(series.dewpoint[idx])}`,
    `RH ${fmtPct(series.humidity[idx])}`,
    `Cloud ${fmtPct(series.cloud[idx])}`,
    `PoP ${fmtPct(series.pop[idx])}`,
    `Wind ${fmtMph(series.wind[idx])}`,
  ];
  if (series.pressure) parts.push(`Press ${fmtInHg(series.pressure[idx])}`);
  if (series.qpfHourly[idx] != null) parts.push(`QPF ${fmtIn(series.qpfHourly[idx])}`);
  if (series.runIndex && series.runIndex[idx] != null) parts.push(`RunIdx ${Math.round(series.runIndex[idx])}`);
els.hoverReadout.textContent = parts.join(' | ');
}

async function geocodeQuery(q) {
  const zip = q.trim().match(/^\d{5}$/);
  if (zip) {
    const j = await fetchJSON(`https://api.zippopotam.us/us/${zip[0]}`);
    const place = j.places && j.places[0];
    if (!place) throw new Error('ZIP not found.');
    return {
      lat: parseFloat(place.latitude),
      lon: parseFloat(place.longitude),
      label: `${j['post code']} ${place['place name']}, ${j['state abbreviation'] || place['state abbreviation'] || ''}`
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
  destroyAllCharts();
  Object.values(els.canvases).forEach(c => c && sizeCanvasToParent(c));
  const labels = series.tAxis;

  const baseTitle = items => fmtHour(labels[items[0].dataIndex]);

  charts.temp = makeFacetChart(els.canvases.temp, {
    labels, nightBands: series.nightBands, dayDivs: series.dayDivs, dateCenters: series.dateCenters, showDateLabels: true,
    datasets: [
      { label:'Temperature (°F)', data: series.temperature, borderColor:getCSS('--temp'), backgroundColor:'transparent', yAxisID:'y', tension:0.3, pointRadius:0, spanGaps:true },
      { label:'Dew Point (°F)', data: series.dewpoint, borderColor:getCSS('--dew'), backgroundColor:'transparent', yAxisID:'y', tension:0.3, pointRadius:0, spanGaps:true },
    ],
    scales: {
      x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
      y: { position:'left', ticks:{ color:getCSS('--temp') }, grid:{ color:getCSS('--grid') } }
    }
  });

  charts.hcp = makeFacetChart(els.canvases.hcp, {
    labels, nightBands: series.nightBands, dayDivs: series.dayDivs,
    datasets: [
  { label:'Humidity (%)', data: series.humidity, borderColor:getCSS('--humid'),
    backgroundColor:'transparent', yAxisID:'y', tension:0.2, pointRadius:0, spanGaps:true },
  { label:'Cloud Cover (%)', data: series.cloud, borderColor:getCSS('--cloud'),
    backgroundColor:'transparent', yAxisID:'y', tension:0.2, pointRadius:0, spanGaps:true },
  { label:'Chance of Precip (%)', data: series.pop, borderColor:getCSS('--pop'),
    backgroundColor:hexWithAlpha(getCSS('--pop'),0.25), yAxisID:'y',
    tension:0.2, pointRadius:0, spanGaps:true, fill:true }
],
    scales: {
      x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
      y: { position:'left', min:0, max:100, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } }
    }
  });

  charts.precip = makeFacetChart(els.canvases.precip, {
    labels, nightBands: series.nightBands, dayDivs: series.dayDivs,
    datasets: [
      { label:'Hourly Liquid (in)', data: series.qpfHourly, type:'bar', yAxisID:'y', backgroundColor:getCSS('--qpf'), borderWidth:0 },
    ],
    scales: {
      x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
      y: { position:'left', ticks:{ color:getCSS('--qpf') }, grid:{ color:getCSS('--grid') } }
    }
  });
  // Custom tooltip label with descriptor
  charts.precip.options.plugins.tooltip.callbacks.label = (ctx) => {
    const i = ctx.dataIndex;
    const q = series.qpfHourly[i];
    const isSnow = (series.snowfall && ((series.snowfall[i]||0) > 0)) || (series.temperature[i] != null && series.temperature[i] <= 34);
    const snowIn = series.snowfall ? series.snowfall[i] : null;
    const desc = precipDescriptor(q || 0, !!isSnow, snowIn);
    const amount = (q == null ? '—' : `${(Math.round(q*100)/100).toFixed(2)} in`);
    return desc ? ` ${amount} · ${desc}` : ` ${amount}`;
  };

  charts.wind = makeFacetChart(els.canvases.wind, {
    labels, nightBands: series.nightBands, dayDivs: series.dayDivs,
    datasets: [
      { label:'Wind (mph)', data: series.wind, borderColor:getCSS('--wind'), backgroundColor:'transparent', yAxisID:'y', tension:0.2, pointRadius:2, spanGaps:true },
    ],
    scales: {
      x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
      y: { position:'left', ticks:{ color:getCSS('--wind') }, grid:{ color:getCSS('--grid') } }
    }
  });
  

  

  charts.runindex = makeFacetChart(els.canvases.runindex, {
    labels, nightBands: series.nightBands, dayDivs: series.dayDivs, dateCenters: series.dateCenters,
    datasets: [
      { label:'Run Index (0–100)', data: series.runIndex, borderColor:getCSS('--run'),
        backgroundColor:'transparent', yAxisID:'y', tension:0.3, pointRadius:0, spanGaps:true },
    ],
    scales: {
      x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
      y: { position:'left', min:0, max:100, ticks:{ color:getCSS('--run') }, grid:{ color:getCSS('--grid') } }
    }
  });

// Sun facet: show table aligned to other charts
  els.sunFacet.style.display = '';
  if (els.sunTable) els.sunTable.innerHTML='';
  // Build days from dayDivs; include next 7 day midnights or taken from labels
  const dayMidnights = (series.dayDivs || []).map(ms => new Date(ms));
  let days = dayMidnights.slice(0, 7);
  if (days.length === 0){ const today = new Date(); today.setHours(0,0,0,0); days = Array.from({length:7}, (_,i)=> new Date(today.getTime()+i*24*3600*1000)); }
  // grid.geometry.coordinates is [lon, lat] per GeoJSON
  renderSunTable(days, CURRENT_LAT, CURRENT_LON);
  // Crosshair + hover: attach to **all** canvases
  const moveFromCanvas = (canvasKey) => (evt) => {
    const ch = charts[canvasKey];
    const rect = ch.canvas.getBoundingClientRect();
    const x = (evt.touches && evt.touches[0]) ? (evt.touches[0].clientX - rect.left) : (evt.clientX - rect.left);
    const xScale = ch.scales.x;
    const ts = xScale.getValueForPixel(x);
    if (!ts) return;
    CROSSHAIR_TS = ts;
    Object.values(charts).forEach(c => c.update('none'));
    updateReadout(lastSeries, ts);
  };
  for (const key of Object.keys(charts)){
    const cv = charts[key].canvas;
    cv.addEventListener('mousemove', moveFromCanvas(key));
    cv.addEventListener('touchmove', moveFromCanvas(key), { passive:true });
  }

  // Handle window resize
  window.addEventListener('resize', () => {
    for (const [k,canvas] of Object.entries(els.canvases)){
      if (!canvas) continue;
      sizeCanvasToParent(canvas);
      charts[k]?.resize(canvas.width, canvas.height);
      charts[k]?.update('none');
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
  CURRENT_LAT = lat; CURRENT_LON = lon;
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
    pos => { showForecast(pos.coords.latitude, pos.coords.longitude); },
    err => { els.updated.textContent = 'Geolocation failed or was blocked. Use the search box.'; },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 }
  );
}

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

useBrowserLocation();