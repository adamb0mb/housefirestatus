(() => {
  "use strict";

  const form = document.getElementById("search-form");
  const input = document.getElementById("address-input");
  const suggestions = document.getElementById("address-suggestions");
  const errorEl = document.getElementById("search-error");
  const searchBtn = document.getElementById("search-btn");
  const locateBtn = document.getElementById("locate-btn");
  const resultsSection = document.getElementById("results");
  const statusBanner = document.getElementById("status-banner");
  const evacContent = document.getElementById("evac-content");
  const fireContent = document.getElementById("fire-content");
  const utilitiesContent = document.getElementById("utilities-content");
  const sheltersContent = document.getElementById("shelters-content");

  let map, addressMarker, evacLayer, perimeterLayer, nearbyFireLayer, sheltersLayer;
  let providersCache = null;
  let sheltersCache = null;

  function initMap() {
    map = L.map("map", { scrollWheelZoom: false }).setView([47.6588, -117.426], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);
    evacLayer = L.layerGroup().addTo(map);
    perimeterLayer = L.layerGroup().addTo(map);
    nearbyFireLayer = L.layerGroup().addTo(map);
    sheltersLayer = L.layerGroup().addTo(map);
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  function setLoading(isLoading) {
    searchBtn.disabled = isLoading;
    searchBtn.textContent = isLoading ? "Checking…" : "Check status";
  }

  async function fetchJson(url) {
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
    return data;
  }

  function evacColor(levelLabel) {
    const l = (levelLabel || "").toLowerCase();
    if (l.includes("level 3") || l.includes("go")) return "#c1121f";
    if (l.includes("hazmat") || l.includes("shelter in place")) return "#7a1fa2";
    if (l.includes("level 2") || l.includes("be set")) return "#e0a900";
    if (l.includes("level 1") || l.includes("get ready")) return "#7cb342";
    if (l.includes("all clear")) return "#9e9e9e";
    return "#4a90d9";
  }

  function renderBanner(status) {
    statusBanner.className = "status-banner";
    const worst = status.evacuation.worst;
    if (worst) {
      const cls = worst.level && worst.level.toLowerCase().includes("level 3")
        ? "level-3"
        : worst.level && worst.level.toLowerCase().includes("level 2")
        ? "level-2"
        : worst.level && worst.level.toLowerCase().includes("level 1")
        ? "level-1"
        : "level-2";
      statusBanner.classList.add(cls);
      statusBanner.textContent = `${worst.incidentName ? worst.incidentName + " — " : ""}${worst.level || "Active evacuation zone"} (${worst.status || "active"})`;
    } else if (status.firePerimeter.insideActivePerimeter) {
      statusBanner.classList.add("level-fire");
      statusBanner.textContent = "This address falls within a mapped active fire perimeter.";
    } else {
      statusBanner.classList.add("level-none");
      statusBanner.textContent = "No active evacuation zone found at this address in the data we could check.";
    }
  }

  function renderEvac(status) {
    evacContent.innerHTML = "";
    const zones = status.evacuation.zones || [];
    if (zones.length === 0) {
      evacContent.innerHTML = '<p class="muted">No evacuation zone currently covers this exact point in Spokane or Stevens County GIS data. Fire behavior can change fast — recheck often.</p>';
      return;
    }
    for (const z of zones) {
      const div = document.createElement("div");
      div.className = "evac-item";
      const name = z.IncidentName || z.incident_name || "Unnamed incident";
      const level = z.EvacLevel || z.Evac_Label || z.Evac_Type || "Unknown level";
      const evStatus = z.EvacStatus || "";
      div.innerHTML = `
        <strong>${escapeHtml(name)}</strong> — ${escapeHtml(level)}
        <div class="meta">${escapeHtml(evStatus)}${z.FireDistrict ? " · Fire District " + escapeHtml(z.FireDistrict) : ""}</div>
        ${z.BoundaryDesc ? `<div class="meta">Area: ${escapeHtml(z.BoundaryDesc)}</div>` : ""}
        ${z.PublicAppMsg ? `<div class="meta">${escapeHtml(z.PublicAppMsg)}</div>` : ""}
      `;
      evacContent.appendChild(div);
    }
  }

  function renderFires(status) {
    fireContent.innerHTML = "";
    const inside = status.firePerimeter.perimeters || [];
    const nearby = status.nearbyFires || [];
    if (inside.length === 0 && nearby.length === 0) {
      fireContent.innerHTML = '<p class="muted">No mapped fire perimeters within about 15 miles of this address.</p>';
      return;
    }
    for (const f of inside) {
      fireContent.appendChild(fireItem(f, true));
    }
    for (const f of nearby) {
      fireContent.appendChild(fireItem(f, false));
    }
  }

  function fireItem(f, isInside) {
    const div = document.createElement("div");
    div.className = "fire-item";
    const acres = f.acres ? Math.round(f.acres).toLocaleString() : "unknown";
    const contained = f.percentContained != null ? `${f.percentContained}% contained` : "containment unknown";
    div.innerHTML = `
      <strong>${escapeHtml(f.incidentName || "Unnamed fire")}</strong>${isInside ? " — address is inside this perimeter" : ""}
      <div class="meta">${acres} acres · ${contained}</div>
    `;
    return div;
  }

  function providerActions(p) {
    const actions = [];
    if (p.statusCheckUrl) actions.push(`<a href="${p.statusCheckUrl}" target="_blank" rel="noopener">Check status</a>`);
    if (p.outageMapUrl) actions.push(`<a href="${p.outageMapUrl}" target="_blank" rel="noopener">Outage map</a>`);
    if (p.reportOutagePhone) actions.push(`<a href="tel:${p.reportOutagePhone.replace(/[^\d+]/g, "")}">Call ${p.reportOutagePhone}</a>`);
    if (p.emergencyPhone) actions.push(`<a href="tel:${p.emergencyPhone.replace(/[^\d+]/g, "")}">Emergency: ${p.emergencyPhone}</a>`);
    return actions.join("");
  }

  function renderUtilities(providers) {
    utilitiesContent.innerHTML = "";
    const groups = new Map();
    for (const p of providers) {
      if (!groups.has(p.categoryLabel)) groups.set(p.categoryLabel, []);
      groups.get(p.categoryLabel).push(p);
    }
    for (const [label, list] of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "provider-group";
      const cards = list
        .map(
          (p) => `
        <div class="provider-card">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="desc">${escapeHtml(p.description || "")}</div>
          <div class="actions">${providerActions(p)}</div>
          ${p.smsInfo ? `<div class="notes">${escapeHtml(p.smsInfo)}</div>` : ""}
          ${p.notes ? `<div class="notes">${escapeHtml(p.notes)}</div>` : ""}
        </div>`
        )
        .join("");
      groupEl.innerHTML = `<h3>${escapeHtml(label)}</h3>${cards}`;
      utilitiesContent.appendChild(groupEl);
    }
  }

  function renderShelters(data) {
    sheltersContent.innerHTML = "";
    for (const s of data.shelters) {
      const div = document.createElement("div");
      div.className = "shelter-item";
      div.innerHTML = `
        <strong>${escapeHtml(s.name)}</strong>
        <div class="meta">${escapeHtml(s.address)} — serving ${escapeHtml(s.servingIncident)}</div>
        <div class="meta">${escapeHtml(s.notes)}</div>
      `;
      sheltersContent.appendChild(div);
    }
    const linksList = document.createElement("ul");
    linksList.className = "link-list";
    for (const l of data.links) {
      const li = document.createElement("li");
      li.innerHTML = `<a href="${l.url}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`;
      linksList.appendChild(li);
    }
    sheltersContent.appendChild(linksList);
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function updateMap(geo, status) {
    evacLayer.clearLayers();
    perimeterLayer.clearLayers();
    nearbyFireLayer.clearLayers();

    if (addressMarker) map.removeLayer(addressMarker);
    addressMarker = L.marker([geo.lat, geo.lng]).addTo(map).bindPopup(`<strong>${escapeHtml(geo.matchedAddress)}</strong>`);

    const bounds = L.latLngBounds([[geo.lat, geo.lng]]);

    if (status.evacuation.zonesGeoJson && status.evacuation.zonesGeoJson.features.length) {
      const layer = L.geoJSON(status.evacuation.zonesGeoJson, {
        style: (f) => ({
          color: evacColor(f.properties.EvacLevel || f.properties.Evac_Label),
          weight: 2,
          fillOpacity: 0.3
        }),
        onEachFeature: (f, l) => {
          const name = f.properties.IncidentName || f.properties.incident_name || "Evacuation zone";
          const level = f.properties.EvacLevel || f.properties.Evac_Label || "";
          l.bindPopup(`<strong>${escapeHtml(name)}</strong><br>${escapeHtml(level)}`);
        }
      }).addTo(evacLayer);
      bounds.extend(layer.getBounds());
    }

    if (status.firePerimeter.perimetersGeoJson && status.firePerimeter.perimetersGeoJson.features.length) {
      const layer = L.geoJSON(status.firePerimeter.perimetersGeoJson, {
        style: { color: "#8a3a00", weight: 2, fillOpacity: 0.25, dashArray: "4 3" },
        onEachFeature: (f, l) => {
          l.bindPopup(`<strong>${escapeHtml(f.properties.poly_IncidentName)}</strong><br>Fire perimeter`);
        }
      }).addTo(perimeterLayer);
      bounds.extend(layer.getBounds());
    }

    if (status.nearbyFiresGeoJson && status.nearbyFiresGeoJson.features.length) {
      L.geoJSON(status.nearbyFiresGeoJson, {
        style: { color: "#c67a3c", weight: 1, fillOpacity: 0.12, dashArray: "2 4" },
        onEachFeature: (f, l) => {
          l.bindPopup(`<strong>${escapeHtml(f.properties.poly_IncidentName)}</strong><br>Nearby fire perimeter`);
        }
      }).addTo(nearbyFireLayer);
    }

    map.fitBounds(bounds.pad(0.4), { maxZoom: 13 });
  }

  function renderShelterMarkers(data) {
    sheltersLayer.clearLayers();
    for (const s of data.shelters) {
      if (typeof s.lat === "number" && typeof s.lng === "number") {
        L.marker([s.lat, s.lng], {
          icon: L.divIcon({ className: "", html: "🏠", iconSize: [20, 20] })
        })
          .addTo(sheltersLayer)
          .bindPopup(`<strong>${escapeHtml(s.name)}</strong><br>${escapeHtml(s.address)}`);
      }
    }
  }

  async function loadStaticData() {
    if (!providersCache) providersCache = (await fetchJson("/api/providers")).providers;
    if (!sheltersCache) sheltersCache = await fetchJson("/api/shelters");
    renderUtilities(providersCache);
    renderShelters(sheltersCache);
    renderShelterMarkers(sheltersCache);
  }

  // Shared by the "pick a suggestion", "press enter / click Check status", and
  // "use my location" paths — takes a resolved { lat, lng, matchedAddress } and
  // runs the status check + render.
  async function runStatusForGeo(geo) {
    clearError();
    setLoading(true);
    resultsSection.hidden = true;
    try {
      const status = await fetchJson(`/api/status?lat=${geo.lat}&lng=${geo.lng}`);
      await loadStaticData();
      resultsSection.hidden = false;
      renderBanner(status);
      renderEvac(status);
      renderFires(status);
      updateMap(geo, status);
      resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      showError(err.message || "Something went wrong. Please try a different address.");
    } finally {
      setLoading(false);
    }
  }

  async function runSearch(addressText) {
    clearError();
    setLoading(true);
    try {
      const geo = await fetchJson(`/api/geocode?q=${encodeURIComponent(addressText)}`);
      await runStatusForGeo(geo);
    } catch (err) {
      setLoading(false);
      showError(err.message || "Could not find that address. Try adding the city, or pick a suggestion from the dropdown.");
    }
  }

  function runSearchFromCoords(lat, lng) {
    runStatusForGeo({ lat, lng, matchedAddress: "Your current location" });
  }

  // ---- Address autocomplete (single-box flow: type, pick, done) ----
  let suggestItems = [];
  let activeSuggestIndex = -1;
  let suggestDebounce = null;
  let suggestRequestId = 0;

  function closeSuggestions() {
    suggestions.hidden = true;
    suggestions.innerHTML = "";
    suggestItems = [];
    activeSuggestIndex = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function renderSuggestionList(items, state) {
    suggestions.innerHTML = "";
    if (state === "loading") {
      suggestions.innerHTML = '<li class="loading">Searching…</li>';
      suggestions.hidden = false;
      input.setAttribute("aria-expanded", "true");
      return;
    }
    if (!items.length) {
      suggestions.innerHTML = '<li class="empty">No matches — keep typing, or press Enter to search anyway.</li>';
      suggestions.hidden = false;
      input.setAttribute("aria-expanded", "true");
      return;
    }
    items.forEach((item, i) => {
      const li = document.createElement("li");
      li.id = `suggestion-${i}`;
      li.setAttribute("role", "option");
      const parts = item.label.split(",");
      li.innerHTML = `<span class="primary">${escapeHtml(parts[0])}</span><span class="secondary">${escapeHtml(parts.slice(1).join(",").trim())}</span>`;
      li.addEventListener("mousedown", (e) => {
        // mousedown (not click) so it fires before the input's blur handler closes the list
        e.preventDefault();
        chooseSuggestion(i);
      });
      suggestions.appendChild(li);
    });
    suggestions.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function setActiveSuggestion(index) {
    const options = suggestions.querySelectorAll('li[role="option"]');
    options.forEach((el) => el.classList.remove("active"));
    activeSuggestIndex = index;
    if (index >= 0 && options[index]) {
      options[index].classList.add("active");
      options[index].scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", options[index].id);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function chooseSuggestion(index) {
    const item = suggestItems[index];
    if (!item) return;
    input.value = item.label;
    closeSuggestions();
    runStatusForGeo({ lat: item.lat, lng: item.lng, matchedAddress: item.label, source: "suggest" });
  }

  async function fetchSuggestions(q) {
    const myRequestId = ++suggestRequestId;
    renderSuggestionList([], "loading");
    try {
      const data = await fetchJson(`/api/suggest?q=${encodeURIComponent(q)}`);
      if (myRequestId !== suggestRequestId) return; // a newer keystroke superseded this request
      suggestItems = data.suggestions || [];
      renderSuggestionList(suggestItems, "done");
    } catch (err) {
      if (myRequestId !== suggestRequestId) return;
      suggestItems = [];
      renderSuggestionList([], "done");
    }
  }

  input.addEventListener("input", () => {
    const val = input.value.trim();
    clearTimeout(suggestDebounce);
    if (val.length < 4) {
      closeSuggestions();
      return;
    }
    suggestDebounce = setTimeout(() => fetchSuggestions(val), 300);
  });

  input.addEventListener("keydown", (e) => {
    const optionCount = suggestItems.length;
    if (suggestions.hidden || optionCount === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestion((activeSuggestIndex + 1) % optionCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestion((activeSuggestIndex - 1 + optionCount) % optionCount);
    } else if (e.key === "Enter") {
      if (activeSuggestIndex >= 0) {
        e.preventDefault();
        chooseSuggestion(activeSuggestIndex);
      } else {
        closeSuggestions();
      }
    } else if (e.key === "Escape") {
      closeSuggestions();
    }
  });

  input.addEventListener("blur", () => {
    // Slight delay so a suggestion's mousedown handler still fires first.
    setTimeout(closeSuggestions, 100);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = input.value.trim();
    if (!val) return;
    closeSuggestions();
    runSearch(val);
  });

  locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      showError("Geolocation is not available in this browser.");
      return;
    }
    clearError();
    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => runSearchFromCoords(pos.coords.latitude, pos.coords.longitude),
      () => {
        setLoading(false);
        showError("Could not get your location. Please enter an address instead.");
      }
    );
  });

  initMap();
})();
