import { PROVIDERS, SHELTERS, AUTHORITATIVE_LINKS } from "./data.js";
import { computeStatus, queryArcGIS, USER_AGENT } from "./status.js";
import { handleSubscribe, handleConfirm, handleUnsubscribe, runNotificationCheck } from "./subscriptions.js";

const CENSUS_GEOCODE_URL = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// This app only has evacuation/fire/utility data for Spokane & Stevens counties, so
// geocoding is hard-restricted (bounded=1, not just biased) to a box comfortably
// covering both — west/east/north/south padded a bit past each county's actual
// extent. Format is Nominatim's viewbox: "<west_lon>,<north_lat>,<east_lon>,<south_lat>".
const SERVICE_AREA_VIEWBOX = "-118.5,49.05,-116.7,47.0";

// Spokane County's own address point layer, used as a secondary geocode check /
// sanity check for addresses the Census geocoder can't match (new subdivisions,
// rebuilds on a cleared lot, etc).
const SPOKANE_ADDRESS_POINTS =
  "https://services3.arcgis.com/9UdSzuxhN4jGcI9p/arcgis/rest/services/Site_Address_Points/FeatureServer/0/query";

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extraHeaders
    }
  });
}

async function geocodeWithCensus(address) {
  const url = `${CENSUS_GEOCODE_URL}?address=${encodeURIComponent(
    address
  )}&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) return null;
  const data = await resp.json();
  const match = data?.result?.addressMatches?.[0];
  if (!match) return null;
  return {
    source: "census",
    matchedAddress: match.matchedAddress,
    lat: match.coordinates.y,
    lng: match.coordinates.x,
    county: match.geographies?.Counties?.[0]?.NAME ?? null,
    state: match.geographies?.Counties?.[0]?.STATE ?? null
  };
}

async function geocodeWithNominatim(address) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(
    address
  )}&format=json&addressdetails=1&countrycodes=us&limit=1&viewbox=${SERVICE_AREA_VIEWBOX}&bounded=1`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) return null;
  const data = await resp.json();
  const match = data?.[0];
  if (!match) return null;
  return {
    source: "nominatim",
    matchedAddress: match.display_name,
    lat: parseFloat(match.lat),
    lng: parseFloat(match.lon),
    county: match.address?.county ?? null,
    state: match.address?.state ?? null
  };
}

// Nominatim's free-text search returns one hit per named point of interest, so a
// shopping center with a dozen storefronts at the same street number comes back as
// a dozen near-duplicate results ("Gap, 808 W Main Ave", "Panda Express, 808 W Main
// Ave", ...). Build a plain "<number> <street>, <city>, <state> <zip>" label from
// the structured address instead, then dedupe by that label and put real street
// addresses ahead of bare POI names.
function buildSuggestionLabel(m) {
  const a = m.address || {};
  const city = a.city || a.town || a.village || a.hamlet || a.county;
  const state = a.state_code || a.state || "";
  if (a.house_number && a.road) {
    return [
      `${a.house_number} ${a.road}`,
      [city, [state, a.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    ]
      .filter(Boolean)
      .join(", ");
  }
  return m.display_name;
}

function dedupeAndRankSuggestions(rawResults) {
  const seen = new Set();
  const deduped = [];
  for (const m of rawResults) {
    const label = buildSuggestionLabel(m);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      label,
      lat: parseFloat(m.lat),
      lng: parseFloat(m.lon),
      isStreetAddress: Boolean(m.address?.house_number && m.address?.road)
    });
  }
  deduped.sort((a, b) => Number(b.isStreetAddress) - Number(a.isStreetAddress));
  return deduped.map(({ label, lat, lng }) => ({ label, lat, lng }));
}

