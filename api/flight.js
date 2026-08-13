const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(m => m.default(...args)));
const CACHE_TTL = 2 * 60 * 1000;
const STALE_WHILE_REVALIDATE = 5 * 60 * 1000;
const BROWSER_CACHE_TTL = 60;
const CDN_CACHE_CONTROL = `public, max-age=${CACHE_TTL / 1000}, stale-while-revalidate=${STALE_WHILE_REVALIDATE / 1000}`;

let cache = { ts: 0, callsign: null, data: null };
let pendingFetch = null;

const API_ENDPOINT = process.env.ADSBFI_API_URL || 'https://opendata.adsb.fi/api/v2/callsign/{callsign}';
const API_METHOD = 'GET';
const DEFAULT_CALLSIGN = process.env.ADSBFI_CALLSIGN || 'MLM712';
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

async function fetchFlightFromAdsbFi(callsign) {
  const upstreamUrl = API_ENDPOINT.replace('{callsign}', encodeURIComponent(callsign));
  console.log(`[flight api] ${API_METHOD} ${upstreamUrl}`);

  const response = await fetchWithRetry(upstreamUrl);

  console.log(`[flight api] upstream response ${response.status} ${response.statusText || ''}`.trim());
  if(!response.ok) throw new Error(`upstream ${response.status} for ${upstreamUrl}`);

  const upstream = await response.json();
  const aircraft = Array.isArray(upstream.ac)
    ? upstream.ac.find(item => String(item.flight || '').trim().toUpperCase() === callsign) || upstream.ac[0]
    : null;

  if(!aircraft) {
    const upstreamTimestamp = Number(upstream.now);
    const checkedAt = Number.isFinite(upstreamTimestamp) ? upstreamTimestamp : Date.now();
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
    console.log(`[flight api] ADSB.fi has no active signal for ${callsign}`);
    return out;
  }

  const callsignFromApi = String(aircraft.flight || callsign).trim();
  const seenSeconds = Number(aircraft.seen_pos ?? aircraft.seen);
  const upstreamTimestamp = Number(upstream.now);
  const updatedAt = Number.isFinite(upstreamTimestamp)
    ? upstreamTimestamp - (Number.isFinite(seenSeconds) ? seenSeconds * 1000 : 0)
    : Date.now();
  const airborne = aircraft.alt_baro !== 'ground' && aircraft.alt_geom !== 'ground' &&
    (Number(aircraft.alt_baro) > 0 || Number(aircraft.alt_geom) > 0 || Number(aircraft.gs) > 30);

  const out = {
    callsign: callsignFromApi,
    flightIcao: callsignFromApi,
    aircraft: aircraft.r || null,
    aircraftType: aircraft.t || null,
    aircraftDescription: aircraft.desc || null,
    lat: aircraft.lat ?? null,
    lon: aircraft.lon ?? null,
    altitude: typeof aircraft.alt_baro === 'number' ? aircraft.alt_baro : null,
    airSpeed: aircraft.tas ?? aircraft.ias ?? aircraft.gs ?? null,
    airSpeedType: aircraft.tas != null ? 'TAS' : aircraft.ias != null ? 'IAS' : aircraft.gs != null ? 'GS' : null,
    groundSpeed: aircraft.gs ?? null,
    track: aircraft.track ?? null,
    status: airborne ? 'en-route' : 'unknown',
    tracked: true,
    source: 'ADSB.fi',
    updated: updatedAt,
    ts: updatedAt
  };

  cache = { ts: Date.now(), callsign, data: out };
  console.log('[flight api] mapped ADSB.fi response', out);
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
      const promise = fetchFlightFromAdsbFi(callsign).finally(() => {
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
