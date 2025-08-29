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
    press: document.getElementById('chart-press'),
  },
  pressFacet: document.getElementById('facet-press'),
};

let CROSSHAIR_TS = null;
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

// Build a per-day map of sunrise/sunset by scanning hourly isDaytime transitions
// Accurate sunrise/sunset from solar elevation zero-crossings (NOAA-style)
function computeSunriseSunset(series, lat, lon, timeZone) {
  const map = new Map(); // key: local date string -> { sunrise, sunset }
  if (!series?.tAxis?.length) return map;

  const sign = v => (v === 0 ? 0 : v > 0 ? 1 : -1);
  const fmt  = ts => new Date(ts).toLocaleTimeString([], { timeZone, hour: 'numeric', minute: '2-digit' });

  // Binary-search refine of the crossing time in [t0,t1]
  const refine = (t0, t1) => {
    for (let i = 0; i < 10; i++) {
      const tm = (t0 + t1) / 2;
      const e0 = solarElevation(new Date(t0), lat, lon);
      const em = solarElevation(new Date(tm), lat, lon);
      // keep the half interval that contains the sign change
      if ((e0 <= 0 && em >= 0) || (e0 >= 0 && em <= 0)) t1 = tm; else t0 = tm;
    }
    return (t0 + t1) / 2;
  };

  for (let i = 1; i < series.tAxis.length; i++) {
    const t0 = series.tAxis[i - 1];
    const t1 = series.tAxis[i];

    const e0 = solarElevation(new Date(t0), lat, lon);
    const e1 = solarElevation(new Date(t1), lat, lon);
    if (sign(e0) === sign(e1)) continue;       // no crossing in this interval

    const tc = refine(t0, t1);                  // exact crossing timestamp
    const dayKey = new Date(tc).toLocaleDateString([], { timeZone });
    const rec = map.get(dayKey) || {};

    if (e0 < 0 && e1 > 0 && !rec.sunrise) rec.sunrise = fmt(tc); // night->day
    if (e0 > 0 && e1 < 0 && !rec.sunset)  rec.sunset  = fmt(tc); // day->night

    map.set(dayKey, rec);
  }
  return map;
}

// Local-time formatter for a timestamp
function fmtLocalTime(ts, timeZone) {
  return new Date(ts).toLocaleTimeString([], { timeZone, hour: 'numeric', minute: '2-digit' });
}

// Refine the exact crossing time (sun elevation == 0) by binary search
function refineSunCrossing(t0, t1, lat, lon) {
  // 8–10 iterations is plenty; ~few seconds resolution
  for (let i = 0; i < 10; i++) {
    const tm = (t0 + t1) / 2;
    const e0 = solarElevation(new Date(t0), lat, lon);
    const em = solarElevation(new Date(tm), lat, lon);
    // Keep the sub-interval that contains the zero-crossing
    if ((e0 <= 0 && em >= 0) || (e0 >= 0 && em <= 0)) {
      t1 = tm;
    } else {
      t0 = tm;
    }
  }
  return (t0 + t1) / 2;
}

// Compute accurate per-day sunrise/sunset by scanning solar elevation sign changes
function computeSunriseSunsetPrecise(series, lat, lon, timeZone) {
  const map = new Map(); // key: dateString in timeZone -> { sunrise, sunset }
  if (!series || !series.tAxis?.length) return map;

  const sign = (v) => (v === 0 ? 0 : v > 0 ? 1 : -1);

  for (let i = 1; i < series.tAxis.length; i++) {
    const tPrev = series.tAxis[i - 1];
    const tCur  = series.tAxis[i];

    const ePrev = solarElevation(new Date(tPrev), lat, lon);
    const eCur  = solarElevation(new Date(tCur),  lat, lon);

    const sPrev = sign(ePrev);
    const sCur  = sign(eCur);

    if (sPrev === sCur) continue; // no crossing in this interval

    // Crossing exists in [tPrev, tCur]; refine to exact time
    const tCross = refineSunCrossing(tPrev, tCur, lat, lon);

    // The "calendar day" should be computed in the *location's* time zone
    const dayKey = new Date(tCross).toLocaleDateString([], { timeZone });

    const rec = map.get(dayKey) || {};
    if (ePrev < 0 && eCur > 0 && !rec.sunrise) {
      // Night → Day
      rec.sunrise = fmtLocalTime(tCross, timeZone);
    } else if (ePrev > 0 && eCur < 0 && !rec.sunset) {
      // Day → Night
      rec.sunset = fmtLocalTime(tCross, timeZone);
    }
    map.set(dayKey, rec);
  }
  return map;
}

