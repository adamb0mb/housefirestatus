// Avista's public outage map (outagemap.myavista.com) is a white-labeled deployment
// of KUBRA's "Storm Center" product. The map itself is just a browser client for a
// set of static, unauthenticated JSON files KUBRA publishes per utility — the same
// files the public map fetches to draw outage markers. There's no official API or
// key; this mirrors the well-documented community reverse-engineering of that format
// (e.g. github.com/openkentuckiana/power-outage-data, github.com/fgregg/kubra).
//
// Flow: fetch the view's "currentState" (data file paths + a deployment id) -> fetch
// its "configuration" (which layer id holds outage clusters) -> compute the map tile
// (quadkey) containing the address at a fine zoom level, plus its 8 neighbors -> fetch
// each tile's JSON. Each entry is either a single outage (real lat/lng, customer
// count, cause, crew status, ETR) or, at coarser zooms, a cluster of several.

const KUBRA_BASE = "https://kubra.io/";
// Found by loading outagemap.myavista.com and reading the BOOTSTRAP_CONFIG it embeds
// (instanceId/viewId are stable per-utility identifiers, not secrets or session state).
const AVISTA_INSTANCE_ID = "b9478e86-d9d9-45b2-9579-b2639f77f3fe";
const AVISTA_VIEW_ID = "00763684-dd19-4651-b33f-51aa17a491a6";
const ZOOM = 14; // finest resolution KUBRA's tile pyramid offers (individual outages, not clusters)

function latLngToTileXY(lat, lng, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

function tileToQuadkey(x, y, zoom) {
  let quadkey = "";
  for (let i = zoom; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    quadkey += digit;
  }
  return quadkey;
}

// Decodes Google's polyline algorithm format, which KUBRA (over)uses to encode even
// single points. https://developers.google.com/maps/documentation/utilities/polylinealgorithm
function decodePolyline(encoded) {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const points = [];
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

async function fetchJsonNoThrow(url, userAgent) {
  try {
    const resp = await fetch(url, { headers: { "User-Agent": userAgent } });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    return null;
  }
}

async function getKubraViewInfo(userAgent, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://cache.internal/kubra-view-info");
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const stateUrl = `${KUBRA_BASE}stormcenter/api/v1/stormcenters/${AVISTA_INSTANCE_ID}/views/${AVISTA_VIEW_ID}/currentState?preview=false`;
  const state = await fetchJsonNoThrow(stateUrl, userAgent);
  if (!state?.data?.cluster_interval_generation_data || !state?.stormcenterDeploymentId) return null;

  const configUrl = `${KUBRA_BASE}stormcenter/api/v1/stormcenters/${AVISTA_INSTANCE_ID}/views/${AVISTA_VIEW_ID}/configuration/${state.stormcenterDeploymentId}?preview=false`;
  const config = await fetchJsonNoThrow(configUrl, userAgent);
  const layers = config?.config?.layers?.data?.interval_generation_data;
  const layerName = Array.isArray(layers) ? layers.find((l) => l.type?.startsWith("CLUSTER_LAYER"))?.id : null;
  if (!layerName) return null;

  const info = { clusterDataPath: state.data.cluster_interval_generation_data, layerName };

  const response = new Response(JSON.stringify(info), {
    headers: { "content-type": "application/json", "Cache-Control": "public, max-age=600" }
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return info;
}

function describeOutage(raw, lat, lng) {
  const desc = raw.desc || {};
  const point = decodePolyline(raw.geom?.p?.[0] || "")[0];
  if (!point) return null;
  return {
    distanceMiles: Math.round(haversineMiles(lat, lng, point[0], point[1]) * 100) / 100,
    isCluster: Boolean(desc.cluster),
    numberOut: desc.n_out ?? null,
    customersAffected: desc.cust_a?.val ?? null,
    cause: desc.cause?.["EN-US"] ?? null,
    etr: desc.etr ?? null,
    crewStatus: desc.crew_status?.["EN-US"] ?? null,
    startTime: desc.start_time ?? null,
    comment: desc.externalComments?.["EN-US"] ?? null
  };
}

// Returns { available: boolean, outages: [...] } — outages sorted nearest-first,
// covering roughly a 3x3-mile window around the point. available:false means the
// live feed couldn't be reached (format changed, KUBRA down, etc.), not "no outages".
export async function getNearbyAvistaOutages(lat, lng, userAgent, ctx) {
  const info = await getKubraViewInfo(userAgent, ctx);
  if (!info) return { available: false, outages: [] };

  const { x, y } = latLngToTileXY(lat, lng, ZOOM);
  const quadkeys = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      quadkeys.push(tileToQuadkey(x + dx, y + dy, ZOOM));
    }
  }

  const tileResults = await Promise.all(
    quadkeys.map(async (qk) => {
      const qkh = qk.slice(-3).split("").reverse().join("");
      const dataPath = info.clusterDataPath.replace("{qkh}", qkh);
      const url = `${KUBRA_BASE}${dataPath}/public/${info.layerName}/${qk}.json`;
      const data = await fetchJsonNoThrow(url, userAgent);
      return data?.file_data ?? [];
    })
  );

  const seen = new Set();
  const outages = [];
  for (const entries of tileResults) {
    for (const raw of entries) {
      const outage = describeOutage(raw, lat, lng);
      if (!outage) continue;
      const key = `${raw.desc?.inc_id ?? ""}:${outage.distanceMiles}:${outage.startTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      outages.push(outage);
    }
  }
  outages.sort((a, b) => a.distanceMiles - b.distanceMiles);

  return { available: true, outages: outages.slice(0, 8) };
}
