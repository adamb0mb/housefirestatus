# House Fire Status

A small web app to help people displaced by the 2026 Spokane Complex wildfires
(Old Trails, Autumn Lane, and Fairview fires) check the status of a property:
is it in an active evacuation zone or fire perimeter, and how do you check the
status of its power, gas, internet, cable, phone, and water utilities.

Enter an address, and the app:

1. Geocodes it — as you type, via autocomplete — (US Census Bureau geocoder, OpenStreetMap Nominatim fallback).
2. Checks it against **live, official** evacuation-zone and fire-perimeter data.
3. Checks it against **live** Avista power outage data and **live** TDS internet outage
   data — no click-through needed for either.
4. Shows a map with the address pin, evacuation zone polygon, and fire perimeter.
5. Lists the rest of the utilities that serve the Spokane area (gas, cable, phone,
   cellular, water) with direct links/phone numbers to check live status, since none of
   those publish a public feed the way Avista's and TDS's outage maps effectively do.

Picking an address (or just pressing Enter) runs every one of these automatically —
there's nothing else to click to get a full status check.

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
worker/kubra.js      Avista live power-outage client (KUBRA Storm Center tile API)
worker/data.js       static provider directory + shelter list
wrangler.toml        Worker + Assets config
```

### API

- `GET /api/suggest?q=<partial address>` → address autocomplete candidates `{ label, lat, lng }[]` (Nominatim, deduped/ranked, biased to the Spokane region)
- `GET /api/geocode?q=<address>` → `{ lat, lng, matchedAddress, county, state, source }` (fallback for the plain-text submit path)
- `GET /api/status?lat=&lng=` → evacuation zones, fire perimeters (containing + within 15mi), **live Avista power outages within ~2mi**, **live TDS internet outages within 5mi**, each with GeoJSON for map rendering
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
| **Power (electric)** | Avista's own public outage map data, via KUBRA Storm Center's tile API (`worker/kubra.js`) | **Checked live, automatically, per address.** Avista doesn't publish an official API, but their public outage map (outagemap.myavista.com) is a KUBRA Storm Center deployment, which serves its outage data as static, unauthenticated JSON tiles — the same files the map itself fetches to draw markers. We read the `instanceId`/`viewId` KUBRA assigns Avista out of the map's own bootstrap config, then query the map tile(s) covering the address for nearby outages (distance, customers affected, cause, crew status, ETR). This is the same technique community outage-data projects use (e.g. `openkentuckiana/power-outage-data`, `fgregg/kubra`) — no login or key involved, just the map's own public data feed. Falls back to link-out mode if the feed format ever changes. |
| **Internet (TDS)** | TDS Telecom's own "OUTAGE_FOOTPRINT" ArcGIS layer | **Checked live, automatically, per address.** TDS's outage checker (tdstelecom.com/support/outage.html) is an Esri ArcGIS JS app; its compiled bundle references a hosted feature layer at `utility.arcgis.com/usrsvcs/servers/.../OUTAGE_FOOTPRINT/MapServer/0` directly — queryable with no token, same as the county evacuation-zone layers. It's Esri's packaged ["ArcGIS Solutions for Utilities" public-outage template](https://solutions.arcgis.com/utilities/electric/help/public-outage/get-started), deployed as-is, with fields for customers affected, products impacted, and report/update timestamps. Confirmed against a real, current outage in Spokane during development (200 customers, updated same-day). |
| Natural gas | Avista Utilities | No equivalent public feed exists for gas — utilities don't generally map individual gas outages/leaks the way they map electric outages. Links to Avista's outage line and the gas emergency number instead. |
| Cable / other internet / phone / cellular | Curated directory (`worker/data.js`): Comcast Xfinity, Charter Spectrum, Quantum Fiber (Lumen/CenturyLink), Ziply Fiber, Verizon, AT&T, T-Mobile | **Individually checked for a live/GIS source and came up empty** — see the provider research table below for what was actually found (or blocked) for each. Each entry links straight to that provider's own status-check tool instead. See also the [FCC National Broadband Map](https://broadbandmap.fcc.gov/home) for a general coverage lookup at any address. |
| Water | City of Spokane / county water purveyors | Informational only — Spokane County has dozens of small water districts with no unified status source. |
| Shelters | Curated from Spokane County / InciWeb reporting, with links to verify live | Manually maintained in `worker/data.js`; confirm current status via the linked sources before travel. |
| Map basemap | OpenStreetMap raster tiles | Leaflet is vendored locally (`public/vendor/leaflet`) so the site has no CDN dependency; map tiles are still fetched from OSM at runtime. |

All ArcGIS endpoints were verified against live data during development (they
returned real, current Old Trails / Autumn Lane / Fairview evacuation zones,
and real current Avista and TDS outages), and required no API key or token.

### Provider research: what we checked and why the rest aren't live

Beyond Avista and TDS, every other provider in the directory was individually
checked for a public outage API or downloadable GIS file before concluding it
wasn't available — this isn't a guess:

| Provider | What we found |
|---|---|
| Comcast Xfinity | Own in-house API (`api.sc.xfinity.com`, `api-support.xfinity.com`) — returns `403 Forbidden` without an authenticated account session. No ArcGIS/Kubra-style vendor signature in the page source. |
| Charter Spectrum | Outage map explicitly requires signing in to a Spectrum account; own CDN (`spectrumflow.net`), not a recognizable white-label vendor. |
| Quantum Fiber (Lumen/CenturyLink) | Does have a no-login, address-based outage tool (`quantumfiber.com/outagetool`), but its backend endpoint is behind PerimeterX bot-protection (CAPTCHA challenge) — not something worth scripting around. |
| Ziply Fiber | No official outage map or checker found at all; only low-quality third-party "crowd report" sites, which we didn't integrate since they're not authoritative. |
| Verizon, AT&T | Outage pages are informational/marketing only — no interactive address-level map or discoverable API in the page source. |
| T-Mobile | Has a coverage map (built on Mapbox), but that's static signal coverage, not live outage status — not the same thing, and cellular carriers generally don't expose real-time outage data publicly (they report to the FCC's DIRS system, which isn't public). |

If any of these change their outage tooling and start exposing something
similar to Avista's or TDS's, the same technique (inspect the page's bundled
JS for a `FeatureServer`/`MapServer` URL or a mapping-vendor bootstrap config)
should surface it.

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

- Power (Avista) and internet (TDS) are the only utilities checked live and
  automatically end-to-end. Gas and every other ISP/cable/phone/cellular
  provider are **not live** — no free public feed exists for any of them (see
  the provider research table above), so the app links out to each
  provider's own checker instead of showing a status badge.
- The Avista power-outage integration relies on an undocumented (though
  widely reverse-engineered) data format from a third party (KUBRA). If
  Avista or KUBRA change it, `/api/status` degrades gracefully to
  `power.available: false` and the UI falls back to the manual-check links —
  it won't break the rest of the page.
- The TDS integration queries an Esri-hosted layer directly; if TDS
  reconfigures or retires it, those queries just return no results (same as
  any other ArcGIS layer in this app going quiet) rather than erroring.
- Evacuation zone and fire perimeter data is only as fresh as the upstream
  county/NIFC services (evac zones update as incident command reports change;
  perimeters refresh roughly every 5 minutes).
- Shelter list is manually curated and will go stale — always verify with the
  linked official sources.