function renderDayStrip(daily, qpfByDay, sunTimes) {
  const daysEl = els.dayStrip;
  daysEl.innerHTML = '';
  const periods = (daily.properties?.periods || []).filter(p => p.isDaytime);

  periods.forEach(p => {
    const date = new Date(p.startTime);
    const name = date.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
    const emoji = forecastToEmoji(p.shortForecast);
    const qpf = qpfByDay.get(date.toDateString()) || 0;

    const sun = sunTimes?.get(date.toLocaleDateString([], { timeZone: sunTimes?.timeZone || undefined })) || {};
    // Fallback: try key by Date.toDateString() if the above is undefined
    const fallback = sunTimes?.get(date.toDateString()) || {};
    const sr = sun.sunrise || fallback.sunrise || '—';
    const ss = sun.sunset  || fallback.sunset  || '—';

    const card = document.createElement('div');
    card.className = 'day';
    card.innerHTML = `
      <div class="name">${name}</div>
      <div class="emoji" aria-hidden="true">${emoji}</div>
      <div class="temps"><span class="hi">${p.temperature}°F</span><span class="lo">${findNightLowFor(p, daily)}°F</span></div>
      <div class="sun"><span class="sunline">🌅 ${sr}</span> · <span class="sunline">🌇 ${ss}</span></div>
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
            title(items){ const i = items[0].dataIndex; return fmtHour(cfg.labels[i]); },
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
  return { place: place || 'Selected location', daily, grid, hourly, timeZone: props.timeZone || 'UTC' };
}

function buildAllCharts(series){
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

  if (series.pressure){
    els.pressFacet.style.display = '';
    charts.press = makeFacetChart(els.canvases.press, {
      labels, nightBands: series.nightBands, dayDivs: series.dayDivs,
      datasets: [
        { label:'Pressure (inHg)', data: series.pressure, borderColor:getCSS('--press'), backgroundColor:'transparent', yAxisID:'y', tension:0.2, pointRadius:0, spanGaps:true },
      ],
      scales: {
        x: { type:'time', time:{ unit:'hour' }, ticks:{ color:'#6b7280' }, grid:{ color:getCSS('--grid') } },
        y: { position:'left', ticks:{ color:getCSS('--press') }, grid:{ color:getCSS('--grid') } }
      }
    });
  } else {
    els.pressFacet.style.display = 'none';
  }

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
  els.place.textContent = 'Loading…';
  els.updated.textContent = '';

  const { place, daily, grid, hourly, timeZone } = await loadByLatLon(lat, lon);
  const label = labelOverride || place || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  els.place.textContent = label;
  const upd = grid.properties.updateTime || daily.properties.updated || new Date().toISOString();
  els.updated.textContent = `Updated ${new Date(upd).toLocaleString()}`;

  const series = buildSeries(grid, hourly);
  lastSeries = series;

  const tz = timeZone || 'UTC'; // timeZone should come from loadByLatLon()
  const sunTimes = computeSunriseSunset(series, grid.geometry.coordinates[1], grid.geometry.coordinates[0], tz);
  renderDayStrip(daily, series.qpfByDay, sunTimes);
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
