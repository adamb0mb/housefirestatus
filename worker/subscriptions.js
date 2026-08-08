import { sendEmail } from "./email.js";
import { computeStatus } from "./status.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicBaseUrl(env) {
  return (env.PUBLIC_BASE_URL || "https://housefirestatus.adam-c90.workers.dev").replace(/\/$/, "");
}

function randomToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function htmlPage(title, bodyHtml, env) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:520px;margin:3rem auto;padding:0 1.25rem;line-height:1.5;color:#1a1a1a}
.card{background:#f4f2ee;border:1px solid #ddd6c8;border-radius:10px;padding:1.5rem}
a.btn{display:inline-block;margin-top:1rem;background:#b3341c;color:#fff;text-decoration:none;padding:0.6rem 1.1rem;border-radius:6px;font-weight:600}</style>
</head><body><div class="card">${bodyHtml}<p><a class="btn" href="${publicBaseUrl(env)}/">Back to House Fire Status</a></p></div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function statusPageLink(env, sub) {
  const params = new URLSearchParams({ lat: sub.lat, lng: sub.lng, address: sub.address });
  return `${publicBaseUrl(env)}/?${params.toString()}`;
}

export async function handleSubscribe(request, env) {
  if (!env.DB) return jsonError("Subscriptions are not configured on this deployment yet.", 503);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError("Invalid request body", 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const address = String(body.address || "").trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);

  if (!EMAIL_RE.test(email)) return jsonError("Please enter a valid email address.", 400);
  if (!address) return jsonError("Missing address.", 400);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return jsonError("Missing/invalid location.", 400);

  const latKey = Math.round(lat * 10000) / 10000;
  const lngKey = Math.round(lng * 10000) / 10000;

  const existing = await env.DB.prepare(
    `SELECT id, confirmed, confirm_token FROM subscriptions
     WHERE email = ? AND ABS(lat - ?) < 0.0001 AND ABS(lng - ?) < 0.0001
     LIMIT 1`
  )
    .bind(email, latKey, lngKey)
    .first();

  if (existing) {
    if (existing.confirmed) {
      return jsonResponse({ ok: true, alreadySubscribed: true });
    }
    await sendConfirmEmail(env, { email, address, confirmToken: existing.confirm_token });
    return jsonResponse({ ok: true, resent: true });
  }

  const id = crypto.randomUUID();
  const confirmToken = randomToken();
  const unsubscribeToken = randomToken();

  await env.DB.prepare(
    `INSERT INTO subscriptions (id, email, address, lat, lng, confirmed, confirm_token, unsubscribe_token, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
  )
    .bind(id, email, address, latKey, lngKey, confirmToken, unsubscribeToken, new Date().toISOString())
    .run();

  await sendConfirmEmail(env, { email, address, confirmToken });
  return jsonResponse({ ok: true });
}

async function sendConfirmEmail(env, { email, address, confirmToken }) {
  const confirmUrl = `${publicBaseUrl(env)}/api/confirm?token=${confirmToken}`;
  await sendEmail(env, {
    to: email,
    subject: `Confirm alerts for ${address}`,
    html: `
      <p>You (or someone using this email address) asked to get notified when the
      evacuation, fire, power, internet, or water status changes for:</p>
      <p><strong>${escapeHtml(address)}</strong></p>
      <p><a href="${confirmUrl}">Click here to confirm and start receiving alerts</a></p>
      <p>If you didn't request this, you can just ignore this email — nothing will be sent until this link is clicked.</p>
    `
  });
}

export async function handleConfirm(url, env, ctx) {
  if (!env.DB) return htmlPage("Not available", "<p>Subscriptions aren't configured on this deployment.</p>", env);

  const token = url.searchParams.get("token") || "";
  const sub = await env.DB.prepare(`SELECT * FROM subscriptions WHERE confirm_token = ? AND confirmed = 0`)
    .bind(token)
    .first();

  if (!sub) {
    return htmlPage(
      "Link not found",
      "<h1>This confirmation link isn't valid</h1><p>It may have already been used, or the link was mistyped. If you still want alerts, subscribe again from the address page.</p>",
      env
    );
  }

  // Establish today's status as the baseline — subscribers get notified about
  // what changes *after* confirming, not about whatever is already happening.
  let baseline = null;
  try {
    const status = await computeStatus(sub.lat, sub.lng, ctx);
    baseline = buildComparableSummary(status);
  } catch (err) {
    baseline = null;
  }

  await env.DB.prepare(
    `UPDATE subscriptions SET confirmed = 1, confirmed_at = ?, confirm_token = NULL, last_status_json = ? WHERE id = ?`
  )
    .bind(new Date().toISOString(), baseline ? JSON.stringify(baseline) : null, sub.id)
    .run();

  return htmlPage(
    "Subscribed",
    `<h1>You're subscribed ✓</h1><p>We'll email <strong>${escapeHtml(sub.email)}</strong> when evacuation, fire, power, internet, or water status changes for:</p><p><strong>${escapeHtml(sub.address)}</strong></p><p>Every alert email includes a one-click unsubscribe link.</p>`,
    env
  );
}

export async function handleUnsubscribe(url, env) {
  if (!env.DB) return htmlPage("Not available", "<p>Subscriptions aren't configured on this deployment.</p>", env);

  const token = url.searchParams.get("token") || "";
  const sub = await env.DB.prepare(`SELECT id, address FROM subscriptions WHERE unsubscribe_token = ?`).bind(token).first();

  if (!sub) {
    return htmlPage("Link not found", "<h1>This unsubscribe link isn't valid</h1><p>It may have already been used.</p>", env);
  }

  await env.DB.prepare(`DELETE FROM subscriptions WHERE id = ?`).bind(sub.id).run();

  return htmlPage(
    "Unsubscribed",
    `<h1>You're unsubscribed</h1><p>You won't get any more alerts for <strong>${escapeHtml(sub.address)}</strong>.</p>`,
    env
  );
}

// Reduces a full /api/status payload down to just the fields worth notifying
// about, and to stable values (no timestamps that change every run) so two
// calls with identical real-world conditions compare as equal.
function buildComparableSummary(status) {
  const nearestPower = status.power?.outages?.[0] ?? null;
  const nearestInternet = status.internet?.tds?.outages?.[0] ?? null;
  return {
    evacLevel: status.evacuation?.worst?.level ?? null,
    evacStatus: status.evacuation?.worst?.status ?? null,
    insideFirePerimeter: Boolean(status.firePerimeter?.insideActivePerimeter),
    powerOutageNearby: nearestPower ? nearestPower.distanceMiles <= 1 : false,
    internetOutageNearby: nearestInternet ? nearestInternet.distanceMiles <= 1 : false,
    waterAdvisoryCount: status.water?.advisories?.length ?? 0
  };
}

function describeChanges(prev, next) {
  const changes = [];
  if (prev.evacLevel !== next.evacLevel || prev.evacStatus !== next.evacStatus) {
    if (next.evacLevel) {
      changes.push(`Evacuation status: ${next.evacLevel}${next.evacStatus ? ` (${next.evacStatus})` : ""}`);
    } else if (prev.evacLevel) {
      changes.push("The evacuation zone that covered this address is no longer active.");
    }
  }
  if (prev.insideFirePerimeter !== next.insideFirePerimeter) {
    changes.push(
      next.insideFirePerimeter
        ? "This address now falls within a mapped active fire perimeter."
        : "This address is no longer within a mapped active fire perimeter."
    );
  }
  if (prev.powerOutageNearby !== next.powerOutageNearby) {
    changes.push(
      next.powerOutageNearby ? "A power outage is now reported near this address (Avista)." : "The nearby power outage appears resolved (Avista)."
    );
  }
  if (prev.internetOutageNearby !== next.internetOutageNearby) {
    changes.push(
      next.internetOutageNearby
        ? "An internet outage is now reported near this address (TDS)."
        : "The nearby internet outage appears resolved (TDS)."
    );
  }
  if (prev.waterAdvisoryCount !== next.waterAdvisoryCount) {
    changes.push(
      next.waterAdvisoryCount > prev.waterAdvisoryCount
        ? "There's a new active water system advisory in the county."
        : "A county water system advisory was lifted."
    );
  }
  return changes;
}

// Cron entry point — checks every confirmed subscription and emails whoever's
// status changed since their last check. Dedupes by location so N subscribers
// at the same address only trigger one round of upstream API calls.
export async function runNotificationCheck(env, ctx) {
  if (!env.DB) return;

  const { results } = await env.DB.prepare(`SELECT * FROM subscriptions WHERE confirmed = 1`).all();
  if (!results || results.length === 0) return;

  const byLocation = new Map();
  for (const sub of results) {
    const key = `${sub.lat},${sub.lng}`;
    if (!byLocation.has(key)) byLocation.set(key, []);
    byLocation.get(key).push(sub);
  }

  for (const [key, subs] of byLocation) {
    const [lat, lng] = key.split(",").map(Number);
    let summary;
    try {
      const status = await computeStatus(lat, lng, ctx);
      summary = buildComparableSummary(status);
    } catch (err) {
      continue; // upstream hiccup this run — try again next cron tick
    }

    for (const sub of subs) {
      const prev = sub.last_status_json ? JSON.parse(sub.last_status_json) : null;
      const changes = prev ? describeChanges(prev, summary) : [];

      if (changes.length > 0) {
        const unsubscribeUrl = `${publicBaseUrl(env)}/api/unsubscribe?token=${sub.unsubscribe_token}`;
        await sendEmail(env, {
          to: sub.email,
          subject: `Status changed for ${sub.address}`,
          html: `
            <p>Here's what changed for <strong>${escapeHtml(sub.address)}</strong>:</p>
            <ul>${changes.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
            <p><a href="${statusPageLink(env, sub)}">View full details</a></p>
            <p style="color:#777;font-size:0.85rem;margin-top:2rem;"><a href="${unsubscribeUrl}">Unsubscribe from alerts for this address</a></p>
          `
        });
        await env.DB.prepare(`UPDATE subscriptions SET last_notified_at = ? WHERE id = ?`)
          .bind(new Date().toISOString(), sub.id)
          .run();
      }

      await env.DB.prepare(`UPDATE subscriptions SET last_status_json = ? WHERE id = ?`)
        .bind(JSON.stringify(summary), sub.id)
        .run();
    }
  }
}

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function jsonError(message, status) {
  return jsonResponse({ error: message }, status);
}
