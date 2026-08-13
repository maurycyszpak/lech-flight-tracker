const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(m=>m.default(...args)));

// Weather API configuration. Keep {station}; it is replaced from ?station=EKVG.
const API_ENDPOINT = 'https://aviationweather.gov/api/data/metar?ids={station}&format=json';
const API_METHOD = 'GET';
const API_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'lech-live/1'
};

const CACHE_TTL = 5 * 60 * 1000;
const STALE_WHILE_REVALIDATE = 10 * 60 * 1000;
const BROWSER_CACHE_TTL = 5 * 60;
const CDN_CACHE_CONTROL = `public, max-age=${CACHE_TTL / 1000}, stale-while-revalidate=${STALE_WHILE_REVALIDATE / 1000}`;
let cache = {}; // per station
let pendingFetch = {}; // per station

async function fetchMetar(station, upstream) {
  console.log(`[weather api] station=${station}`);
  console.log(`[weather api] ${API_METHOD} ${upstream}`);
  console.log('[weather api] headers', API_HEADERS);
  const r = await fetch(upstream, {
    method: API_METHOD,
    headers: API_HEADERS,
    timeout: 10000
  });
  console.log(`[weather api] upstream response ${r.status} ${r.statusText || ''}`.trim());
  if(!r.ok) throw new Error(`upstream ${r.status} for ${upstream}`);

  const data = await r.json();
  const metar = Array.isArray(data) ? data[0] : data;
  if(!metar) throw new Error('no METAR returned for '+station);

  const raw = metar.rawOb || '';
  const summary = raw || [
    metar.icaoId || station,
    metar.temp != null ? `${metar.temp}C` : '',
    metar.wdir != null && metar.wspd != null ? `${metar.wdir}/${metar.wspd}KT` : '',
    metar.wxString || '',
    metar.cover || '',
    metar.fltCat || ''
  ].filter(Boolean).join(' ');

  return {
    station: metar.icaoId || station,
    raw,
    summary,
    reportTime: metar.reportTime,
    temp: metar.temp,
    dewp: metar.dewp,
    wdir: metar.wdir,
    wspd: metar.wspd,
    visib: metar.visib,
    altim: metar.altim,
    wxString: metar.wxString,
    cover: metar.cover,
    clouds: metar.clouds,
    fltCat: metar.fltCat,
    name: metar.name,
    ts: Date.now()
  };
}

module.exports = async (req, res) => {
  // METAR is shared and non-personalized, so Vercel can serve one cached result
  // to every visitor in a region without invoking this function again.
  res.setHeader('Cache-Control', `public, max-age=${BROWSER_CACHE_TTL}`);
  res.setHeader('Vercel-CDN-Cache-Control', CDN_CACHE_CONTROL);

  const requestUrl = new URL(req.url, 'http://localhost');
  const station = (requestUrl.searchParams.get('station') || 'EKVG').toUpperCase();
  const now = Date.now();
  if(cache[station] && (now - cache[station].ts < CACHE_TTL)) {
    console.log(`[weather api] cache hit station=${station}`);
    return res.json(cache[station].data);
  }

  const upstream = API_ENDPOINT.replace('{station}', encodeURIComponent(station));
  try{
    if(!pendingFetch[station]) {
      pendingFetch[station] = fetchMetar(station, upstream).finally(() => {
        delete pendingFetch[station];
      });
    } else {
      console.log(`[weather api] joining pending upstream request station=${station}`);
    }

    const out = await pendingFetch[station];
    cache[station] = { ts: now, data: out };
    return res.json(out);
  }catch(e){
    console.error(`[weather api] failed ${API_METHOD} ${upstream}`, e);
    if(cache[station] && cache[station].data) {
      return res.json({...cache[station].data, stale: true, refreshError: String(e)});
    }
    return res.status(502).json({ error: String(e), station, upstream });
  }
};
