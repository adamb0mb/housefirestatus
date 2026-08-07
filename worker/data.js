// Static reference data: utility/ISP directory and evacuation shelter list for the
// Spokane, WA area. There is no free, unified, real-time API for internet/cable/phone
// outages or for shelter rosters, so these are curated and link out to each provider's
// or agency's own live status tool. Update as the situation on the ground changes.

export const PROVIDERS = [
  {
    id: "avista-electric",
    category: "power",
    categoryLabel: "Electricity",
    name: "Avista Utilities",
    description: "Sole electric utility serving Spokane County.",
    statusCheckUrl: "https://www.myavista.com/outages/outage-map-how-to",
    outageMapUrl: "https://outagemap.myavista.com/",
    reportOutagePhone: "1-800-227-9187",
    smsInfo: "Text STAT to AVISTA (284782) for an outage status update on your address.",
    notes: "Avista does not publish a public real-time outage API, so live per-address status must be checked directly on their outage map or by phone/text."
  },
  {
    id: "avista-gas",
    category: "gas",
    categoryLabel: "Natural Gas",
    name: "Avista Utilities",
    description: "Sole natural gas utility serving Spokane County.",
    statusCheckUrl: "https://www.myavista.com/outages/outage-faqs",
    reportOutagePhone: "1-800-227-9187",
    emergencyPhone: "1-877-800-4426",
    notes: "If you smell gas or suspect a leak (especially after fire or structural damage), leave the area immediately and call the Avista gas emergency line: 1-877-800-4426."
  },
  {
    id: "comcast-xfinity",
    category: "internet_cable",
    categoryLabel: "Internet & Cable TV",
    name: "Comcast Xfinity",
    description: "Cable internet, TV, and phone provider in the Spokane metro area.",
    statusCheckUrl: "https://www.xfinity.com/support/status",
    reportOutagePhone: "1-800-934-6489"
  },
  {
    id: "charter-spectrum",
    category: "internet_cable",
    categoryLabel: "Internet & Cable TV",
    name: "Charter Spectrum",
    description: "Cable internet, TV, and phone provider serving parts of Spokane County.",
    statusCheckUrl: "https://www.spectrum.com/support/internet/service-outage",
    reportOutagePhone: "1-833-267-6094"
  },
  {
    id: "tds-telecom",
    category: "internet_phone",
    categoryLabel: "Internet & Home Phone",
    name: "TDS Telecom",
    description: "Fiber/DSL internet and landline telephone provider in parts of the Spokane area.",
    statusCheckUrl: "https://www.tdstelecom.com/support/outages.html",
    reportOutagePhone: "1-888-225-5837"
  },
  {
    id: "quantum-fiber",
    category: "internet_phone",
    categoryLabel: "Internet & Home Phone",
    name: "Quantum Fiber (Lumen/CenturyLink)",
    description: "Fiber/DSL internet and landline telephone provider in parts of the Spokane area.",
    statusCheckUrl: "https://www.centurylink.com/home/help/account/outage-check.html",
    reportOutagePhone: "1-800-244-1111"
  },
  {
    id: "ziply-fiber",
    category: "internet_phone",
    categoryLabel: "Internet & Home Phone",
    name: "Ziply Fiber",
    description: "Fiber internet and landline telephone provider serving parts of the Inland Northwest.",
    statusCheckUrl: "https://ziplyfiber.com/support",
    reportOutagePhone: "1-866-699-4759"
  },
  {
    id: "verizon-wireless",
    category: "cellular",
    categoryLabel: "Cellular",
    name: "Verizon",
    description: "Wireless carrier — cell towers can lose power or backhaul connectivity during wildfires.",
    statusCheckUrl: "https://www.verizon.com/support/residential/verizon-outage-updates",
    reportOutagePhone: "1-800-922-0204"
  },
  {
    id: "att-wireless",
    category: "cellular",
    categoryLabel: "Cellular",
    name: "AT&T",
    description: "Wireless carrier — cell towers can lose power or backhaul connectivity during wildfires.",
    statusCheckUrl: "https://www.att.com/outages/",
    reportOutagePhone: "1-800-331-0500"
  },
  {
    id: "tmobile-wireless",
    category: "cellular",
    categoryLabel: "Cellular",
    name: "T-Mobile",
    description: "Wireless carrier — cell towers can lose power or backhaul connectivity during wildfires.",
    statusCheckUrl: "https://www.t-mobile.com/coverage/network-status",
    reportOutagePhone: "1-800-937-8997"
  },
  {
    id: "spokane-water",
    category: "water",
    categoryLabel: "Water",
    name: "City of Spokane / Spokane County Water Purveyor",
    description: "Water service and boil-water advisories are managed by whichever city, county, or private water district serves your specific address (Spokane County has dozens of small water districts).",
    statusCheckUrl: "https://my.spokanecity.org/publicworks/water/",
    countyStatusUrl: "https://www.spokanecounty.gov/",
    notes: "After fire or evacuation, check for boil-water advisories before drinking tap water even if pressure has returned."
  }
];

export const SHELTERS = [
  {
    name: "Spokane Convention Center",
    servingIncident: "Old Trails Fire",
    address: "334 W Spokane Falls Blvd, Spokane, WA",
    notes: "Free parking; pets welcome. Verify current status before traveling.",
    lat: 47.6598,
    lng: -117.4213
  },
  {
    name: "Northwood Middle School",
    servingIncident: "Fairview Fire",
    address: "8918 N Ash St, Spokane, WA",
    notes: "Verify current status before traveling.",
    lat: 47.7442,
    lng: -117.4234
  },
  {
    name: "Jenkins High School (American Red Cross Shelter)",
    servingIncident: "South Stevens County evacuees",
    address: "112 W Country Ln, Chewelah, WA",
    notes: "Operated by the American Red Cross. Verify current status before traveling.",
    lat: 48.2732,
    lng: -117.7146
  }
];

export const AUTHORITATIVE_LINKS = [
  { label: "InciWeb — Spokane Area Fires", url: "https://inciweb.wildfire.gov/incident-information/wanes-spokane-area-fires" },
  { label: "Spokane County emergency news & updates", url: "https://www.spokanecounty.gov/3948/Open-Data" },
  { label: "Spokane County official evacuation zone lookup", url: "https://www.arcgis.com/apps/instant/lookup/index.html?appid=337af083184c474d9d9181bb44f957b0" },
  { label: "Washington DNR wildfire portal", url: "https://dnr.wa.gov/wildfire-resources/current-wildfire-incident-information/wildfire-portal" },
  { label: "American Red Cross shelter finder", url: "https://www.redcross.org/get-help/disaster-relief-and-recovery-services/find-an-open-shelter.html" },
  { label: "FCC National Broadband Map (check providers at any address)", url: "https://broadbandmap.fcc.gov/home" }
];
