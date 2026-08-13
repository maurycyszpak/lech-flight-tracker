const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(m=>m.default(...args)));
const CACHE_TTL = 15000;
const STALE_WHILE_REVALIDATE = 30000;
const CACHE_CONTROL = `public, s-maxage=${CACHE_TTL / 1000}, stale-while-revalidate=${STALE_WHILE_REVALIDATE / 1000}`;

let cache = { ts:0, data:null };
let pendingFetch = null;

const API_ENDPOINT = process.env.AIRLABS_API_URL || 'https://airlabs.co/api/v9/flight';
const API_METHOD = 'GET';
const DEFAULT_FLIGHT_ICAO = process.env.AIRLABS_FLIGHT_ICAO || 'FLI453';

function pickFlightDebug(f) {
  return {
    lat: f.lat ?? null,
    lng: f.lng ?? null,
    airline_name: f.airline_name || null,
    status: f.status || null,
    dep_actual: f.dep_actual || null,
    arr_estimated: f.arr_estimated || null
  };
}

async function fetchFlightFromAirlabs(req) {
  const AIRLABS_API_KEY = process.env.AIRLABS_API_KEY;
  if(!AIRLABS_API_KEY){
    console.error('[flight api] AIRLABS_API_KEY is not set');
    return { error: 'Set AIRLABS_API_KEY in env' };
  }

  const requestUrl = new URL(req.url, 'http://localhost');
  const flightIcao = requestUrl.searchParams.get('flight_icao') || DEFAULT_FLIGHT_ICAO;
  const upstreamUrl = new URL(API_ENDPOINT);
  upstreamUrl.searchParams.set('flight_icao', flightIcao);
  upstreamUrl.searchParams.set('api_key', AIRLABS_API_KEY);

  const safeUrl = new URL(upstreamUrl.href);
  safeUrl.searchParams.set('api_key', '[hidden]');
  console.log(`[flight api] ${API_METHOD} ${safeUrl.href}`);
  const r = await fetch(upstreamUrl.href, {
    method: API_METHOD,
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'lech-live/1'
    },
    timeout: 10000
  });
  console.log(`[flight api] upstream response ${r.status} ${r.statusText || ''}`.trim());
  if(!r.ok) throw new Error(`upstream ${r.status} for ${safeUrl.href}`);

  const upstream = await r.json();
  console.log('[flight api] AirLabs response', pickFlightDebug(upstream.response || {}));
  const f = upstream.response || {};
  if(upstream.error || !Object.keys(f).length) throw new Error(upstream.error && upstream.error.message || 'no flight returned');

  const out = {
    callsign: f.flight_icao || flightIcao,
    flightIcao: f.flight_icao || flightIcao,
    aircraft: f.reg_number || null,
    lat: f.lat ?? null,
    lon: f.lng ?? null,
    airlineName: f.airline_name || null,
    status: f.status || null,
    depActual: f.dep_actual || null,
    arrEstimated: f.arr_estimated || null,
    updated: f.updated || null,
    ts: Date.now()
  };

  cache = { ts: Date.now(), data: out };
  console.log('[flight api] mapped response', out);
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', CACHE_CONTROL);

  const now = Date.now();
  if(now - cache.ts < CACHE_TTL && cache.data) {
    console.log('[flight api] cache hit');
    return res.json(cache.data);
  }

  try{
    if(!pendingFetch) {
      pendingFetch = fetchFlightFromAirlabs(req).finally(() => {
        pendingFetch = null;
      });
    } else {
      console.log('[flight api] joining pending upstream request');
    }

    const out = await pendingFetch;
    if(out && out.error) return res.status(400).json(out);
    return res.json(out);
  }catch(e){
    if(cache.data) {
      console.error('[flight api] upstream failed, serving stale cache', e);
      return res.json({...cache.data, stale: true, error: String(e)});
    }
    console.error('[flight api] failed with no cache', e);
    return res.status(502).json({ error: String(e) });
  }
};