async function handleSuggest(url, ctx) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 4) return jsonResponse({ suggestions: [] }, 200, { "Cache-Control": "no-store" });

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/suggest?q=${encodeURIComponent(q.toLowerCase())}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Hard-restricted (bounded=1) to the Spokane/Stevens County service area — this
  // app has no data for anywhere else, so a same-named street elsewhere in the
  // country shouldn't be suggested at all, not just deprioritized.
  const nomUrl = `${NOMINATIM_URL}?q=${encodeURIComponent(
    q
  )}&format=json&addressdetails=1&countrycodes=us&limit=10&viewbox=${SERVICE_AREA_VIEWBOX}&bounded=1`;

  let suggestions = [];
  try {
    const resp = await fetch(nomUrl, { headers: { "User-Agent": USER_AGENT } });
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data)) {
        suggestions = dedupeAndRankSuggestions(data).slice(0, 6);
      }
    }
  } catch (err) {
    suggestions = [];
  }

  const response = jsonResponse({ suggestions }, 200, { "Cache-Control": "public, max-age=120" });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleGeocode(url, ctx) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return jsonResponse({ error: "Missing 'q' address parameter" }, 400);

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/geocode?q=${encodeURIComponent(q.toLowerCase())}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let result = null;
  try {
    result = await geocodeWithCensus(q);
  } catch (err) {
    result = null;
  }
  if (!result) {
    try {
      result = await geocodeWithNominatim(q);
    } catch (err) {
      result = null;
    }
  }

  if (!result) return jsonResponse({ error: "Could not geocode that address" }, 404);

  const response = jsonResponse(result, 200, { "Cache-Control": "public, max-age=300" });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleStatus(url, ctx) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lng = parseFloat(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return jsonResponse({ error: "Missing/invalid lat,lng parameters" }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/status?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const payload = await computeStatus(lat, lng, ctx);
  const response = jsonResponse(payload, 200, { "Cache-Control": "public, max-age=90" });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleParcelLookup(url) {
  // Sanity-check / secondary lookup against Spokane County's own address points,
  // useful when the Census geocoder can't match a newly platted or rebuilt address.
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return jsonResponse({ error: "Missing 'q' address parameter" }, 400);
  const escaped = q.replace(/'/g, "''").toUpperCase();
  const geojson = await queryArcGIS(SPOKANE_ADDRESS_POINTS, {
    where: `FULLADDR LIKE '%${escaped}%'`,
    outFields: "FULLADDR",
    returnGeometry: "true",
    resultRecordCount: "5"
  });
  return jsonResponse({
    matches: geojson.features.map((f) => ({
      address: f.properties.FULLADDR,
      lat: f.geometry?.coordinates?.[1],
      lng: f.geometry?.coordinates?.[0]
    }))
  });
}

function handleProviders() {
  return jsonResponse({ providers: PROVIDERS }, 200, { "Cache-Control": "public, max-age=3600" });
}

function handleShelters() {
  return jsonResponse({ shelters: SHELTERS, links: AUTHORITATIVE_LINKS }, 200, {
    "Cache-Control": "public, max-age=600"
  });
}

// When this Worker is reached via the phillabaum.us/spokanefire route (as opposed
// to its own root-level workers.dev URL), every request arrives with this prefix.
// We strip it before any internal routing/asset lookup so the app's own code never
// has to know which base path it's being served from, and inject a matching
// <base href> into HTML responses so the page's own relative asset/API requests
// (see public/index.html and public/app.js, which deliberately use relative paths
// for exactly this reason) come back around with the prefix intact.
const PATH_PREFIX = "/spokanefire";

function injectBaseHref(response, basePath) {
  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.prepend(`<base href="${basePath}">`, { html: true });
      }
    })
    .transform(response);
}

export default {
  async fetch(request, env, ctx) {
    let basePath = "/";
    const url = new URL(request.url);

    if (url.pathname === PATH_PREFIX || url.pathname.startsWith(`${PATH_PREFIX}/`)) {
      basePath = `${PATH_PREFIX}/`;
      const inner = url.pathname.slice(PATH_PREFIX.length);
      url.pathname = inner === "" ? "/" : inner;
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "*"
        }
      });
    }

    try {
      if (url.pathname === "/api/suggest") return await handleSuggest(url, ctx);
      if (url.pathname === "/api/geocode") return await handleGeocode(url, ctx);
      if (url.pathname === "/api/status") return await handleStatus(url, ctx);
      if (url.pathname === "/api/parcel-lookup") return await handleParcelLookup(url);
      if (url.pathname === "/api/providers") return handleProviders();
      if (url.pathname === "/api/shelters") return handleShelters();
      if (url.pathname === "/api/subscribe" && request.method === "POST") return await handleSubscribe(request, env);
      if (url.pathname === "/api/confirm") return await handleConfirm(url, env, ctx);
      if (url.pathname === "/api/unsubscribe") return await handleUnsubscribe(url, env);
    } catch (err) {
      return jsonResponse({ error: "Internal error", detail: String(err) }, 500);
    }

    if (env.ASSETS) {
      const assetRequest = basePath === "/" ? request : new Request(url.toString(), request);
      const assetResponse = await env.ASSETS.fetch(assetRequest);
      const contentType = assetResponse.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        return injectBaseHref(assetResponse, basePath);
      }
      return assetResponse;
    }
    return new Response("Not found", { status: 404 });
  },

  // Cron trigger (see wrangler.toml [triggers]) — re-checks every confirmed
  // subscription and emails whoever's status changed since last check.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotificationCheck(env, ctx));
  }
};
