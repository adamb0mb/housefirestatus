# House Fire Status

A small web app to help people displaced by the 2026 Spokane Complex wildfires
(Old Trails, Autumn Lane, and Fairview fires) check the status of a property:
is it in an active evacuation zone or fire perimeter, and how do you check the
status of its power, gas, internet, cable, phone, and water utilities.

Enter an address, and the app:

1. Geocodes it — as you type, via autocomplete — (US Census Bureau geocoder, OpenStreetMap Nominatim fallback).
2. Checks it against **live, official** evacuation-zone and fire-perimeter data.
3. Checks it against **live** Avista power outage data, **live** TDS internet outage
   data, and **live** Washington DOH water-system advisory data — no click-through
   needed for any of them.
4. Shows a map with the address pin, evacuation zone polygon, and fire perimeter.
5. Lists the rest of the utilities that serve the Spokane area (gas, cable, phone,
   cellular) with direct links — pointed at each provider's *current, disaster-specific*
   status page where one exists for this event, not just their generic outage checker —
   since none of them publish a public feed the way Avista's, TDS's, and WA DOH's do.

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
worker/wadoh.js      WA Dept. of Health live water-advisory client (HTMLRewriter-parsed)
worker/data.js       static provider directory + shelter list
wrangler.toml        Worker + Assets config
```

### API

- `GET /api/suggest?q=<partial address>` → address autocomplete candidates `{ label, lat, lng }[]` (Nominatim, deduped/ranked, biased to the Spokane region)
- `GET /api/geocode?q=<address>` → `{ lat, lng, matchedAddress, county, state, source }` (fallback for the plain-text submit path)
- `GET /api/status?lat=&lng=` → evacuation zones, fire perimeters (containing + within 15mi), **live Avista power outages within ~2mi**, **live TDS internet outages within 5mi**, **live WA DOH water advisories for Spokane/Stevens County**, each with GeoJSON for map rendering
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
| **Water** | [Washington State Dept. of Health active drinking-water alerts](https://doh.wa.gov/community-and-environment/drinking-water/active-alerts) (`worker/wadoh.js`) | **Checked live, automatically, county-wide.** DOH publishes every Group A water system's current boil-water/do-not-drink advisories on a public, no-key page, filterable by county via a plain query string (`?county=1006` for Spokane). It's server-rendered HTML (Drupal Views), not a JSON API, so we parse the results table with Cloudflare's native `HTMLRewriter` instead of a fragile regex scrape. This is system-name-level, not address-matched (DOH doesn't publish per-system service-area boundaries), so results are shown as regional context — confirmed against real, current, explicitly wildfire-caused advisories in Spokane County during development (multiple systems, dated same-week). |
| Natural gas | Avista Utilities | No equivalent public feed exists for gas — utilities don't generally map individual gas outages/leaks the way they map electric outages. Links to Avista's outage line and the gas emergency number instead. |
| Cable / other internet / phone / cellular | Curated directory (`worker/data.js`): Comcast Xfinity, Charter Spectrum, Quantum Fiber (Lumen/CenturyLink), Ziply Fiber, Verizon, AT&T, T-Mobile | **Individually checked for a live/GIS source and came up empty** — see the provider research table below for what was actually found (or blocked) for each. Where a provider has published disaster-specific updates for *this* event, the entry links straight there instead of their generic status page (see below). |
| Shelters | Curated from Spokane County / InciWeb reporting, with links to verify live | Manually maintained in `worker/data.js`; confirm current status via the linked sources before travel. |
| Map basemap | OpenStreetMap raster tiles | Leaflet is vendored locally (`public/vendor/leaflet`) so the site has no CDN dependency; map tiles are still fetched from OSM at runtime. |

All ArcGIS endpoints were verified against live data during development (they
returned real, current Old Trails / Autumn Lane / Fairview evacuation zones,
real current Avista and TDS outages, and real current WA DOH water advisories),
and required no API key or token.

### Provider research: what we checked and why the rest aren't live

Beyond Avista, TDS, and WA DOH, every other provider in the directory was
individually checked for a public outage API or downloadable GIS file before
concluding it wasn't available — this isn't a guess:

| Provider | What we found |
|---|---|
| Comcast Xfinity | Their outage-check flow *is* built for anonymous (no-login) use — the page embeds a config pointing at `api.sc.xfinity.com`, and its `/outagedata/session` endpoint hands back an anonymous JWT scoped specifically to the outage service. We stopped short of actually acquiring and using that token to call the outage-by-address endpoint: an automated safety check in our own tooling flagged that step, and we didn't try to route around it. So: a real anonymous flow appears to exist, but we didn't complete it. Comcast *did* open 11,000+ public Xfinity WiFi hotspots (usable by anyone, not just subscribers) across Spokane County for this event — the directory links to the public hotspot finder for that. |
| Charter Spectrum | Outage map explicitly requires signing in to a Spectrum account; own CDN (`spectrumflow.net`), no config with an API base URL exposed in the initial page load like Xfinity's. |
| Quantum Fiber (Lumen/CenturyLink) | Does have a no-login, address-based outage tool (`quantumfiber.com/outagetool`), but its backend endpoint is behind PerimeterX bot-protection (CAPTCHA challenge) even with a warmed session/cookies — not something worth trying to defeat. |
| Ziply Fiber | No official outage map or address checker found. They do run a statuspage.io instance (`ziplyfiber.statuspage.io`, a legitimate public API), but it only covers corporate systems (website, account portal, mobile app) — not network/service outages — and hadn't been updated since 2021. Not useful for this. |
| Verizon, AT&T, T-Mobile | No interactive address-level outage map or discoverable API for consumer wireless service (cellular carriers report to the FCC's DIRS system during declared disasters, which isn't public). All three *did* publish actively-updated, dated response pages specifically for this wildfire event — AT&T and T-Mobile even give per-site status counts (e.g. "4 sites impacted, 1 restored"). The directory links to those instead of each carrier's generic outage/coverage page. |

If any of these change their outage tooling and start exposing something
similar to Avista's, TDS's, or WA DOH's, the same technique (inspect the
page's bundled JS or embedded config for a `FeatureServer`/`MapServer` URL, a
mapping-vendor bootstrap config, or an anonymous-session API base) should
surface it.

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

- Power (Avista), internet (TDS), and water (WA DOH) are the only utilities
  checked live and automatically end-to-end. Gas and every ISP/cable/phone/
  cellular provider are **not live** — no free public feed exists for any of
  them (see the provider research table above), so the app links out to
  each provider's own checker (or, where available, their disaster-specific
  update page for this event) instead of showing a status badge.
- The Avista power-outage integration relies on an undocumented (though
  widely reverse-engineered) data format from a third party (KUBRA). If
  Avista or KUBRA change it, `/api/status` degrades gracefully to
  `power.available: false` and the UI falls back to the manual-check links —
  it won't break the rest of the page.
- The TDS integration queries an Esri-hosted layer directly; if TDS
  reconfigures or retires it, those queries just return no results (same as
  any other ArcGIS layer in this app going quiet) rather than erroring.
- The WA DOH water advisory check is county-wide, not address-matched — DOH
  doesn't publish which water system serves which address, so it's shown as
  "here's what's active nearby," not a claim about the specific address.
  It's also an HTML page scrape (via HTMLRewriter, not regex), so a DOH
  redesign could break it silently — it degrades to `available: false`.
- Evacuation zone and fire perimeter data is only as fresh as the upstream
  county/NIFC services (evac zones update as incident command reports change;
  perimeters refresh roughly every 5 minutes).
- Shelter list is manually curated and will go stale — always verify with the
  linked official sources.
