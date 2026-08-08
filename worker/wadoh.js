// Washington State Department of Health publishes currently-active Group A
// drinking-water system alerts (boil water / do-not-drink notices) at a public,
// no-key URL, filterable by county via a plain query string. It's server-rendered
// HTML (Drupal Views), not a JSON API, so we parse the results table with
// Cloudflare's native HTMLRewriter instead of scraping with regex.
//
// This is system-name-level data, not address-matched — Spokane County has dozens
// of small water purveyors and DOH doesn't publish per-system service-area
// boundaries alongside these alerts, so we surface the list as regional context
// (like nearby fires) rather than claiming to know which system serves a given
// address.
const WADOH_ALERTS_URL = "https://doh.wa.gov/community-and-environment/drinking-water/active-alerts";

const COUNTIES = [
  { code: "1006", label: "Spokane" },
  { code: "1063", label: "Stevens" }
];

const FIELD_ORDER = ["county", "systemName", "dateIssued", "actionType", "_unused", "phone", "comments"];

async function fetchCountyAlerts(county, userAgent) {
  let resp;
  try {
    resp = await fetch(`${WADOH_ALERTS_URL}?county=${county.code}`, { headers: { "User-Agent": userAgent } });
  } catch (err) {
    return null; // network/service failure — distinct from "no alerts"
  }
  if (!resp.ok) return null;

  const alerts = [];
  let current = null;
  let cellIndex = -1;
  let cellBuffer = "";

  const rewriter = new HTMLRewriter()
    .on("table.footable tbody tr", {
      element(el) {
        current = {};
        cellIndex = -1;
        el.onEndTag(() => {
          if (current && current.systemName) alerts.push(current);
          current = null;
        });
      }
    })
    .on("table.footable tbody tr td", {
      element(el) {
        cellIndex += 1;
        cellBuffer = "";
        const fieldIndex = cellIndex;
        el.onEndTag(() => {
          const key = FIELD_ORDER[fieldIndex];
          if (current && key && key !== "_unused") {
            current[key] = cellBuffer.trim();
          }
        });
      },
      text(chunk) {
        cellBuffer += chunk.text;
      }
    });

  try {
    await rewriter.transform(resp).text(); // drives the streaming parse to completion
  } catch (err) {
    return null;
  }

  return alerts;
}

// Wildfire-caused advisories (the ones most relevant to this app) tend to mention
// it explicitly in DOH's own comment text — surface those first, then by recency.
function rankAlert(a) {
  const mentionsFire = /wildfire|fire\b/i.test(a.comments || "");
  const date = Date.parse(a.dateIssued) || 0;
  return { mentionsFire, date };
}

export async function getWaterAdvisories(userAgent, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://cache.internal/wadoh-alerts");
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const results = await Promise.all(COUNTIES.map((c) => fetchCountyAlerts(c, userAgent)));
  const available = results.every((r) => r !== null);
  const advisories = results
    .flatMap((r) => r || [])
    .sort((a, b) => {
      const ra = rankAlert(a);
      const rb = rankAlert(b);
      if (ra.mentionsFire !== rb.mentionsFire) return ra.mentionsFire ? -1 : 1;
      return rb.date - ra.date;
    });

  const payload = { available, advisories };

  const response = new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json", "Cache-Control": "public, max-age=1200" }
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return payload;
}
