import { PROVIDERS, SHELTERS, AUTHORITATIVE_LINKS } from "./data.js";

const CENSUS_GEOCODE_URL = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Spokane County's own address point layer, used as a secondary geocode check /
// sanity check for addresses the Census geocoder can't match (new subdivisions,
// rebuilds on a cleared lot, etc).
const SPOKANE_ADDRESS_POINTS =
  "https://services3.arcgis.com/9UdSzuxhN4jGcI9p/arcgis/rest/services/Site_Address_Points/FeatureServer/0/query";

const NIFC_PERIMETERS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query";

const SPOKANE_EVAC =
  "https://services3.arcgis.com/9UdSzuxhN4jGcI9p/arcgis/rest/services/Evacuation_Areas_Spokane_County_Public_View/FeatureServer/0/query";

const STEVENS_EVAC =
  "https://services.arcgis.com/6E99CuinVlFZ3R03/arcgis/rest/services/Evacuation_ViewLayer/FeatureServer/0/query";

const USER_AGENT =
  "HouseFireStatus/1.0 (humanitarian wildfire utility-status tool for Spokane WA; contact adam@phillabaum.us)";

const EVAC_RANK = {
  "level 3": 4,
  "go": 4,
  "level 2": 3,
  "be set": 3,
  "level 1": 2,
  "get ready": 2,
  "hazmat": 3.5,
  "shelter in place": 3.5,
  "all clear": 1,
  "pre plan": 0
};

// Spokane County's evacuation FeatureServer returns coded domain values (e.g. "03")
// rather than text, so we decode them ourselves using the layer's published domains
// (services3.arcgis.com/.../Evacuation_Areas_Spokane_County_Public_View/FeatureServer/0).
const SPOKANE_EVAC_LEVEL_MAP = {
  "01": "Level 1 - Get Ready!",
  "02": "Level 2 - Be Set!",
  "03": "Level 3 - Go! Leave Immediately!",
  "04": "Shelter In Place (Hazmat)",
  "05": "Hazmat Evacuation (Hazmat)",
  "100": "All Clear",
  "800": "Pre Plan - Not Active"
};
const SPOKANE_EVAC_STATUS_MAP = {
  "01": "New",
  "02": "Upgraded",
  "03": "Downgraded",
  "04": "Remain",
  "100": "All Clear",
  "800": "Pre Plan - Not Active"
};
const SPOKANE_INCIDENT_TYPE_MAP = {
  "01": "Wildland Fire",
  "02": "Hazmat Incident",
  "800": "Pre Plan - Not Active"
};
const INACTIVE_EVAC_LEVELS = new Set(["Pre Plan - Not Active"]);

function decodeSpokaneEvacFeatures(geojson) {
  const features = geojson.features
    .map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        EvacLevel: SPOKANE_EVAC_LEVEL_MAP[f.properties.EvacLevel] || f.properties.EvacLevel,
        EvacStatus: SPOKANE_EVAC_STATUS_MAP[f.properties.EvacStatus] || f.properties.EvacStatus,
        IncidentType: SPOKANE_INCIDENT_TYPE_MAP[f.properties.IncidentType] || f.properties.IncidentType
      }
    }))
    .filter((f) => !INACTIVE_EVAC_LEVELS.has(f.properties.EvacLevel));
  return { type: "FeatureCollection", features };
}

function rankEvacLevel(label) {
  if (!label) return 0;
  const l = label.toLowerCase();
  let best = 0;
  for (const [key, rank] of Object.entries(EVAC_RANK)) {
    if (l.includes(key) && rank > best) best = rank;
  }
  return best;
}

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

