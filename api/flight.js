const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(m => m.default(...args)));
const CACHE_TTL = 15000;
const STALE_WHILE_REVALIDATE = 30000;
const CACHE_CONTROL = `public, s-maxage=${CACHE_TTL / 1000}, stale-while-revalidate=${STALE_WHILE_REVALIDATE / 1000}`;

let cache = { ts: 0, callsign: null, data: null };
let pendingFetch = null;

const API_ENDPOINT = process.env.ADSBFI_API_URL || 'https://opendata.adsb.fi/api/v2/callsign/{callsign}';
const API_METHOD = 'GET';
const DEFAULT_CALLSIGN = process.env.ADSBFI_CALLSIGN || 'MLM712';

function getCallsign(req) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const callsign = (requestUrl.searchParams.get('callsign') ||
    requestUrl.searchParams.get('flight_icao') || DEFAULT_CALLSIGN).trim().toUpperCase();

  // ICAO callsigns only contain letters and digits. Restricting the value also
  // prevents an arbitrary path from being appended to the upstream URL.
  if(!/^[A-Z0-9]{2,10}$/.test(callsign)) throw new Error('invalid callsign');
  return callsign;
}

function getUpstreamUrl(callsign) {
  if(API_ENDPOINT.includes('{callsign}')) {
    return API_ENDPOINT.replace('{callsign}', encodeURIComponent(callsign));
  }
  return `${API_ENDPOINT.replace(/\/$/, '')}/${encodeURIComponent(callsign)}`;
}

function isAirborne(aircraft) {
  return aircraft.alt_baro !== 'ground' && aircraft.alt_geom !== 'ground' &&
    (Number(aircraft.alt_baro) > 0 || Number(aircraft.alt_geom) > 0 || Number(aircraft.gs) > 30);
}

async function fetchFlightFromAdsbFi(callsign) {
  const upstreamUrl = getUpstreamUrl(callsign);
  console.log(`[flight api] ${API_METHOD} ${upstreamUrl}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(upstreamUrl, {
      method: API_METHOD,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'lech-live/1'
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  console.log(`[flight api] upstream response ${response.status} ${response.statusText || ''}`.trim());
  if(!response.ok) throw new Error(`upstream ${response.status} for ${upstreamUrl}`);

  const upstream = await response.json();
  const aircraft = Array.isArray(upstream.ac)
    ? upstream.ac.find(item => String(item.flight || '').trim().toUpperCase() === callsign) || upstream.ac[0]
    : null;
  if(!aircraft) throw new Error(`no aircraft returned for ${callsign}`);

  const seenSeconds = Number(aircraft.seen_pos ?? aircraft.seen);
  const upstreamTimestamp = Number(upstream.now);
  const updatedAt = Number.isFinite(upstreamTimestamp)
    ? upstreamTimestamp - (Number.isFinite(seenSeconds) ? seenSeconds * 1000 : 0)
    : Date.now();

  const out = {
    callsign: String(aircraft.flight || callsign).trim(),
    flightIcao: String(aircraft.flight || callsign).trim(),
    aircraft: aircraft.r || null,
    aircraftType: aircraft.t || null,
    aircraftDescription: aircraft.desc || null,
    lat: aircraft.lat ?? null,
    lon: aircraft.lon ?? null,
    altitude: typeof aircraft.alt_baro === 'number' ? aircraft.alt_baro : null,
    // TAS/IAS are optional in ADSB.fi; GS is the consistently available fallback.
    airSpeed: aircraft.tas ?? aircraft.ias ?? aircraft.gs ?? null,
    airSpeedType: aircraft.tas != null ? 'TAS' : aircraft.ias != null ? 'IAS' : aircraft.gs != null ? 'GS' : null,
    groundSpeed: aircraft.gs ?? null,
    track: aircraft.track ?? null,
    status: isAirborne(aircraft) ? 'en-route' : 'unknown',
    updated: updatedAt,
    ts: updatedAt
  };

  cache = { ts: Date.now(), callsign, data: out };
  console.log('[flight api] mapped ADSB.fi response', out);
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', CACHE_CONTROL);

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
