const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(m => m.default(...args)));
const CACHE_TTL = 2 * 60 * 1000;
const STALE_WHILE_REVALIDATE = 5 * 60 * 1000;
const BROWSER_CACHE_TTL = 60;
const CDN_CACHE_CONTROL = `public, max-age=${CACHE_TTL / 1000}, stale-while-revalidate=${STALE_WHILE_REVALIDATE / 1000}`;

let cache = { ts: 0, callsign: null, data: null };
let pendingFetch = null;

const API_ENDPOINT = process.env.OPENSKY_API_URL || 'https://opensky-network.org/api/states/all';
const API_METHOD = 'GET';
const DEFAULT_CALLSIGN = process.env.OPENSKY_CALLSIGN || process.env.ADSBFI_CALLSIGN || 'MLM712';
const DEFAULT_ICAO24 = process.env.OPENSKY_ICAO24 || '4d2162';
const UPSTREAM_TIMEOUT = 12000;
const UPSTREAM_ATTEMPTS = 2;

function getCallsign(req) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const callsign = (requestUrl.searchParams.get('callsign') ||
    requestUrl.searchParams.get('flight_icao') || DEFAULT_CALLSIGN).trim().toUpperCase();

  // ICAO callsigns only contain letters and digits. Restricting the value also
  // prevents an arbitrary path from being appended to the upstream URL.
  if(!/^[A-Z0-9]{2,10}$/.test(callsign)) throw new Error('invalid callsign');
  return callsign;
}

async function fetchWithRetry(url) {
  let lastError;
  for(let attempt = 1; attempt <= UPSTREAM_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
    try {
      const response = await fetch(url, {
        method: API_METHOD,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'lech-live/1'
        },
        signal: controller.signal
      });
      if(response.status < 500 || attempt === UPSTREAM_ATTEMPTS) return response;
      lastError = new Error(`upstream ${response.status}`);
    } catch(error) {
      lastError = error;
      if(attempt === UPSTREAM_ATTEMPTS) throw error;
    } finally {
      clearTimeout(timeout);
    }
    console.warn(`[flight api] upstream attempt ${attempt} failed, retrying`, String(lastError));
  }
  throw lastError;
}

async function fetchFlightFromOpenSky(callsign) {
  const upstreamUrl = new URL(API_ENDPOINT);
  upstreamUrl.searchParams.set('icao24', DEFAULT_ICAO24);
  console.log(`[flight api] ${API_METHOD} ${upstreamUrl.href}`);

  const response = await fetchWithRetry(upstreamUrl.href);

  console.log(`[flight api] upstream response ${response.status} ${response.statusText || ''}`.trim());
  if(!response.ok) throw new Error(`upstream ${response.status} for ${upstreamUrl.href}`);

  const upstream = await response.json();
  const state = Array.isArray(upstream.states) ? upstream.states[0] : null;

  if(!state) {
    const upstreamTimestamp = Number(upstream.time);
    const checkedAt = Number.isFinite(upstreamTimestamp) ? upstreamTimestamp * 1000 : Date.now();
    const out = {
      callsign,
      flightIcao: callsign,
      aircraft: null,
      aircraftType: null,
      aircraftDescription: null,
      lat: null,
      lon: null,
      altitude: null,
      airSpeed: null,
      airSpeedType: null,
      groundSpeed: null,
      track: null,
      status: 'not-tracked',
      tracked: false,
      updated: checkedAt,
      ts: checkedAt
    };
    cache = { ts: Date.now(), callsign, data: out };
    console.log(`[flight api] OpenSky has no active signal for ${callsign} (${DEFAULT_ICAO24})`);
    return out;
  }

  const callsignFromApi = String(state[1] || callsign).trim();
  const lastContact = Number(state[4]);
  const updatedAt = Number.isFinite(lastContact) ? lastContact * 1000 : Date.now();
  const altitudeMeters = Number(state[7] ?? state[13]);
  const velocityMetersPerSecond = Number(state[9]);
  const groundSpeedKnots = Number.isFinite(velocityMetersPerSecond)
    ? Math.round(velocityMetersPerSecond * 1.943844 * 10) / 10
    : null;

  const out = {
    callsign: callsignFromApi,
    flightIcao: callsignFromApi,
    aircraft: null,
    aircraftType: null,
    aircraftDescription: null,
    lat: state[6] ?? null,
    lon: state[5] ?? null,
    altitude: Number.isFinite(altitudeMeters) ? Math.round(altitudeMeters * 3.28084) : null,
    airSpeed: groundSpeedKnots,
    airSpeedType: groundSpeedKnots != null ? 'GS' : null,
    groundSpeed: groundSpeedKnots,
    track: state[10] ?? null,
    status: state[8] === false ? 'en-route' : 'unknown',
    tracked: true,
    source: 'OpenSky Network',
    updated: updatedAt,
    ts: updatedAt
  };

  cache = { ts: Date.now(), callsign, data: out };
  console.log('[flight api] mapped OpenSky response', out);
  return out;
}

module.exports = async (req, res) => {
  // Browser cache reduces repeat calls per visitor. The Vercel-specific header
  // creates one shared CDN response for all visitors in a region.
  res.setHeader('Cache-Control', `public, max-age=${BROWSER_CACHE_TTL}`);
  res.setHeader('Vercel-CDN-Cache-Control', CDN_CACHE_CONTROL);

  let callsign;
  try {
    callsign = getCallsign(req);
  } catch(e) {
    return res.status(400).json({ error: String(e.message || e) });
  }

  const now = Date.now();
  if(now - cache.ts < CACHE_TTL && cache.data && cache.callsign === callsign) {
    console.log(`[flight api] cache hit callsign=${callsign}`);
    return res.json(cache.data);
  }

  try {
    if(!pendingFetch || pendingFetch.callsign !== callsign) {
      const promise = fetchFlightFromOpenSky(callsign).finally(() => {
        if(pendingFetch && pendingFetch.promise === promise) pendingFetch = null;
      });
      pendingFetch = { callsign, promise };
    } else {
      console.log(`[flight api] joining pending upstream request callsign=${callsign}`);
    }

    return res.json(await pendingFetch.promise);
  } catch(e) {
    if(cache.data && cache.callsign === callsign) {
      console.error('[flight api] upstream failed, serving stale cache', e);
      return res.json({...cache.data, stale: true, error: String(e)});
    }
    console.error('[flight api] failed with no cache', e);
    return res.status(502).json({ error: String(e) });
  }
};