// Queries an ArcGIS FeatureServer layer and returns a standard GeoJSON FeatureCollection
// (features[].properties + features[].geometry) so results can be handed straight to
// Leaflet as well as summarized as plain attributes.
async function queryArcGIS(baseUrl, params) {
  const qs = new URLSearchParams({ f: "geojson", ...params }).toString();
  try {
    const resp = await fetch(`${baseUrl}?${qs}`, { headers: { "User-Agent": USER_AGENT } });
    if (!resp.ok) return { type: "FeatureCollection", features: [] };
    const data = await resp.json();
    if (data.error || !Array.isArray(data.features)) return { type: "FeatureCollection", features: [] };
    return data;
  } catch (err) {
    return { type: "FeatureCollection", features: [] };
  }
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
  )}&format=json&addressdetails=1&countrycodes=us&limit=1`;
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

function pickWorst(zones) {
  let worst = null;
  let worstRank = -1;
  for (const z of zones) {
    const label = z.EvacLevel || z.Evac_Label || z.Evac_Type || "";
    const rank = rankEvacLevel(label);
    if (rank > worstRank) {
      worstRank = rank;
      worst = z;
    }
  }
  return worst;
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

  const pointParams = {
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects"
  };

  const [spokaneEvacGeoJson, stevensEvacGeoJson, perimeterHitGeoJson, nearbyFireGeoJson] = await Promise.all([
    queryArcGIS(SPOKANE_EVAC, {
      ...pointParams,
      outFields: "IncidentType,IncidentName,FireDistrict,EvacStatus,EvacLevel,BoundaryDesc,PrimaryVoiceMsg,PublicAppMsg"
    }),
    queryArcGIS(STEVENS_EVAC, { ...pointParams, outFields: "*" }),
    queryArcGIS(NIFC_PERIMETERS, {
      ...pointParams,
      outFields: "poly_IncidentName,attr_PercentContained,poly_GISAcres,attr_FireDiscoveryDateTime"
    }),
    queryArcGIS(NIFC_PERIMETERS, {
      geometry: `${lng},${lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      distance: "15",
      units: "esriSRUnit_StatuteMile",
      outFields: "poly_IncidentName,attr_PercentContained,poly_GISAcres,attr_FireDiscoveryDateTime",
      resultRecordCount: "10"
    })
  ]);

  const evacFeatures = [...decodeSpokaneEvacFeatures(spokaneEvacGeoJson).features, ...stevensEvacGeoJson.features];
  const evacZones = evacFeatures.map((f) => f.properties);
  const worstZone = pickWorst(evacZones);
  const perimeterAttrs = perimeterHitGeoJson.features.map((f) => f.properties);
  const insidePerimeterNames = new Set(perimeterAttrs.map((a) => a.poly_IncidentName));
  const nearbyFires = nearbyFireGeoJson.features
    .map((f) => f.properties)
    .filter((a) => !insidePerimeterNames.has(a.poly_IncidentName));

  const payload = {
    queried: { lat, lng },
    evacuation: {
      hasActiveZone: evacZones.length > 0,
      worst: worstZone
        ? {
            incidentName: worstZone.IncidentName || worstZone.incident_name || null,
            level: worstZone.EvacLevel || worstZone.Evac_Label || null,
            status: worstZone.EvacStatus || worstZone.Evac_Type || null,
            fireDistrict: worstZone.FireDistrict || null,
            boundaryDesc: worstZone.BoundaryDesc || null,
            voiceMessage: worstZone.PrimaryVoiceMsg || null,
            appMessage: worstZone.PublicAppMsg || null
          }
        : null,
      zones: evacZones,
      zonesGeoJson: { type: "FeatureCollection", features: evacFeatures }
    },
    firePerimeter: {
      insideActivePerimeter: perimeterAttrs.length > 0,
      perimeters: perimeterAttrs.map((a) => ({
        incidentName: a.poly_IncidentName,
        percentContained: a.attr_PercentContained,
        acres: a.poly_GISAcres,
        discoveredAt: a.attr_FireDiscoveryDateTime
      })),
      perimetersGeoJson: perimeterHitGeoJson
    },
    nearbyFires: nearbyFires.map((a) => ({
      incidentName: a.poly_IncidentName,
      percentContained: a.attr_PercentContained,
      acres: a.poly_GISAcres,
      discoveredAt: a.attr_FireDiscoveryDateTime
    })),
    nearbyFiresGeoJson: {
      type: "FeatureCollection",
      features: nearbyFireGeoJson.features.filter((f) => !insidePerimeterNames.has(f.properties.poly_IncidentName))
    },
    generatedAt: new Date().toISOString()
  };

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,OPTIONS",
          "access-control-allow-headers": "*"
        }
      });
    }

    try {
      if (url.pathname === "/api/geocode") return await handleGeocode(url, ctx);
      if (url.pathname === "/api/status") return await handleStatus(url, ctx);
      if (url.pathname === "/api/parcel-lookup") return await handleParcelLookup(url);
      if (url.pathname === "/api/providers") return handleProviders();
      if (url.pathname === "/api/shelters") return handleShelters();
    } catch (err) {
      return jsonResponse({ error: "Internal error", detail: String(err) }, 500);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }
};
