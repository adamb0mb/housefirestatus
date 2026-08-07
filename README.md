# House Fire Status

A small web app to help people displaced by the 2026 Spokane Complex wildfires
(Old Trails, Autumn Lane, and Fairview fires) check the status of a property:
is it in an active evacuation zone or fire perimeter, and how do you check the
status of its power, gas, internet, cable, phone, and water utilities.

Enter an address, and the app:

1. Geocodes it (US Census Bureau geocoder, OpenStreetMap Nominatim fallback).
2. Checks it against **live, official** evacuation-zone and fire-perimeter data.
3. Shows a map with the address pin, evacuation zone polygon, and fire perimeter.
4. Lists the utilities that serve the Spokane area with direct links/phone numbers
   to check live status, since none of those providers expose a public status API.

Not an official emergency service. If you're in danger, call 911.

## Architecture

Single Cloudflare Worker (`worker/index.js`) that serves a static frontend
(`public/`) via the Workers Assets binding and exposes a small JSON API under
`/api/*`. No database — every request is a live pass-through/aggregation of
public GIS services, with short-TTL edge caching (Cloudflare Cache API) so
repeat lookups are fast and we're polite to upstream services.

```
public/            static frontend (vanilla HTML/CSS/JS + Leaflet, vendored — no CDN dependency)
worker/index.js     Worker: routes, geocoding, GIS aggregation, caching
worker/data.js       static provider directory + shelter list
wrangler.toml        Worker + Assets config
```

### API

- `GET /api/geocode?q=<address>` → `{ lat, lng, matchedAddress, county, state, source }`
- `GET /api/status?lat=&lng=` → evacuation zones, fire perimeters (containing + within 15mi), each with GeoJSON for map rendering
- `GET /api/providers` → static utility/ISP directory (power, gas, internet, cable, phone, cellular, water)
- `GET /api/shelters` → curated shelter list + authoritative links (InciWeb, county, Red Cross)
- `GET /api/parcel-lookup?q=<partial address>` → secondary lookup against Spokane County's own address points, for addresses the Census geocoder can't match

## Data sources

| Data | Source | Notes |
|---|---|---|
| Geocoding | [US Census Bureau Geocoder](https://geocoding.geo.census.gov/geocoder/) | Free, no key, US-only. |
| Geocoding fallback | [OpenStreetMap Nominatim](https://nominatim.org/) | Free, no key, used when Census can't match. |
| Address sanity-check | Spokane County `Site_Address_Points` ArcGIS FeatureServer | County's own address point layer. |
| **Evacuation zones** | Spokane County `Evacuation_Areas_Spokane_County_Public_View` ArcGIS FeatureServer (official, live, no key) | Coded domain values (`EvacLevel`/`EvacStatus`) decoded server-side against the layer's published domains. |
| Evacuation zones (north county) | Stevens County `Evacuation_ViewLayer` ArcGIS FeatureServer | |
| Fire perimeters | NIFC WFIGS `WFIGS_Interagency_Perimeters_Current` ArcGIS FeatureServer (nationwide, live, no key) | Updated every 5 minutes by the National Interagency Fire Center. |
| Fire/wildfire supplementary info | Washington DNR `WADNR_PUBLIC_WD_WildFire_Data` ArcGIS MapServer | Referenced for future use (current fire stats, shutdown zones). |
| Power & natural gas | Avista Utilities | **No public real-time outage API exists.** The app links directly to Avista's outage map, phone line, and "text STAT to AVISTA" SMS status check instead of guessing. |
| Internet / cable / phone / cellular | Curated directory (`worker/data.js`) of providers known to serve the Spokane area (Comcast Xfinity, Charter Spectrum, TDS, Quantum Fiber/Lumen, Ziply Fiber, Starlink, Verizon, AT&T, T-Mobile) | None of these publish a free outage API either; each entry links straight to that provider's own status-check tool. See also the [FCC National Broadband Map](https://broadbandmap.fcc.gov/home) for a general coverage lookup at any address. |
| Water | City of Spokane / county water purveyors | Informational only — Spokane County has dozens of small water districts with no unified status source. |
| Shelters | Curated from Spokane County / InciWeb reporting, with links to verify live | Manually maintained in `worker/data.js`; confirm current status via the linked sources before travel. |
| Map basemap | OpenStreetMap raster tiles | Leaflet is vendored locally (`public/vendor/leaflet`) so the site has no CDN dependency; map tiles are still fetched from OSM at runtime. |

All ArcGIS endpoints were verified against live data during development (they
returned real, current Old Trails / Autumn Lane / Fairview evacuation zones
and fire perimeters), and required no API key or token.

## Local development

```bash
npm install
npm run dev      # wrangler dev, http://localhost:8787
```

## Deploying to Cloudflare

```bash
npx wrangler login     # one-time
npm run deploy          # wrangler deploy
```

This deploys a single Worker (`housefirestatus`) that serves both the static
site and the `/api/*` routes — no separate Pages project, KV, or D1 needed.
`wrangler.toml` already defines the Assets binding and routes API paths to the
Worker first.

To put it on a custom domain, add a route or a `[[routes]]`/custom domain
binding for the zone in `wrangler.toml` or the Cloudflare dashboard after the
first deploy.

## Updating the provider/shelter directory

Edit `worker/data.js` — it's plain JS, no build step. Redeploy with `npm run deploy`.

## Known limitations

- Power/gas and ISP/cable/phone status are **not live** — there is no free
  public API for any of them, so the app links out to each provider's own
  checker instead of showing a status badge.
- Evacuation zone and fire perimeter data is only as fresh as the upstream
  county/NIFC services (evac zones update as incident command reports change;
  perimeters refresh roughly every 5 minutes).
- Shelter list is manually curated and will go stale — always verify with the
  linked official sources.
