import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import "./MapView.css";

/** Brain SVG icon (two-hemisphere, filled). Fill pulses via CSS; stroke is always gray. */
function BrainIcon({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="#64748b"
      strokeWidth="0.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
    </svg>
  );
}

/**
 * Props is a loose "bag of properties" type for whatever comes from GeoJSON feature.properties.
 * Kept flexible because GeoJSON properties can vary by dataset.
 */
type Props = Record<string, any> | null;

// Color used to highlight a selected county — matches the county border color.
const COUNTY_SELECTED_COLOR = "#7bc897";

// Approximate 2024 populations for the 9 Bay Area counties in the dataset.
const COUNTY_POPULATION: Record<string, number> = {
  "Alameda":       1_685_000,
  "Contra Costa":  1_165_000,
  "Marin":           264_000,
  "Napa":            138_000,
  "San Francisco":   874_000,
  "San Mateo":       765_000,
  "Santa Clara":   1_950_000,
  "Solano":          465_000,
  "Sonoma":          494_000,
};

// Ray-casting point-in-polygon for a single ring (exterior only).
function pointInRing(point: [number, number], ring: number[][]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInFeature(point: [number, number], geometry: any): boolean {
  if (geometry.type === "Polygon") return pointInRing(point, geometry.coordinates[0]);
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((poly: number[][][]) => pointInRing(point, poly[0]));
  }
  return false;
}

function countyNameForPoint(point: [number, number], counties: any): string | null {
  const features = counties?.features ?? [];
  for (const f of features) {
    if (pointInFeature(point, f?.geometry)) {
      const p = f?.properties ?? {};
      return p.county ?? p.name ?? p.NAME ?? p.county_name ?? null;
    }
  }
  return null;
}

// Green -> red criticality color scale (index 0 = criticality 1, index 4 = criticality 5).
// Single source of truth shared by map dots and the info panel badge.
const CRIT_SCALE = {
  outer:   ["#22C55E", "#84CC16", "#EAB308", "#F97316", "#EF4444"],
  core:    ["#15803D", "#4D7C0F", "#713F12", "#7C2D12", "#7F1D1D"],
  badgeBg: ["#22C55E", "#84CC16", "#EAB308", "#F97316", "#EF4444"],
  badgeFg: ["#fff",    "#fff",    "#1f2937", "#fff",    "#fff"   ],
};

// Slightly brighter core colors for dark basemap mode to improve point readability.
const CRIT_SCALE_DARK_CORE = ["#22C55E", "#84CC16", "#EAB308", "#FB923C", "#F87171"];

// Builds a Mapbox interpolation expression over criticality 1-5.
// Features with no criticality (null/0) receive the `fallback` color.
function critExpr(colors: string[], fallback: string): mapboxgl.ExpressionSpecification {
  return [
    "interpolate", ["linear"],
    ["coalesce", ["to-number", ["get", "criticality"]], 0],
    0, fallback,
    1, colors[0], 2, colors[1], 3, colors[2], 4, colors[3], 5, colors[4],
  ] as mapboxgl.ExpressionSpecification;
}

// Defines how substations should look in the default mode.
const SUBSTATION_DEFAULT = {
  coreRadius: 4,
  coreColor: "#7B20D0",   // dark purple center
  coreOpacity: 0.95,
  outerRadius: 10,
  outerColor: "#d95af9",  // lighter purple outer (keeping your color)
  outerOpacity: 0.55,
  outerBlur: 0.85,
  glowRadius: 16,
  glowColor: "#fcee9f",
  glowOpacity: 0.2,
  glowBlur: 0.85,
};

const DRIVER_TYPES = [
  { label: "Vegetation exposure", code: "VEG", color: "#2E7D32" },
  { label: "Load stress", code: "LOAD", color: "#D97706" },
  { label: "Aging equipment", code: "AGE", color: "#B45309" },
  { label: "Weather exposure", code: "WTH", color: "#0369A1" },
  { label: "Single-feed dependency", code: "SFD", color: "#7C3AED" },
] as const;

const HAZARD_SEVERITY_LEVELS = [
  { label: "Low", color: "#FDE68A", borderColor: "#F59E0B" },
  { label: "Moderate", color: "#FB923C", borderColor: "#EA580C" },
  { label: "High", color: "#EF4444", borderColor: "#B91C1C" },
] as const;

function buildMockDriversGeoJSON(substations: any) {
  const features = (substations?.features ?? []).map((f: any) => {
    const props = f?.properties ?? {};
    const seed = hashString(String(props.asset_id ?? props.name ?? "substation"));
    const driver = DRIVER_TYPES[seed % DRIVER_TYPES.length];
    const crit = Number(props.criticality ?? 1);
    const severity = crit >= 4 ? "High" : crit === 3 ? "Moderate" : "Low";

    return {
      type: "Feature",
      geometry: f.geometry,
      properties: {
        asset_id: props.asset_id,
        name: props.name,
        criticality: crit,
        driver: driver.label,
        driver_code: driver.code,
        driver_color: driver.color,
        severity,
        note: "Simulated driver for demo purposes.",
      },
    };
  });

  return { type: "FeatureCollection", features };
}

function buildAnnotationsGeoJSON(items: Array<{ id: string; lng: number; lat: number; note: string }>) {
  return {
    type: "FeatureCollection",
    features: items.map((a) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [a.lng, a.lat] },
      properties: { id: a.id, note: a.note },
    })),
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function formatMonths(totalMonths: number): string {
  if (totalMonths < 12) return `${totalMonths} month${totalMonths === 1 ? "" : "s"}`;
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  if (months === 0) return `${years} year${years === 1 ? "" : "s"}`;
  return `${years}y ${months}m`;
}

function getCriticalityDuration(props: Props): string {
  const crit = Number(props?.criticality ?? 0);
  if (!Number.isFinite(crit) || crit <= 0) return "Unknown";

  const idSeed = String(props?.asset_id ?? props?.name ?? "substation");
  const seed = hashString(idSeed);
  const baseByCrit = [0, 7, 11, 16, 22, 30]; // index 1-5
  const jitter = seed % 9; // 0-8 months
  const months = baseByCrit[Math.max(1, Math.min(5, crit))] + jitter;
  return formatMonths(months);
}

function getMockDriverForProps(props: Props) {
  const idSeed = String(props?.asset_id ?? props?.name ?? "substation");
  const seed = hashString(idSeed);
  const driver = DRIVER_TYPES[seed % DRIVER_TYPES.length];
  const crit = Number(props?.criticality ?? 1);
  const severity = crit >= 4 ? "High" : crit === 3 ? "Moderate" : "Low";
  return { ...driver, severity };
}

function formatSubstationName(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "Unnamed substation";

  return raw
    .split(/(\s+|-|\/)/)
    .map((token) => {
      if (!token || /^\s+$/.test(token) || token === "-" || token === "/") return token;
      if (/^[A-Z0-9]{2,}$/.test(token)) return token;
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join("");
}

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const riskViewRef = useRef(false);
  const substationsDataRef = useRef<any>(null);
  const countiesDataRef = useRef<any>(null);
  const linesDataRef = useRef<any>(null);
  const hazardsDataRef = useRef<any>(null);
  // Mirror refs so style.load callbacks always see current state without stale closures.
  const showCountiesRef = useRef(true);
  const showSubstationsRef = useRef(true);
  const showDriversRef = useRef(false);
  const showHazardsRef = useRef(false);
  const selectedCountyNameRef = useRef<string | null>(null);
  const themeRef = useRef<"light" | "dark" | "berry">("light");
  const [styleVersion, setStyleVersion] = useState(0);
  const hoveredCountyNameRef = useRef<string | null>(null);
  const critFilterRef = useRef<Set<number>>(new Set([1, 2, 3, 4, 5]));
  const driverFilterRef = useRef<Set<string>>(new Set(DRIVER_TYPES.map((d) => d.code)));
  const hazardSeverityFilterRef = useRef<Set<string>>(new Set(HAZARD_SEVERITY_LEVELS.map((h) => h.label)));
  const annotationsRef = useRef<Array<{ id: string; lng: number; lat: number; note: string }>>([]);
  const annotationModeRef = useRef(false);
  const annotationDraftRef = useRef("field note");

  /**
   * Mapbox token UX:
   * If a candidate hasn't provided VITE_MAPBOX_TOKEN, we show an in-app message
   * instead of a blank page + console errors.
   */
  const [missingMapboxToken, setMissingMapboxToken] = useState(false);

  /**
   * Info panel selection state:
   * - selectedProps: properties of a clicked substation feature
   * - selectedCountyName: name of a clicked county polygon
   *
   * Note: When a user clicks a county, we clear selectedProps, and vice versa,
   * so the panel is never showing two conflicting "selected" things at once.
   */
  const [selectedProps, setSelectedProps] = useState<Props>(null);
  const [selectedSubCountyName, setSelectedSubCountyName] = useState<string | null>(null);
  const [selectedCountyName, setSelectedCountyName] = useState<string | null>(null);
  const [countySubstations, setCountySubstations] = useState<Props[]>([]);
  const [countyPopulation, setCountyPopulation] = useState<number | null>(null);

  /**
   * UI toggles that control what appears on the map.
   * These are pure React state, and we "apply" them to Mapbox by calling:
   * map.setLayoutProperty(...) and map.setPaintProperty(...)
   */
  const [showSubstations, setShowSubstations] = useState(true);
  const [riskView, setRiskView] = useState(false);
  const [showDrivers, setShowDrivers] = useState(false);
  const [showHazards, setShowHazards] = useState(false);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState("field note");
  const [annotations, setAnnotations] = useState<Array<{ id: string; lng: number; lat: number; note: string }>>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showCounties, setShowCounties] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark" | "berry">("light");
  const darkMode = theme === "dark";
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isRiskLegendCollapsed, setIsRiskLegendCollapsed] = useState(false);
  const [isDriverLegendCollapsed, setIsDriverLegendCollapsed] = useState(false);
  const [isHazardLegendCollapsed, setIsHazardLegendCollapsed] = useState(false);
  const [isLegendsCollapsed, setIsLegendsCollapsed] = useState(false);
  const [isNeedToKnowCollapsed, setIsNeedToKnowCollapsed] = useState(true);
  const [isFilterCollapsed, setIsFilterCollapsed] = useState(true);
  const [isSearchCollapsed, setIsSearchCollapsed] = useState(true);
  const [isAnnotationCollapsed, setIsAnnotationCollapsed] = useState(true);
  const [hoveredSubProps, setHoveredSubProps] = useState<Props>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [hoveredCountyName, setHoveredCountyName] = useState<string | null>(null);
  const [countyHoverPos, setCountyHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [critFilter, setCritFilter] = useState<Set<number>>(() => new Set([1, 2, 3, 4, 5]));
  const [driverFilter, setDriverFilter] = useState<Set<string>>(() => new Set(DRIVER_TYPES.map((d) => d.code)));
  const [hazardSeverityFilter, setHazardSeverityFilter] = useState<Set<string>>(
    () => new Set(HAZARD_SEVERITY_LEVELS.map((h) => h.label))
  );
  const hasActiveFilters =
    critFilter.size < 5 ||
    driverFilter.size < DRIVER_TYPES.length ||
    hazardSeverityFilter.size < HAZARD_SEVERITY_LEVELS.length;
  const noPrimaryLayersActive = !showCounties && !showSubstations;
  const filteredSubstations = ((substationsDataRef.current?.features ?? []) as any[])
    .filter((f: any) => critFilter.has(Number(f?.properties?.criticality ?? 0)));
  const shownSubstationsCount = filteredSubstations.length;
  const highCriticalCount = filteredSubstations.filter((f: any) => Number(f?.properties?.criticality ?? 0) >= 4).length;

  useEffect(() => {
    annotationsRef.current = annotations;
    const map = mapRef.current;
    if (!map || !map.getSource("annotations")) return;
    (map.getSource("annotations") as mapboxgl.GeoJSONSource).setData(buildAnnotationsGeoJSON(annotations) as any);
  }, [annotations]);

  useEffect(() => { annotationModeRef.current = annotationMode; }, [annotationMode]);
  useEffect(() => { annotationDraftRef.current = annotationDraft; }, [annotationDraft]);

  const handleSearchGo = () => {
    const map = mapRef.current;
    const q = searchQuery.trim().toLowerCase();
    if (!map || !q) return;

    const subs = (substationsDataRef.current?.features ?? []) as any[];
    const counties = (countiesDataRef.current?.features ?? []) as any[];

    const subExact = subs.find((f) => String(f?.properties?.name ?? "").toLowerCase() === q);
    const subFuzzy = subExact ?? subs.find((f) => String(f?.properties?.name ?? "").toLowerCase().includes(q));

    if (subFuzzy) {
      const [lng, lat] = subFuzzy.geometry.coordinates;
      map.flyTo({ center: [lng, lat], zoom: 11, duration: 700 });
      setSelectedProps(subFuzzy.properties as any);
      setSelectedSubCountyName(countyNameForPoint([lng, lat], countiesDataRef.current));
      setSelectedCountyName(null);
      map.setFilter("counties-fill-selected", ["==", ["get", "county"], ""] as any);
      map.setFilter("counties-outline-selected", ["==", ["get", "county"], ""] as any);
      setIsPanelCollapsed(false);
      return;
    }

    const getCountyName = (f: any) => String(f?.properties?.county ?? f?.properties?.name ?? "");
    const countyExact = counties.find((f) => getCountyName(f).toLowerCase() === q);
    const countyFuzzy = countyExact ?? counties.find((f) => getCountyName(f).toLowerCase().includes(q));
    if (!countyFuzzy) return;

    const name = getCountyName(countyFuzzy);
    const nameFilter = ["==", ["get", "county"], name];
    map.setFilter("counties-fill-selected", nameFilter as any);
    map.setFilter("counties-outline-selected", nameFilter as any);

    const coords: Array<[number, number]> = [];
    const pushCoord = (c: any) => {
      if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") coords.push([c[0], c[1]]);
      else if (Array.isArray(c)) c.forEach(pushCoord);
    };
    pushCoord(countyFuzzy.geometry?.coordinates);
    if (coords.length > 0) {
      let minX = coords[0][0], minY = coords[0][1], maxX = coords[0][0], maxY = coords[0][1];
      for (const [x, y] of coords) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      map.fitBounds([minX, minY, maxX, maxY], { padding: 60, duration: 700 });
    }

    const countyGeom = countyFuzzy.geometry;
    const countySubs: Props[] = [];
    for (const sub of subs) {
      const [lng, lat] = sub.geometry.coordinates;
      if (pointInFeature([lng, lat], countyGeom)) countySubs.push(sub.properties as Props);
    }
    countySubs.sort((a, b) => (a?.criticality ?? 0) - (b?.criticality ?? 0));

    setSelectedCountyName(name);
    setCountySubstations(countySubs);
    setCountyPopulation(name ? (COUNTY_POPULATION[name] ?? null) : null);
    setSelectedProps(null);
    setSelectedSubCountyName(null);
    setIsPanelCollapsed(false);
  };

  const handleOpenSnapshotHtml = () => {
    const map = mapRef.current;
    const center = map?.getCenter();
    const zoom = map?.getZoom();
    let mapImageMarkup = '<div class="empty">Map preview unavailable for this snapshot.</div>';
    if (map) {
      try {
        const dataUrl = map.getCanvas().toDataURL("image/png");
        mapImageMarkup = `<div class="map-image-wrap"><img class="map-image" src="${dataUrl}" alt="Snapshot of the current utility risk map view" /></div>`;
      } catch {
        mapImageMarkup = '<div class="empty">Map preview unavailable for this snapshot.</div>';
      }
    }
    const county = selectedCountyName ?? "None";
    const subName = selectedProps?.name ? formatSubstationName(selectedProps?.name) : "None";
    const subId = String(selectedProps?.asset_id ?? "-");
    const titleTheme = `${theme.slice(0, 1).toUpperCase()}${theme.slice(1)}`;
    const activeSubs = ((substationsDataRef.current?.features ?? []) as any[])
      .filter((f: any) => critFilter.has(Number(f?.properties?.criticality ?? 0)));
    const filteredHazards = ((hazardsDataRef.current?.features ?? []) as any[])
      .filter((f: any) => hazardSeverityFilter.has(String(f?.properties?.severity ?? "Moderate")));
    const highCriticalAssets = activeSubs
      .filter((f: any) => Number(f?.properties?.criticality ?? 0) >= 4)
      .sort((a: any, b: any) => Number(b?.properties?.criticality ?? 0) - Number(a?.properties?.criticality ?? 0))
    const highCriticalRows = highCriticalAssets
      .map((f: any) => {
        const p = f?.properties ?? {};
        const driver = getMockDriverForProps(p);
        return `<tr><td>${escapeHtml(formatSubstationName(p.name))}</td><td>${escapeHtml(String(p.asset_id ?? "-"))}</td><td><span class="pill pill-risk">Criticality ${Number(p.criticality ?? 0)}</span></td><td>${escapeHtml(driver.code)}</td><td>${escapeHtml(getCriticalityDuration(p))}</td><td>${escapeHtml(String(p.operator_zone ?? "-"))}</td></tr>`;
      })
      .join("");

    const driverCounts = activeSubs.reduce((acc: Record<string, number>, f: any) => {
      const driver = getMockDriverForProps(f?.properties ?? null);
      if (!driverFilter.has(driver.code)) return acc;
      acc[driver.code] = (acc[driver.code] ?? 0) + 1;
      return acc;
    }, {});
    const topDriversMarkup = Object.entries(driverCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([code, count]) => `<div class="stack-row"><span class="stack-key">${escapeHtml(code)}</span><strong>${count}</strong></div>`)
      .join("");
    const hazardBreakdownMarkup = HAZARD_SEVERITY_LEVELS
      .map((level) => {
        const count = filteredHazards.filter((f: any) => String(f?.properties?.severity ?? "Moderate") === level.label).length;
        return `<div class="stack-row"><span class="stack-key">${escapeHtml(level.label)}</span><strong>${count}</strong></div>`;
      })
      .join("");

    const riskRatio = shownSubstationsCount === 0 ? 0 : highCriticalCount / shownSubstationsCount;
    const hasHighCriticalLevelsSelected = critFilter.has(4) || critFilter.has(5);
    const generatedAt = new Date();
    const generatedAtLabel = generatedAt.toLocaleString();
    const generatedDate = generatedAt.toISOString().slice(0, 10);
    const criticalitySignature = [...critFilter].sort((a, b) => a - b).join("-") || "none";
    const driverSignature = [...driverFilter].sort().join("-") || "none";
    const hazardSignature = [...hazardSeverityFilter].sort().join("-") || "none";
    const filterSignature = `c:${criticalitySignature}|d:${driverSignature}|h:${hazardSignature}`;
    const cleanScope = (selectedCountyName ?? selectedProps?.name ?? "territory")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "territory";
    const highCriticalCardNote = !hasHighCriticalLevelsSelected
      ? "Criticality levels 4-5 are not selected in the current filter."
      : "Assets in criticality bands 4-5.";
    const riskPosture = shownSubstationsCount === 0
      ? { label: "No assets in scope", tone: "neutral", detail: "Current filters exclude all substations." }
      : riskRatio >= 0.35
        ? { label: "Critical posture", tone: "critical", detail: "A large share of visible assets are in criticality bands 4-5." }
        : riskRatio >= 0.18
          ? { label: "Elevated posture", tone: "elevated", detail: "Visible risk is concentrated enough to warrant follow-up review." }
          : { label: "Controlled posture", tone: "stable", detail: "Critical assets are limited relative to the current view." };

    const visibleLayers = [
      showCounties ? "Counties" : null,
      showSubstations ? "Substations" : null,
      showDrivers ? "Drivers" : null,
      showHazards ? "Hazards" : null,
    ].filter(Boolean).join(" • ") || "None";

    const scopeSummary = selectedProps
      ? `Focused on substation ${escapeHtml(subName)} in operator zone ${escapeHtml(String(selectedProps?.operator_zone ?? "-"))}.`
      : selectedCountyName
        ? `Focused on ${escapeHtml(selectedCountyName)} County with ${countySubstations.length} substations in the selected footprint.`
        : "Territory-wide view across the current filtered service footprint.";

    const executiveSummaryParts = [
      `This snapshot captures ${shownSubstationsCount} substations in scope, with ${highCriticalCount} currently in criticality bands 4-5.`,
      filteredHazards.length > 0
        ? `${filteredHazards.length} hazard zones match the active severity filter.`
        : "No hazard zones are in scope under the current severity filter.",
      hasActiveFilters
        ? "The report reflects an actively filtered operational view."
        : "The report reflects the full default operating view.",
      scopeSummary,
    ];
    const executiveSummary = executiveSummaryParts.join(" ");

    const recommendations = [
      highCriticalAssets.length > 0
        ? `Review the highest critical substations first, starting with ${escapeHtml(formatSubstationName(highCriticalAssets[0]?.properties?.name))}.`
        : "No high-criticality substations are currently in scope; confirm whether that is expected or filter-driven.",
      showHazards && filteredHazards.length > 0
        ? `Cross-check the ${filteredHazards.length} in-scope hazard zones against dispatch or vegetation management priorities.`
        : "Enable the hazard layer before sharing weather-driven risk context with stakeholders.",
      annotations.length > 0
        ? `Roll ${annotations.length} field note${annotations.length === 1 ? "" : "s"} into the follow-up workflow so observations are not lost after review.`
        : "Capture field notes directly on the map to turn the snapshot into an actionable handoff artifact.",
    ];
    const recommendationMarkup = recommendations
      .map((item) => `<li>${item}</li>`)
      .join("");

    const filtersMarkup = [
      { label: "Criticality", value: [...critFilter].sort((a, b) => a - b).join(", ") || "None" },
      { label: "Drivers", value: [...driverFilter].sort().join(", ") || "None" },
      { label: "Hazard severity", value: [...hazardSeverityFilter].sort().join(", ") || "None" },
    ]
      .map((item) => `<div class="filter-chip"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`)
      .join("");

    const highCriticalVisibilityNote = !hasHighCriticalLevelsSelected
      ? '<div class="inline-warning">Critical assets are hidden because criticality levels 4-5 are not selected.</div>'
      : "";

    const highCriticalTableEmpty = !hasHighCriticalLevelsSelected
      ? '<div class="empty">No rows shown because criticality levels 4-5 are not selected in the current filter.</div>'
      : '<div class="empty">No high-criticality substations are currently in scope.</div>';

    const selectedCountyDetails = selectedCountyName
      ? `<section class="section">
          <div class="section-heading">
            <div>
              <div class="eyebrow">Focused geography</div>
              <h2>County context</h2>
            </div>
          </div>
          <div class="detail-grid">
            <div class="detail-card"><span class="label">County</span><strong>${escapeHtml(selectedCountyName)}</strong></div>
            <div class="detail-card"><span class="label">Population</span><strong>${countyPopulation?.toLocaleString() ?? "Unknown"}</strong></div>
            <div class="detail-card"><span class="label">Substations in county</span><strong>${countySubstations.length}</strong></div>
          </div>
          ${countySubstations.length === 0
            ? "<div class=\"empty\">No substations found in the selected county.</div>"
            : `<table><thead><tr><th>Substation</th><th>Criticality</th></tr></thead><tbody>${countySubstations
                .slice()
                .sort((a, b) => Number(b?.criticality ?? 0) - Number(a?.criticality ?? 0))
                .map((s) => `<tr><td>${escapeHtml(formatSubstationName(s?.name))}</td><td>${Number(s?.criticality ?? 0)}</td></tr>`)
                .join("")}</tbody></table>`}
        </section>`
      : "";

    const selectedSubDetails = selectedProps
      ? (() => {
          const driver = getMockDriverForProps(selectedProps);
          return `<section class="section">
            <div class="section-heading">
              <div>
                <div class="eyebrow">Focused asset</div>
                <h2>Selected substation</h2>
              </div>
              <span class="pill pill-risk">Criticality ${Number(selectedProps?.criticality ?? 0)}</span>
            </div>
            <div class="detail-grid">
              <div class="detail-card"><span class="label">Name</span><strong>${escapeHtml(formatSubstationName(selectedProps?.name))}</strong></div>
              <div class="detail-card"><span class="label">Asset ID</span><strong>${escapeHtml(String(selectedProps?.asset_id ?? "-"))}</strong></div>
              <div class="detail-card"><span class="label">Operator zone</span><strong>${escapeHtml(String(selectedProps?.operator_zone ?? "-"))}</strong></div>
              <div class="detail-card"><span class="label">Asset type</span><strong>${escapeHtml(String(selectedProps?.asset_type ?? "-"))}</strong></div>
              <div class="detail-card"><span class="label">Time at current criticality</span><strong>${escapeHtml(getCriticalityDuration(selectedProps))}</strong></div>
              <div class="detail-card"><span class="label">Primary driver</span><strong>${escapeHtml(driver.code)} - ${escapeHtml(driver.label)}</strong><span class="meta-inline">${escapeHtml(driver.severity)} severity signal</span></div>
            </div>
          </section>`;
        })()
      : "";
    const notesRows = annotations
      .map((a, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(a.note)}</td><td>${a.lng.toFixed(5)}, ${a.lat.toFixed(5)}</td></tr>`)
      .join("");

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Operational Risk Snapshot</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f7fb;
      --panel: rgba(255, 255, 255, 0.94);
      --panel-strong: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --border: #dbe4ef;
      --accent: #0f766e;
      --accent-soft: rgba(15, 118, 110, 0.12);
      --critical: #b91c1c;
      --critical-soft: rgba(185, 28, 28, 0.1);
      --warning: #b45309;
      --warning-soft: rgba(180, 83, 9, 0.1);
      --stable: #166534;
      --stable-soft: rgba(22, 101, 52, 0.1);
      --shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      font-family: "IBM Plex Sans", "Aptos", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(14, 165, 233, 0.10), transparent 28%),
        linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
    }
    h1, h2, h3, p { margin: 0; }
    .report {
      max-width: 1240px;
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: flex-start;
      padding: 28px;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: linear-gradient(135deg, rgba(255,255,255,0.98), rgba(245,250,255,0.96));
      box-shadow: var(--shadow);
    }
    .hero-copy { max-width: 760px; }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
      font-weight: 700;
      margin-bottom: 10px;
    }
    .hero h1 { font-size: 34px; line-height: 1.05; margin-bottom: 12px; }
    .hero p { color: var(--muted); line-height: 1.55; }
    .hero-meta {
      min-width: 260px;
      display: grid;
      gap: 12px;
      padding: 16px;
      border-radius: 18px;
      border: 1px solid var(--border);
      background: var(--panel-strong);
    }
    .meta-block span, .label {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #64748b;
      margin-bottom: 6px;
      font-weight: 700;
    }
    .meta-block strong { font-size: 15px; }
    .summary-banner {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      align-items: center;
      padding: 18px 22px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .summary-banner p { color: var(--muted); line-height: 1.55; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .pill-risk { background: var(--critical-soft); color: var(--critical); }
    .pill-neutral { background: #e2e8f0; color: #334155; }
    .pill-critical { background: var(--critical-soft); color: var(--critical); }
    .pill-elevated { background: var(--warning-soft); color: var(--warning); }
    .pill-stable { background: var(--stable-soft); color: var(--stable); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }
    .card, .section {
      border: 1px solid var(--border);
      border-radius: 20px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .card { padding: 20px; }
    .value {
      font-size: 29px;
      font-weight: 700;
      letter-spacing: -0.03em;
      margin-bottom: 6px;
    }
    .subvalue { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .inline-warning {
      margin-top: 10px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid #f5c2c7;
      background: #fff1f2;
      color: #9f1239;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.35;
    }
    .section { padding: 22px; }
    .section-heading {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
    }
    .section h2 { font-size: 20px; }
    .two-col {
      display: grid;
      grid-template-columns: minmax(0, 1.6fr) minmax(280px, 0.9fr);
      gap: 18px;
    }
    .stack { display: grid; gap: 12px; }
    .stack-panel {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--panel-strong);
      padding: 16px;
    }
    .stack-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #edf2f7;
    }
    .stack-row:last-child { border-bottom: 0; }
    .stack-key { color: var(--muted); }
    .filter-row, .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
    }
    .filter-chip, .detail-card {
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: var(--panel-strong);
    }
    .filter-chip strong, .detail-card strong {
      display: block;
      font-size: 15px;
      line-height: 1.4;
    }
    .meta-inline {
      display: block;
      margin-top: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .map-image-wrap {
      border: 1px solid var(--border);
      border-radius: 18px;
      overflow: hidden;
      background: #dbeafe;
    }
    .map-image {
      display: block;
      width: 100%;
      height: auto;
      aspect-ratio: 16 / 9;
      object-fit: cover;
      object-position: center;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      overflow: hidden;
      border-radius: 14px;
      background: var(--panel-strong);
    }
    th, td {
      padding: 12px 14px;
      text-align: left;
      font-size: 13px;
      border-bottom: 1px solid #edf2f7;
      vertical-align: top;
    }
    th {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #64748b;
      background: #f8fbff;
    }
    tr:last-child td { border-bottom: 0; }
    .empty {
      padding: 14px 16px;
      border: 1px dashed var(--border);
      border-radius: 16px;
      color: var(--muted);
      background: rgba(255,255,255,0.65);
    }
    .actions { display: flex; justify-content: flex-end; }
    button {
      border: 1px solid var(--border);
      background: var(--panel-strong);
      color: var(--text);
      border-radius: 999px;
      padding: 10px 16px;
      cursor: pointer;
      font-weight: 600;
    }
    ul { margin: 0; padding-left: 18px; color: var(--muted); }
    li + li { margin-top: 8px; }
    .footer-note {
      padding: 16px 18px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.75);
      color: var(--muted);
      line-height: 1.55;
      font-size: 13px;
    }
    @media (max-width: 900px) {
      body { padding: 18px; }
      .hero, .summary-banner, .section-heading { display: grid; }
      .hero-meta { min-width: 0; }
      .two-col { grid-template-columns: 1fr; }
    }
    @media print {
      body { padding: 0; background: #ffffff; }
      .report { max-width: none; }
      .hero, .summary-banner, .card, .section, .footer-note { box-shadow: none; }
      .actions { display: none; }
    }
  </style>
</head>
<body>
  <div class="report">
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">Operational Snapshot</div>
        <h1>Service Territory Risk Report</h1>
        <p>${executiveSummary}</p>
      </div>
      <div class="hero-meta">
        <div class="meta-block"><span>Generated</span><strong>${generatedAtLabel}</strong></div>
        <div class="meta-block"><span>Filter signature</span><strong>${escapeHtml(filterSignature)}</strong></div>
        <div class="meta-block"><span>Theme</span><strong>${escapeHtml(titleTheme)}</strong></div>
        <div class="meta-block"><span>Visible layers</span><strong>${escapeHtml(visibleLayers)}</strong></div>
        <div class="actions"><button onclick="window.print()">Print report</button></div>
      </div>
    </section>

    <section class="summary-banner">
      <div>
        <div class="eyebrow">Current posture</div>
        <p>${escapeHtml(riskPosture.detail)}</p>
      </div>
      <span class="pill pill-${riskPosture.tone}">${escapeHtml(riskPosture.label)}</span>
    </section>

    <section class="grid">
      <div class="card"><div class="label">Assets in scope</div><div class="value">${shownSubstationsCount}</div><div class="subvalue">Substations visible under the active criticality filter.</div></div>
      <div class="card"><div class="label">Critical assets</div><div class="value">${highCriticalCount}</div><div class="subvalue">${highCriticalCardNote}</div>${highCriticalVisibilityNote}</div>
      <div class="card"><div class="label">Hazard zones in scope</div><div class="value">${filteredHazards.length}</div><div class="subvalue">Polygons matching the current hazard severity filter.</div></div>
      <div class="card"><div class="label">Field notes</div><div class="value">${annotations.length}</div><div class="subvalue">Operator annotations attached to this view.</div></div>
    </section>

    <section class="section">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Scope and controls</div>
          <h2>Report scope</h2>
        </div>
        <span class="pill ${hasActiveFilters ? "pill-elevated" : "pill-neutral"}">${hasActiveFilters ? "Filtered view" : "Default view"}</span>
      </div>
      <div class="filter-row">
        <div class="detail-card"><span class="label">Selected county</span><strong>${escapeHtml(county)}</strong></div>
        <div class="detail-card"><span class="label">Selected substation</span><strong>${escapeHtml(subName)}</strong><span class="meta-inline">Asset ID: ${escapeHtml(subId)}</span></div>
        <div class="detail-card"><span class="label">Map center</span><strong>${center ? `${center.lng.toFixed(4)}, ${center.lat.toFixed(4)}` : "Unavailable"}</strong></div>
        <div class="detail-card"><span class="label">Map zoom</span><strong>${typeof zoom === "number" ? zoom.toFixed(2) : "Unavailable"}</strong></div>
      </div>
      <div class="filter-row" style="margin-top: 12px;">
        ${filtersMarkup}
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Spatial context</div>
          <h2>Map view</h2>
        </div>
      </div>
      ${mapImageMarkup}
    </section>

    <section class="two-col">
      <section class="section">
        <div class="section-heading">
          <div>
            <div class="eyebrow">Priority review</div>
            <h2>Critical assets</h2>
          </div>
        </div>
        ${highCriticalRows
          ? `<table><thead><tr><th>Name</th><th>Asset ID</th><th>Criticality</th><th>Driver</th><th>Time at level</th><th>Operator zone</th></tr></thead><tbody>${highCriticalRows}</tbody></table>`
          : highCriticalTableEmpty}
      </section>

      <section class="stack">
        <section class="section">
          <div class="section-heading">
            <div>
              <div class="eyebrow">Signal mix</div>
              <h2>Driver distribution</h2>
            </div>
          </div>
          <div class="stack-panel">
            ${topDriversMarkup || '<div class="empty">No driver signals are visible under the current filters.</div>'}
          </div>
        </section>

        <section class="section">
          <div class="section-heading">
            <div>
              <div class="eyebrow">Hazard overview</div>
              <h2>Severity breakdown</h2>
            </div>
          </div>
          <div class="stack-panel">
            ${hazardBreakdownMarkup}
          </div>
        </section>
      </section>
    </section>

    <section class="section">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Suggested follow-up</div>
          <h2>Recommended actions</h2>
        </div>
      </div>
      <ul>${recommendationMarkup}</ul>
    </section>

    ${selectedCountyDetails}
    ${selectedSubDetails}

    <section class="section">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Operator input</div>
          <h2>Field notes</h2>
        </div>
      </div>
      ${annotations.length === 0 ? "<div class=\"empty\">No field notes have been saved in this snapshot.</div>" : `<table><thead><tr><th>#</th><th>Note</th><th>Coordinates</th></tr></thead><tbody>${notesRows}</tbody></table>`}
    </section>

    <div class="footer-note"><strong>Simulation notice:</strong> atmospheric hazard zones, driver labels, time-at-criticality, annotation notes, county population values, and this snapshot are prototype simulation outputs rather than a live production feed.</div>
  </div>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    // Open a live preview tab first.
    window.open(url, "_blank");

    // Then ask whether to download the same snapshot as an .html file.
    const shouldDownload = window.confirm("would you like to download a snapshot file?");
    if (shouldDownload) {
      const a = document.createElement("a");
      a.href = url;
      a.download = `risk-snapshot-${cleanScope}-${generatedDate}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    // Keep URL alive briefly for the opened tab/download, then release memory.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  /**
   * If substations are hidden, hide riskView, because it only affects the styling of substations.
   */
  useEffect(() => {
    if (!showSubstations && riskView) {
      setRiskView(false);
    }
    if (!showSubstations && showDrivers) {
      setShowDrivers(false);
    }
    riskViewRef.current = riskView;
  }, [showSubstations, riskView, showDrivers]);

  /**
   * Resize map when panel collapses/expands to ensure it fills the available space.
   * Preserves the geographic center and zoom to prevent the map from shifting.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    
    // Store current view state in geographic coordinates before resize
    const center = map.getCenter();
    const centerLngLat: [number, number] = [center.lng, center.lat];
    const zoom = map.getZoom();
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    
    // Handler to restore center after resize
    const restoreCenter = () => {
      map.jumpTo({
        center: centerLngLat,
        zoom: zoom,
        bearing: bearing,
        pitch: pitch,
      });
      // Remove the listener after restoring
      map.off('resize', restoreCenter);
    };
    
    // Listen for resize event to restore center after Mapbox finishes resizing
    map.once('resize', restoreCenter);
    
    // Use requestAnimationFrame to ensure DOM has updated, then resize
    const rafId = requestAnimationFrame(() => {
      map.resize();
    });

    return () => {
      cancelAnimationFrame(rafId);
      map.off('resize', restoreCenter);
    };
  }, [isPanelCollapsed]);

  // Keep mirror refs in sync with React state.
  useEffect(() => { showCountiesRef.current = showCounties; }, [showCounties]);
  useEffect(() => { showSubstationsRef.current = showSubstations; }, [showSubstations]);
  useEffect(() => { showDriversRef.current = showDrivers; }, [showDrivers]);
  useEffect(() => { showHazardsRef.current = showHazards; }, [showHazards]);
  useEffect(() => { selectedCountyNameRef.current = selectedCountyName; }, [selectedCountyName]);
  useEffect(() => { themeRef.current = theme; }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Berry uses the light basemap — only swap the Mapbox style when dark vs light actually changes.
    const styleUrl = theme === "dark"
      ? "mapbox://styles/mapbox/dark-v11"
      : "mapbox://styles/mapbox/light-v11";
    const currentStyle = map.getStyle()?.name ?? "";
    const needsStyleSwap = (theme === "dark") !== currentStyle.toLowerCase().includes("dark");
    if (needsStyleSwap) {
      map.setStyle(styleUrl);
      map.once("style.load", () => { setupLayersOnMap(map); setStyleVersion((v) => v + 1); });
    } else {
      // Same basemap (light ↔ berry) — just update paint properties directly.
      const safeSet = (id: string, prop: string, val: any) => {
        if (map.getLayer(id)) try { map.setPaintProperty(id, prop as any, val); } catch { /* ignore */ }
      };
      const isBerry = theme === "berry";
      safeSet("water", "fill-color", isBerry ? "#f9c4df" : "#cce8f5");
      safeSet("counties-fill", "fill-opacity", isBerry ? 0.35 : 0.55);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return; // Map not created yet.

    // Layer IDs we reference elsewhere.
    const subOuter = "substations-points";
    const subCore = "substations-core";
    const subGlow = "substations-glow";

    const countyFill = "counties-fill";
    const countyOutline = "counties-outline";

    // ---- Counties visibility ----
    // Only try to set visibility if those layers exist already.
    if (map.getLayer(countyFill) && map.getLayer(countyOutline)) {
      const vis = showCounties ? "visible" : "none";
      map.setLayoutProperty(countyFill, "visibility", vis);
      map.setLayoutProperty(countyOutline, "visibility", vis);
      if (map.getLayer("counties-fill-selected")) map.setLayoutProperty("counties-fill-selected", "visibility", vis);
      if (map.getLayer("counties-outline-selected")) map.setLayoutProperty("counties-outline-selected", "visibility", vis);
    }

    // ---- Substations visibility + styling ----
    // Only try to set visibility if those layers exist already.
    if (!map.getLayer(subOuter) || !map.getLayer(subGlow)) return;

    // Filters: stations with vs without a criticality value.
    const hasCrit  = [">",  ["coalesce", ["to-number", ["get", "criticality"]], 0], 0];
    const noCrit   = ["==", ["coalesce", ["to-number", ["get", "criticality"]], 0], 0];

    // Toggle substations on/off.
    const visibility = showSubstations ? "visible" : "none";
    map.setLayoutProperty(subOuter, "visibility", visibility);
    map.setLayoutProperty(subGlow, "visibility", visibility);
    if (map.getLayer(subCore)) {
      map.setLayoutProperty(subCore, "visibility", visibility);
    }
    if (map.getLayer("substations-glow-risk")) {
      map.setLayoutProperty("substations-glow-risk", "visibility", (showSubstations && riskView) ? "visible" : "none");
    }
    if (map.getLayer("drivers-points")) {
      map.setLayoutProperty("drivers-points", "visibility", (showSubstations && showDrivers) ? "visible" : "none");
    }
    if (map.getLayer("drivers-label")) {
      map.setLayoutProperty("drivers-label", "visibility", (showSubstations && showDrivers) ? "visible" : "none");
    }
    if (map.getLayer("hazard-zones-fill")) {
      map.setLayoutProperty("hazard-zones-fill", "visibility", showHazards ? "visible" : "none");
    }
    if (map.getLayer("hazard-zones-outline")) {
      map.setLayoutProperty("hazard-zones-outline", "visibility", showHazards ? "visible" : "none");
    }

    if (riskView) {
      // Outer: light criticality color + blur for ombre edge. Radius scales with criticality.
      map.setPaintProperty(subOuter, "circle-blur", SUBSTATION_DEFAULT.outerBlur);
      map.setPaintProperty(subOuter, "circle-radius", [
        "interpolate", ["linear"],
        ["coalesce", ["to-number", ["get", "criticality"]], 0],
        0, 7, 1, 7, 5, 14,
      ] as mapboxgl.ExpressionSpecification);
      map.setPaintProperty(subOuter, "circle-color", critExpr(CRIT_SCALE.outer, CRIT_SCALE.outer[0]));
      map.setPaintProperty(subOuter, "circle-opacity", SUBSTATION_DEFAULT.outerOpacity);

      // Core: dark criticality color, sharp center. Radius scales with criticality.
      if (map.getLayer(subCore)) {
        map.setPaintProperty(
          subCore,
          "circle-color",
          darkMode
            ? critExpr(CRIT_SCALE_DARK_CORE, CRIT_SCALE_DARK_CORE[0])
            : critExpr(CRIT_SCALE.core, CRIT_SCALE.core[0])
        );
        map.setPaintProperty(subCore, "circle-radius", [
          "interpolate", ["linear"],
          ["coalesce", ["to-number", ["get", "criticality"]], 0],
          0, 3, 1, 3, 5, 6,
        ] as mapboxgl.ExpressionSpecification);
        map.setPaintProperty(subCore, "circle-opacity", SUBSTATION_DEFAULT.coreOpacity);
      }

      // Static glow for no-criticality stations (green, no animation).
      map.setFilter(subGlow, noCrit as any);
      map.setPaintProperty(subGlow, "circle-color", CRIT_SCALE.outer[0]);
      map.setPaintProperty(subGlow, "circle-radius", SUBSTATION_DEFAULT.glowRadius);
      map.setPaintProperty(subGlow, "circle-opacity", SUBSTATION_DEFAULT.glowOpacity);
      map.setPaintProperty(subGlow, "circle-blur", SUBSTATION_DEFAULT.glowBlur);

      // Pulsing glow for stations with criticality — color matches dot.
      if (map.getLayer("substations-glow-risk")) {
        map.setFilter("substations-glow-risk", hasCrit as any);
        map.setPaintProperty("substations-glow-risk", "circle-color", critExpr(CRIT_SCALE.outer, CRIT_SCALE.outer[0]));
      }
    } else {
      // Default mode: restore purple ombre.
      map.setFilter(subGlow, null);
      map.setPaintProperty(subOuter, "circle-radius", SUBSTATION_DEFAULT.outerRadius);
      map.setPaintProperty(subOuter, "circle-color", SUBSTATION_DEFAULT.outerColor);
      map.setPaintProperty(subOuter, "circle-opacity", SUBSTATION_DEFAULT.outerOpacity);
      map.setPaintProperty(subOuter, "circle-blur", SUBSTATION_DEFAULT.outerBlur);

      if (map.getLayer(subCore)) {
        map.setPaintProperty(subCore, "circle-color", darkMode ? "#9D4EDD" : SUBSTATION_DEFAULT.coreColor);
        map.setPaintProperty(subCore, "circle-radius", SUBSTATION_DEFAULT.coreRadius);
        map.setPaintProperty(subCore, "circle-opacity", SUBSTATION_DEFAULT.coreOpacity);
      }

      map.setPaintProperty(subGlow, "circle-radius", SUBSTATION_DEFAULT.glowRadius);
      map.setPaintProperty(subGlow, "circle-color", SUBSTATION_DEFAULT.glowColor);
      map.setPaintProperty(subGlow, "circle-opacity", SUBSTATION_DEFAULT.glowOpacity);
      map.setPaintProperty(subGlow, "circle-blur", SUBSTATION_DEFAULT.glowBlur);
    }
  }, [showSubstations, riskView, showDrivers, showHazards, showCounties, darkMode, styleVersion]);

  /**
   * Adds all custom sources, layers, and starts the animation loop.
   * Called both on initial map load AND after every Mapbox style switch (dark/light).
   * Reads data from refs so it works correctly even when called asynchronously.
   */
  function applyDataFilters(map: mapboxgl.Map) {
    const subs = substationsDataRef.current;
    if (!subs) return;
    const critArr = [...critFilterRef.current];
    const drvArr = [...driverFilterRef.current];
    const hazardArr = [...hazardSeverityFilterRef.current];
    const filteredSubs = {
      ...subs,
      features: subs.features.filter((f: any) => critArr.includes(Number(f.properties?.criticality))),
    };
    const allDrivers = buildMockDriversGeoJSON(subs);
    const filteredDrivers = {
      ...allDrivers,
      features: allDrivers.features.filter(
        (f: any) => critArr.includes(Number(f.properties?.criticality)) && drvArr.includes(f.properties?.driver_code)
      ),
    };
    const hazards = hazardsDataRef.current;
    const filteredHazards = hazards
      ? {
          ...hazards,
          features: (hazards.features ?? []).filter((f: any) =>
            hazardArr.includes(String(f?.properties?.severity ?? "Moderate"))
          ),
        }
      : null;
    if (map.getSource("substations"))
      (map.getSource("substations") as mapboxgl.GeoJSONSource).setData(filteredSubs as any);
    if (map.getSource("criticality-drivers"))
      (map.getSource("criticality-drivers") as mapboxgl.GeoJSONSource).setData(filteredDrivers as any);
    if (filteredHazards && map.getSource("hazard-zones"))
      (map.getSource("hazard-zones") as mapboxgl.GeoJSONSource).setData(filteredHazards as any);
  }

  useEffect(() => {
    critFilterRef.current = critFilter;
    driverFilterRef.current = driverFilter;
    hazardSeverityFilterRef.current = hazardSeverityFilter;
    if (mapRef.current) applyDataFilters(mapRef.current);
  }, [critFilter, driverFilter, hazardSeverityFilter]);

  /**
   * Adds all custom sources, layers, and starts the animation loop.
   * Called both on initial map load AND after every Mapbox style switch (dark/light).
   * Reads data from refs so it works correctly even when called asynchronously.
   */
  function setupLayersOnMap(map: mapboxgl.Map) {
    const counties = countiesDataRef.current;
    const substations = substationsDataRef.current;
    const lines = linesDataRef.current;
    const hazards = hazardsDataRef.current;
    if (!counties || !substations || !lines || !hazards) return;

    const drivers = buildMockDriversGeoJSON(substations);

    // Stop any existing animation loop before starting a fresh one.
    (map as any)._stopPulse?.();

    // --- SOURCES (guard against double-add) ---
    if (!map.getSource("counties"))
      map.addSource("counties", { type: "geojson", data: counties, generateId: true });
    if (!map.getSource("transmission-lines"))
      map.addSource("transmission-lines", { type: "geojson", data: lines });
    if (!map.getSource("substations"))
      map.addSource("substations", { type: "geojson", data: substations });
    if (!map.getSource("criticality-drivers"))
      map.addSource("criticality-drivers", { type: "geojson", data: drivers as any });
    if (!map.getSource("hazard-zones"))
      map.addSource("hazard-zones", { type: "geojson", data: hazards });
    if (!map.getSource("annotations"))
      map.addSource("annotations", { type: "geojson", data: buildAnnotationsGeoJSON(annotationsRef.current) as any });

    // --- HAZARD ZONES (simulated atmospheric risk polygons) ---
    if (!map.getLayer("hazard-zones-fill"))
      map.addLayer({
        id: "hazard-zones-fill", type: "fill", source: "hazard-zones",
        paint: {
          "fill-color": [
            "match",
            ["coalesce", ["get", "severity"], "Moderate"],
            "Low", "#FDE68A",
            "Moderate", "#FB923C",
            "High", "#EF4444",
            "#FB923C",
          ],
          "fill-opacity": 0.22,
        },
      });
    if (!map.getLayer("hazard-zones-outline"))
      map.addLayer({
        id: "hazard-zones-outline", type: "line", source: "hazard-zones",
        paint: {
          "line-color": [
            "match",
            ["coalesce", ["get", "severity"], "Moderate"],
            "Low", "#F59E0B",
            "Moderate", "#EA580C",
            "High", "#B91C1C",
            "#EA580C",
          ],
          "line-width": 1.6,
          "line-opacity": 0.8,
        },
      });
    const hazardVis = showHazardsRef.current ? "visible" : "none";
    map.setLayoutProperty("hazard-zones-fill", "visibility", hazardVis);
    map.setLayoutProperty("hazard-zones-outline", "visibility", hazardVis);

    // --- COUNTIES ---
    if (!map.getLayer("counties-fill"))
      map.addLayer({
        id: "counties-fill", type: "fill", source: "counties",
        paint: { "fill-color": "#d4e4d0", "fill-opacity": 0.55 },
      });
    if (!map.getLayer("counties-outline"))
      map.addLayer({
        id: "counties-outline", type: "line", source: "counties",
        paint: { "line-color": "#7bc897", "line-width": 1.5, "line-opacity": 0.5 },
      });
    if (!map.getLayer("counties-fill-selected"))
      map.addLayer({
        id: "counties-fill-selected", type: "fill", source: "counties",
        filter: ["==", ["get", "county"], selectedCountyNameRef.current ?? ""],
        paint: { "fill-color": COUNTY_SELECTED_COLOR, "fill-opacity": 0.3 },
      });
    if (!map.getLayer("counties-outline-selected"))
      map.addLayer({
        id: "counties-outline-selected", type: "line", source: "counties",
        filter: ["==", ["get", "county"], selectedCountyNameRef.current ?? ""],
        paint: { "line-color": COUNTY_SELECTED_COLOR, "line-width": 2.5, "line-opacity": 1 },
      });
    const countyVis = showCountiesRef.current ? "visible" : "none";
    map.setLayoutProperty("counties-fill", "visibility", countyVis);
    map.setLayoutProperty("counties-outline", "visibility", countyVis);
    map.setLayoutProperty("counties-fill-selected", "visibility", countyVis);
    map.setLayoutProperty("counties-outline-selected", "visibility", countyVis);

    // --- TRANSMISSION LINES ---
    if (!map.getLayer("transmission-lines"))
      map.addLayer({
        id: "transmission-lines", type: "line", source: "transmission-lines",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#c26e4a", "line-width": 0.9, "line-opacity": 0.58 },
      });

    // --- SUBSTATIONS ---
    if (!map.getLayer("substations-glow"))
      map.addLayer({
        id: "substations-glow", type: "circle", source: "substations",
        paint: {
          "circle-radius": SUBSTATION_DEFAULT.glowRadius,
          "circle-color": SUBSTATION_DEFAULT.glowColor,
          "circle-blur": SUBSTATION_DEFAULT.glowBlur,
          "circle-opacity": SUBSTATION_DEFAULT.glowOpacity,
        },
      });
    if (!map.getLayer("substations-glow-risk"))
      map.addLayer({
        id: "substations-glow-risk", type: "circle", source: "substations",
        layout: { visibility: "none" },
        filter: [">", ["coalesce", ["to-number", ["get", "criticality"]], 0], 0] as any,
        paint: {
          "circle-radius": SUBSTATION_DEFAULT.glowRadius,
          "circle-color": CRIT_SCALE.outer[0],
          "circle-blur": SUBSTATION_DEFAULT.glowBlur,
          "circle-opacity": SUBSTATION_DEFAULT.glowOpacity,
        },
      });
    if (!map.getLayer("substations-points"))
      map.addLayer({
        id: "substations-points", type: "circle", source: "substations",
        paint: {
          "circle-radius": SUBSTATION_DEFAULT.outerRadius,
          "circle-color": SUBSTATION_DEFAULT.outerColor,
          "circle-opacity": SUBSTATION_DEFAULT.outerOpacity,
          "circle-blur": SUBSTATION_DEFAULT.outerBlur,
        },
      });
    if (!map.getLayer("substations-core"))
      map.addLayer({
        id: "substations-core", type: "circle", source: "substations",
        paint: {
          "circle-radius": SUBSTATION_DEFAULT.coreRadius,
          "circle-color": SUBSTATION_DEFAULT.coreColor,
          "circle-opacity": SUBSTATION_DEFAULT.coreOpacity,
        },
      });
    const subVis = showSubstationsRef.current ? "visible" : "none";
    map.setLayoutProperty("substations-points", "visibility", subVis);
    map.setLayoutProperty("substations-glow", "visibility", subVis);
    map.setLayoutProperty("substations-core", "visibility", subVis);

    // --- DRIVERS ---
    if (!map.getLayer("drivers-points"))
      map.addLayer({
        id: "drivers-points", type: "circle", source: "criticality-drivers",
        layout: { visibility: (showSubstationsRef.current && showDriversRef.current) ? "visible" : "none" },
        paint: {
          "circle-radius": 6,
          "circle-color": ["get", "driver_color"],
          "circle-opacity": 0.9,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      });
    if (!map.getLayer("drivers-label"))
      map.addLayer({
        id: "drivers-label", type: "symbol", source: "criticality-drivers",
        layout: {
          "text-field": ["get", "driver_code"],
          "text-size": 9,
          "text-font": ["DIN Offc Pro Bold", "Arial Unicode MS Regular"],
          visibility: (showSubstationsRef.current && showDriversRef.current) ? "visible" : "none",
        },
        paint: { "text-color": "#111827", "text-halo-color": "#ffffff", "text-halo-width": 1 },
      });

    // --- ANNOTATIONS TOOL ---
    if (!map.getLayer("annotations-points"))
      map.addLayer({
        id: "annotations-points", type: "circle", source: "annotations",
        paint: {
          "circle-radius": 6,
          "circle-color": "#ef4444",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
    if (!map.getLayer("annotations-label"))
      map.addLayer({
        id: "annotations-label", type: "symbol", source: "annotations",
        layout: {
          "text-field": ["get", "note"],
          "text-size": 10,
          "text-offset": [0, 1.1],
          "text-font": ["DIN Offc Pro Bold", "Arial Unicode MS Regular"],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#b91c1c",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1,
        },
      });

    // --- ANIMATION LOOP ---
    let stopped = false;
    const animate = () => {
      if (stopped) return;
      const pulse = (Math.sin((Date.now() / 1000) * Math.PI) + 1) / 2;
      if (!riskViewRef.current) {
        if (map.getLayer("substations-glow")) {
          map.setPaintProperty("substations-glow", "circle-radius", 10 + pulse * 18);
          map.setPaintProperty("substations-glow", "circle-opacity", 0.08 + pulse * 0.28);
        }
      } else {
        if (map.getLayer("substations-glow-risk")) {
          map.setPaintProperty("substations-glow-risk", "circle-radius", [
            "interpolate", ["linear"],
            ["coalesce", ["to-number", ["get", "criticality"]], 1],
            1, 10 + pulse * 8,
            5, 16 + pulse * 26,
          ] as mapboxgl.ExpressionSpecification);
          map.setPaintProperty("substations-glow-risk", "circle-opacity", [
            "interpolate", ["linear"],
            ["coalesce", ["to-number", ["get", "criticality"]], 1],
            1, 0.04 + pulse * 0.16,
            5, 0.08 + pulse * 0.36,
          ] as mapboxgl.ExpressionSpecification);
        }
      }
      requestAnimationFrame(animate);
    };
    animate();
    (map as any)._stopPulse = () => { stopped = true; };

    // Restore water to a clear blue regardless of the basemap style.
    const safeSetPaint = (layerId: string, prop: string, value: any) => {
      if (!map.getLayer(layerId)) return;
      try { map.setPaintProperty(layerId, prop as any, value); } catch { /* ignore */ }
    };
    const currentTheme = themeRef.current;
    const isDark = currentTheme === "dark";
    const isBerry = currentTheme === "berry";
    safeSetPaint("counties-fill", "fill-opacity", isDark ? 0.18 : isBerry ? 0.35 : 0.55);
    safeSetPaint("counties-fill-selected", "fill-opacity", isDark ? 0.12 : 0.3);
    safeSetPaint("hazard-zones-fill", "fill-opacity", isDark ? 0.18 : 0.22);
    safeSetPaint("water", "fill-color", isDark ? "#06141f" : isBerry ? "#f9c4df" : "#cce8f5");
    applyDataFilters(map);
  }

  /**
   * Map initialization effect:
   * 1) Read Mapbox token and create the map instance.
   * 2) On "load", fetch GeoJSON data and add sources/layers.
   * 3) Set up click/hover handlers to drive the Info Panel.
   * 4) Clean up the map on unmount (important to avoid memory leaks).
   */
  useEffect(() => {
    // Mapbox token comes from Vite env vars (VITE_* is exposed to the browser bundle).
    const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

    // NEW: show an in-app error message if the token is missing
    if (!token || token.trim().length === 0) {
      setMissingMapboxToken(true);
      console.error("Missing VITE_MAPBOX_TOKEN in .env.local");
      return;
    }

    // If we DO have a token, ensure the "missing token" message is not shown.
    setMissingMapboxToken(false);

    mapboxgl.accessToken = token;

    // If the container div doesn't exist yet, we can't create the map.
    if (!mapContainer.current) return;

    // Prevent double-initialization (React strict mode can run effects twice in dev).
    if (mapRef.current) return;

    // Create the actual map.
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-122.2, 37.7],
      zoom: 9,
      preserveDrawingBuffer: true,
    });

    // Adds zoom in/out controls.
    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    // The "load" event fires when the style has fully loaded.
    map.on("load", async () => {
      // Load all datasets in parallel.
      const [countiesRes, substationsRes, linesRes, hazardsRes] = await Promise.all([
        fetch("/data/counties.geojson"),
        fetch("/data/substations.geojson"),
        fetch("/data/transmission_lines.geojson"),
        fetch("/data/hazard_zones.geojson"),
      ]);

      // Fail early with helpful messages if any file is missing.
      if (!countiesRes.ok) throw new Error("Failed to load /data/counties.geojson");
      if (!substationsRes.ok) throw new Error("Failed to load /data/substations.geojson");
      if (!linesRes.ok) throw new Error("Failed to load /data/transmission_lines.geojson");
      if (!hazardsRes.ok) throw new Error("Failed to load /data/hazard_zones.geojson");

      // Parse JSON bodies.
      const counties = await countiesRes.json();
      const substations = await substationsRes.json();
      const lines = await linesRes.json();
      const hazards = await hazardsRes.json();

      // Store all data in refs so setupLayersOnMap can use them after a style switch.
      substationsDataRef.current = substations;
      countiesDataRef.current = counties;
      linesDataRef.current = lines;
      hazardsDataRef.current = hazards;

      /**
       * Fit map to the data bounds:
       * - We compute bounding boxes (minLng, minLat, maxLng, maxLat).
       * - Prefer counties for "big picture context".
       * - If counties are missing or empty, fallback to substations.
       */
      const countiesBbox = getGeoJSONBBox(counties);
      const substationsBbox = getGeoJSONBBox(substations);
      const bbox = countiesBbox ?? substationsBbox;
      if (bbox) {
        map.fitBounds(bbox, { padding: 60, duration: 600 });
      }

      // Add all custom sources, layers, and start the animation.
      setupLayersOnMap(map);

      map.on("click", "counties-fill", (e) => {
        const f = e.features?.[0];
        const props = (f?.properties as any) ?? {};
        const name = props.county ?? props.name ?? props.NAME ?? props.county_name ?? null;

        // Update the highlight layers to show only this county.
        const nameFilter = ["==", ["get", "county"], name ?? ""];
        map.setFilter("counties-fill-selected", nameFilter as any);
        map.setFilter("counties-outline-selected", nameFilter as any);

        // Spatial join: find substations inside this county polygon.
        const countyGeom = (f as any)?.geometry;
        const subs: Props[] = [];
        if (countyGeom && substationsDataRef.current) {
          for (const sub of substationsDataRef.current.features) {
            const [lng, lat] = sub.geometry.coordinates;
            if (pointInFeature([lng, lat], countyGeom)) {
              subs.push(sub.properties as Props);
            }
          }
          subs.sort((a, b) => (a?.criticality ?? 0) - (b?.criticality ?? 0));
        }

        setSelectedCountyName(name);
        setCountySubstations(subs);
        setCountyPopulation(name ? (COUNTY_POPULATION[name] ?? null) : null);
        setSelectedProps(null);
        setSelectedSubCountyName(null);
        setIsPanelCollapsed(false);
      });

      // Cursor UX + hover label for counties.
      map.on("mouseenter", "counties-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mousemove", "counties-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const subHits = map.queryRenderedFeatures(e.point, {
          layers: ["substations-core", "substations-points"],
        });
        if (subHits.length > 0) {
          hoveredCountyNameRef.current = null;
          setHoveredCountyName(null);
          setCountyHoverPos(null);
          return;
        }
        const name = (f?.properties as any)?.county ?? null;
        hoveredCountyNameRef.current = name;
        setHoveredCountyName(name);
        const rect = mapContainer.current!.getBoundingClientRect();
        setCountyHoverPos({ x: rect.left + e.point.x + 12, y: rect.top + e.point.y - 10 });
      });
      map.on("mouseleave", "counties-fill", () => {
        map.getCanvas().style.cursor = "";
        hoveredCountyNameRef.current = null;
        setHoveredCountyName(null);
        setCountyHoverPos(null);
      });

      map.on("mouseenter", "drivers-points", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "drivers-points", () => (map.getCanvas().style.cursor = ""));

      /**
       * Clicking a substation:
       * - Save its properties into state
       * - Clear selected county (mutually exclusive selection)
       */
      // Click on core (default mode, sits on top) or outer (risk view, core is hidden).
      const handleSubClick = (e: { features?: mapboxgl.GeoJSONFeature[] }) => {
        const f = e.features?.[0];
        const props = (f?.properties as any) ?? null;
        setSelectedProps(props);
        const coords = (f?.geometry as any)?.coordinates as [number, number] | undefined;
        setSelectedSubCountyName(coords ? countyNameForPoint(coords, countiesDataRef.current) : null);
        setSelectedCountyName(null);
        setIsPanelCollapsed(false);
      };
      map.on("click", "substations-core", handleSubClick);
      map.on("click", "substations-points", (e) => {
        if (!riskViewRef.current) return; // core handles it in default mode
        handleSubClick(e);
      });

      // Cursor UX + hover tooltip for substations.
      map.on("mouseenter", "substations-core", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mousemove", "substations-core", (e) => {
        const f = e.features?.[0];
        if (f) {
          setHoveredCountyName(null);
          setCountyHoverPos(null);
          setHoveredSubProps(f.properties as any);
          const rect = mapContainer.current!.getBoundingClientRect();
          setHoverPos({ x: rect.left + e.point.x + 14, y: rect.top + e.point.y - 14 });
        }
      });
      map.on("mouseleave", "substations-core", () => {
        map.getCanvas().style.cursor = "";
        setHoveredSubProps(null);
        setHoverPos(null);
      });
      map.on("mouseenter", "substations-points", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mousemove", "substations-points", (e) => {
        if (!riskViewRef.current) return;
        const f = e.features?.[0];
        if (f) {
          setHoveredCountyName(null);
          setCountyHoverPos(null);
          setHoveredSubProps(f.properties as any);
          const rect = mapContainer.current!.getBoundingClientRect();
          setHoverPos({ x: rect.left + e.point.x + 14, y: rect.top + e.point.y - 14 });
        }
      });
      map.on("mouseleave", "substations-points", () => {
        map.getCanvas().style.cursor = "";
        if (riskViewRef.current) {
          setHoveredSubProps(null);
          setHoverPos(null);
        }
      });

      map.on("click", "annotations-points", (e) => {
        const f = e.features?.[0];
        const id = String((f?.properties as any)?.id ?? "");
        if (!id) return;
        setAnnotations((prev) => prev.filter((a) => a.id !== id));
      });

      map.on("click", (e) => {
        if (!annotationModeRef.current) return;
        const layers = ["substations-core", "substations-points", "drivers-points", "annotations-points"]
          .filter((id) => !!map.getLayer(id));
        const hits = map.queryRenderedFeatures(e.point, { layers });
        if (hits.length > 0) return;

        const note = annotationDraftRef.current.trim() || "field note";
        const id = `a-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        setAnnotations((prev) => [...prev, { id, lng: e.lngLat.lng, lat: e.lngLat.lat, note }]);
      });


    });

    // Store map instance so other effects/handlers can access it.
    mapRef.current = map;

    /**
     * Cleanup:
     * - When the React component unmounts, remove the map from the DOM and free resources.
     * - Also clear mapRef so future mounts can re-init safely.
     */
    return () => {
      (map as any)._stopPulse?.();
      map.remove();
      mapRef.current = null;
    };

    // We intentionally run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCounties, showSubstations]);

  /**
   * If Mapbox token is missing, show an in-app message with setup instructions.
   */
  if (missingMapboxToken) {
    return (
      <div className="token-error-screen">
        <div className="token-error-card">
          <div className="token-error-title">Mapbox token required</div>
          <div className="token-error-body">
            this app needs a Mapbox access token to render the map. please add a token to{" "}
            <span>.env.local</span>{" "}
            and restart the dev server (or reload the Codespace).
          </div>
        </div>
      </div>
    );
  }

  /**
   * Render:
   * - A full-screen flex container
   * - Left side: the Mapbox map container
   * - Right side: an Info Panel with checkboxes + selected feature details
   *
   * The Info Panel is "normal React UI".
   * The map is "imperative Mapbox world".
   * The effects above keep them in sync.
   */
  return (
    <div className={`map-layout ${theme === "dark" ? "dark-mode" : theme === "berry" ? "berry-mode" : ""}`}>
      {/* Map container div: Mapbox draws into this element */}
      <div ref={mapContainer} className="map-container" />

      {/* Basemap theme toggle */}
      <div className="theme-toggle-wrap" role="group" aria-label="theme toggle">
        <button
          className={`theme-toggle-btn ${theme === "light" ? "active" : ""}`}
          onClick={() => setTheme("light")}
        >
          light
        </button>
        <button
          className={`theme-toggle-btn ${theme === "dark" ? "active" : ""}`}
          onClick={() => setTheme("dark")}
        >
          dark
        </button>
        <button
          className={`theme-toggle-btn berry-btn ${theme === "berry" ? "active" : ""}`}
          onClick={() => setTheme("berry")}
        >
          berry
        </button>
      </div>

      {/* Help button */}
      <button
        className="help-btn"
        onClick={() => setIsHelpOpen(true)}
        aria-label="open navigation help"
        title="how to navigate"
      >
        ?
      </button>

      <button
        className="snapshot-btn"
        onClick={handleOpenSnapshotHtml}
        aria-label="open snapshot html"
        title="open snapshot html"
      >
        snapshot html
      </button>

      {/* Floating expand button when collapsed */}
      {isPanelCollapsed && (
        <button
          className="panel-expand-btn"
          onClick={() => setIsPanelCollapsed(false)}
          aria-label="click to open info panel"
        >
          <span className="expand-top-row">
            <span className="expand-label">info</span>
            <BrainIcon size={20} className="brain-pulse-icon" />
          </span>
          <span className="expand-arrow">▶</span>
        </button>
      )}

      {/* Info panel */}
      {!isPanelCollapsed && (
        <div className="info-panel">
          <div className="panel-header">
            <div className="panel-title">info panel</div>
            <button
              className="panel-collapse-btn"
              onClick={() => setIsPanelCollapsed(true)}
              title="collapse info panel"
            >
              <BrainIcon size={16} className="brain-pulse-icon" />
              <span className="collapse-arrow">◀</span>
            </button>
          </div>

          <div className="panel-section">
            <div className="legend-header-row">
              <div className="panel-section-label">need to know</div>
              <button
                className="legend-collapse-btn"
                onClick={() => setIsNeedToKnowCollapsed((v) => !v)}
                title={isNeedToKnowCollapsed ? "expand need to know" : "collapse need to know"}
              >
                {isNeedToKnowCollapsed ? "▼" : "▲"}
              </button>
            </div>
            {!isNeedToKnowCollapsed && (
              <>
                <div className="need-row"><span>substations shown</span><strong>{shownSubstationsCount}</strong></div>
                <div className="need-row"><span>high criticality (4-5)</span><strong>{highCriticalCount}</strong></div>
                <div className="need-row"><span>active filters</span><strong>{hasActiveFilters ? "yes" : "no"}</strong></div>
                <div className="need-row"><span>field annotations</span><strong>{annotations.length}</strong></div>
              </>
            )}
          </div>

          <div className="panel-section">
            <div className="legend-header-row">
              <div className="panel-section-label">search</div>
              <button
                className="legend-collapse-btn"
                onClick={() => setIsSearchCollapsed((v) => !v)}
                title={isSearchCollapsed ? "expand search" : "collapse search"}
              >
                {isSearchCollapsed ? "▼" : "▲"}
              </button>
            </div>
            {!isSearchCollapsed && (
              <div className="search-row">
                <input
                  className="search-input"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSearchGo(); }}
                  placeholder="county or substation"
                />
                <button className="search-btn" onClick={handleSearchGo}>go</button>
              </div>
            )}
          </div>

          <div className="panel-section">
            <div className="legend-header-row">
              <div className="panel-section-label">annotation tool</div>
              <button
                className="legend-collapse-btn"
                onClick={() => setIsAnnotationCollapsed((v) => !v)}
                title={isAnnotationCollapsed ? "expand annotation tool" : "collapse annotation tool"}
              >
                {isAnnotationCollapsed ? "▼" : "▲"}
              </button>
            </div>
            {!isAnnotationCollapsed && (
              <>
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={annotationMode}
                    onChange={(e) => setAnnotationMode(e.target.checked)}
                  />
                  click map to drop notes
                </label>
                <div className="search-row">
                  <input
                    className="search-input"
                    value={annotationDraft}
                    onChange={(e) => setAnnotationDraft(e.target.value)}
                    placeholder="annotation label"
                  />
                  <button className="search-btn" onClick={() => setAnnotations([])}>clear</button>
                </div>
                <div className="layer-note">tip: click an annotation dot to remove one.</div>
              </>
            )}
          </div>

          {/* Layer toggles */}
          <div className="panel-section layers-section">
            <div className="panel-section-label">layers</div>

            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={showCounties}
                onChange={(e) => setShowCounties(e.target.checked)}
              />
              counties (polygons)
            </label>

            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={showSubstations}
                onChange={(e) => setShowSubstations(e.target.checked)}
              />
              substations
            </label>

            {/* Only show the "risk view" toggle if substations are visible */}
            {showSubstations && (
              <label className="layer-toggle">
                <input
                  type="checkbox"
                  checked={riskView}
                  onChange={(e) => setRiskView(e.target.checked)}
                />
                style substations by criticality
              </label>
            )}

            {showSubstations && (
              <label className="layer-toggle">
                <input
                  type="checkbox"
                  checked={showDrivers}
                  onChange={(e) => setShowDrivers(e.target.checked)}
                />
                style substations by criticality drivers (simulated)
              </label>
            )}

            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={showHazards}
                onChange={(e) => setShowHazards(e.target.checked)}
              />
              atmospheric hazard zones (simulated)
            </label>

            {noPrimaryLayersActive && (
              <div className="layer-empty-hint">no active county or substation layers selected.</div>
            )}

            <div className="data-source-note">
              note: hazard zones, criticality drivers, time-at-criticality, annotation notes, and county population values are simulated for this prototype.
            </div>
          </div>

          <div className="panel-section">
            <div className="legend-header-row">
              <div className="panel-section-label">legends</div>
              <button
                className="legend-collapse-btn"
                onClick={() => setIsLegendsCollapsed((v) => !v)}
                title={isLegendsCollapsed ? "expand legends" : "collapse legends"}
              >
                {isLegendsCollapsed ? "▼" : "▲"}
              </button>
            </div>

            {!isLegendsCollapsed && (
              <>
                {showHazards && (
                  <div className="driver-legend">
                    <div className="legend-header-row">
                      <div className="driver-legend-title">atmospheric hazard zones (simulated) legend</div>
                      <button
                        className="legend-collapse-btn"
                        onClick={() => setIsHazardLegendCollapsed((v) => !v)}
                        title={isHazardLegendCollapsed ? "expand legend" : "collapse legend"}
                      >
                        {isHazardLegendCollapsed ? "▼" : "▲"}
                      </button>
                    </div>
                    {!isHazardLegendCollapsed && (
                      <>
                        {HAZARD_SEVERITY_LEVELS.map((h) => (
                          <div key={h.label} className="driver-legend-row">
                            <span className="driver-legend-swatch" style={{ background: h.color, borderColor: h.borderColor }} />
                            <span className="driver-legend-label">{h.label.toLowerCase()}</span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}

                {showSubstations && showDrivers && (
                  <>
                    <div className="layer-note">driver layer uses mock data for this prototype.</div>
                    <div className="driver-legend">
                      <div className="legend-header-row">
                        <div className="driver-legend-title">driver color legend</div>
                        <button
                          className="legend-collapse-btn"
                          onClick={() => setIsDriverLegendCollapsed((v) => !v)}
                          title={isDriverLegendCollapsed ? "expand legend" : "collapse legend"}
                        >
                          {isDriverLegendCollapsed ? "▼" : "▲"}
                        </button>
                      </div>
                      {!isDriverLegendCollapsed && DRIVER_TYPES.map((driver) => (
                        <div key={driver.code} className="driver-legend-row">
                          <span className="driver-legend-swatch" style={{ background: driver.color }} />
                          <span className="driver-legend-label">{driver.label.toLowerCase()}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {showSubstations && riskView && (
                  <div className="risk-legend">
                    <div className="legend-header-row">
                      <div className="risk-legend-title">criticality legend</div>
                      <button
                        className="legend-collapse-btn"
                        onClick={() => setIsRiskLegendCollapsed((v) => !v)}
                        title={isRiskLegendCollapsed ? "expand legend" : "collapse legend"}
                      >
                        {isRiskLegendCollapsed ? "▼" : "▲"}
                      </button>
                    </div>
                    {!isRiskLegendCollapsed && [1, 2, 3, 4, 5].map((level) => (
                      <div key={level} className="risk-legend-row">
                        <span className="risk-legend-swatch">
                          <span
                            className="risk-legend-swatch-outer"
                            style={{
                              background: CRIT_SCALE.outer[level - 1],
                              boxShadow: darkMode ? `0 0 10px ${CRIT_SCALE.outer[level - 1]}` : undefined,
                            }}
                          />
                          <span
                            className="risk-legend-swatch-core"
                            style={{ background: darkMode ? CRIT_SCALE_DARK_CORE[level - 1] : CRIT_SCALE.core[level - 1] }}
                          />
                        </span>
                        <span className="risk-legend-label">{level} - {level <= 2 ? "lower" : level === 3 ? "moderate" : "higher"}</span>
                      </div>
                    ))}
                  </div>
                )}

                {!showHazards && !(showSubstations && showDrivers) && !(showSubstations && riskView) && (
                  <div className="layer-note">enable hazard, driver, or risk layers to see legends.</div>
                )}
              </>
            )}
          </div>

          {/* Filter section */}
          <div className="panel-section">
            <div className="legend-header-row">
              <div className="filter-header-left">
                <div className="panel-section-label">filters</div>
                {isFilterCollapsed && hasActiveFilters && (
                  <span className="filter-applied-warning">filters currently applied</span>
                )}
              </div>
              <button
                className="legend-collapse-btn"
                onClick={() => setIsFilterCollapsed((v) => !v)}
                title={isFilterCollapsed ? "expand filters" : "collapse filters"}
              >
                {isFilterCollapsed ? "▼" : "▲"}
              </button>
            </div>

            {!isFilterCollapsed && (
              <>
                {!showSubstations && (
                  <div className="layer-note">enable substations to apply filters.</div>
                )}

                <div className="filter-group">
                  <div className="filter-group-label">criticality</div>
                  <div className="filter-crit-row">
                    {([1, 2, 3, 4, 5] as number[]).map((level) => (
                      <button
                        key={level}
                        disabled={!showSubstations}
                        className={`crit-filter-btn ${critFilter.has(level) ? "active" : ""}`}
                        style={
                          critFilter.has(level)
                            ? { background: CRIT_SCALE.outer[level - 1], borderColor: CRIT_SCALE.outer[level - 1], color: "#fff" }
                            : {}
                        }
                        onClick={() =>
                          setCritFilter((prev) => {
                            const next = new Set(prev);
                            if (next.has(level)) { if (next.size > 1) next.delete(level); }
                            else next.add(level);
                            return next;
                          })
                        }
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="filter-group">
                  <div className="filter-group-label">driver</div>
                  {!showDrivers && (
                    <div className="layer-note">enable criticality drivers layer to use driver filters.</div>
                  )}
                  {DRIVER_TYPES.map((d) => (
                    <label key={d.code} className="driver-filter-row">
                      <input
                        type="checkbox"
                        disabled={!showSubstations || !showDrivers}
                        checked={driverFilter.has(d.code)}
                        onChange={() =>
                          setDriverFilter((prev) => {
                            const next = new Set(prev);
                            if (next.has(d.code)) { if (next.size > 1) next.delete(d.code); }
                            else next.add(d.code);
                            return next;
                          })
                        }
                      />
                      <span className="driver-filter-swatch" style={{ background: d.color }} />
                      <span>{d.label}</span>
                    </label>
                  ))}
                </div>

                <div className="filter-group">
                  <div className="filter-group-label">atmospheric hazard zones</div>
                  {!showHazards && (
                    <div className="layer-note">enable atmospheric hazard zones layer to use hazard filters.</div>
                  )}
                  {HAZARD_SEVERITY_LEVELS.map((h) => (
                    <label key={h.label} className="driver-filter-row">
                      <input
                        type="checkbox"
                        disabled={!showHazards}
                        checked={hazardSeverityFilter.has(h.label)}
                        onChange={() =>
                          setHazardSeverityFilter((prev) => {
                            const next = new Set(prev);
                            if (next.has(h.label)) { if (next.size > 1) next.delete(h.label); }
                            else next.add(h.label);
                            return next;
                          })
                        }
                      />
                      <span className="driver-filter-swatch" style={{ background: h.color, borderColor: h.borderColor }} />
                      <span>{h.label}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* County selection section */}
          <div className="panel-section">
            <div className="panel-section-label selected-heading">selected county</div>
            {!selectedCountyName ? (
              <div className="panel-empty-text">click a county to see its details.</div>
            ) : (
              <div className="county-card">
                <div className="county-card-header">
                  <div className="county-name">{selectedCountyName} county</div>
                  {countyPopulation && (
                    <div className="county-population">
                      pop. {countyPopulation.toLocaleString()}
                    </div>
                  )}
                </div>
                <div className="county-section-label">substations ({countySubstations.length})</div>
                {countySubstations.length === 0 ? (
                  <div className="panel-empty-text">no substations found in this county.</div>
                ) : (
                  <div className="county-substations-list">
                    {countySubstations.map((sub, i) => (
                      <div key={i} className="county-sub-row">
                        <span className="county-sub-name">{formatSubstationName(sub?.name)}</span>
                        <CriticalityBadge value={Number(sub?.criticality ?? 0)} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Substation selection section */}
          <div className="panel-section">
            <div className="panel-section-label selected-heading">selected substation</div>

            {!selectedProps ? (
              <div className="panel-empty-text">click a substation to see its details.</div>
            ) : (
              (() => {
                const driver = getMockDriverForProps(selectedProps);
                return (
              <div className="substation-card">
                {/* Card header: name + asset id + a badge */}
                <div className="substation-card-header">
                  <div className="substation-name-col">
                    <div className="substation-name">
                      {formatSubstationName(selectedProps.name)}
                    </div>
                    <div className="substation-asset-id">
                      asset id: {selectedProps.asset_id ?? "—"}
                    </div>
                  </div>

                  <CriticalityBadge value={Number(selectedProps.criticality ?? 0)} />
                </div>

                {/* Simple key/value rows */}
                <div className="substation-details-grid">
                  <DetailRow label="county" value={selectedSubCountyName ?? "—"} />
                  <DetailRow label="operator zone" value={selectedProps.operator_zone ?? "—"} />
                  <DetailRow label="asset type" value={selectedProps.asset_type ?? "—"} />
                  <DetailRow label="time at current criticality" value={getCriticalityDuration(selectedProps)} />
                  <DetailRow
                    label="primary driver"
                    value={<span className="driver-chip" style={{ background: driver.color }}>{driver.code}</span>}
                  />
                  <DetailRow label="driver detail" value={driver.label.toLowerCase()} />
                  <DetailRow label="driver severity" value={driver.severity.toLowerCase()} />
                </div>
              </div>
                );
              })()
            )}
          </div>
        </div>
      )}

      {/* Substation hover tooltip */}
      {hoveredSubProps && hoverPos && (
        <div className="sub-hover-tooltip" style={{ left: hoverPos.x, top: hoverPos.y }}>
          <div className="sub-hover-name">{formatSubstationName(hoveredSubProps.name)}</div>
          <CriticalityBadge value={Number(hoveredSubProps.criticality ?? 0)} />
        </div>
      )}

      {/* County hover label follows cursor unless a substation hover is active or the county is already selected (name shown in panel) */}
      {hoveredCountyName && countyHoverPos && !hoveredSubProps && hoveredCountyName !== selectedCountyName && (
        <div className="county-hover-tooltip" style={{ left: countyHoverPos.x, top: countyHoverPos.y }}>
          {hoveredCountyName}
        </div>
      )}

      {/* Navigation helper modal */}
      {isHelpOpen && (
        <div className="help-overlay" role="dialog" aria-modal="true" aria-label="navigation help">
          <div className="help-modal">
            <div className="help-header">
              <div className="help-title">how to navigate</div>
              <button
                className="help-close-btn"
                onClick={() => setIsHelpOpen(false)}
                aria-label="close help"
                title="close"
              >
                X
              </button>
            </div>
            <div className="help-body">
              <p>use the left info panel to control layers, tools, filters, and inspect selected features.</p>
              <ol>
                <li>start with <strong>need to know</strong> for quick counts: shown substations, high criticality, active filters, and field notes.</li>
                <li>turn counties/substations on or off in the layers section.</li>
                <li>toggle <strong>atmospheric hazard zones (simulated)</strong> in layers to view simulated atmospheric risk areas (low/moderate/high) that can indicate where weather conditions may elevate grid risk.</li>
                <li>enable risk view to color substations by criticality (1 to 5).</li>
                <li>enable criticality drivers to overlay simulated driver codes and colors.</li>
                <li>expand search to jump directly to a county or substation.</li>
                <li>expand annotation tool, enable note mode, then click map areas to drop field notes.</li>
                <li>expand filters to narrow visible substations by criticality and driver type.</li>
                <li>click a county to view county details and substations in that county.</li>
                <li>click a substation to view operator zone, criticality, and driver details.</li>
                <li>use <strong>snapshot html</strong> at the top to open a live report with filters, high-criticality list, selections, and notes. you can then choose to download the file.</li>
                <li>use light/dark buttons at the top-left to switch basemap theme.</li>
                <li>collapse the panel with the brain button; reopen it with the info tab.</li>
                <li><strong>simulation notice:</strong> atmospheric hazard zones, driver labels, time-at-criticality, annotation notes, county population values, and snapshot output are prototype simulation data.</li>
              </ol>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Small UI helper component:
 * Renders a label on the left and a value on the right.
 * Used in the substation details card.
 */
function DetailRow({ label, value }: { label: string; value: any }) {
  return (
    <div className="detail-row">
      <div className="detail-row-label">{label}</div>
      <div className="detail-row-value">{value}</div>
    </div>
  );
}

/**
 * Renders a pill badge that visually represents "criticality" on a 1–5 scale.
 * We clamp the value so weird data (0, 999, NaN) doesn't break the UI.
 */
function CriticalityBadge({ value }: { value: number }) {
  const v = Number.isFinite(value) ? Math.max(1, Math.min(5, value)) : 1;
  const idx = v - 1; // 0-based index into CRIT_SCALE arrays

  return (
    <div
      className="criticality-badge"
      style={{ background: CRIT_SCALE.badgeBg[idx], color: CRIT_SCALE.badgeFg[idx] }}
      title="criticality (1-5)"
    >
      criticality {v}
    </div>
  );
}

/**
 * Utility: Compute a bounding box for a GeoJSON FeatureCollection.
 *
 * Mapbox fitBounds expects bounds in the form:
 * [minLng, minLat, maxLng, maxLat]
 */
function getGeoJSONBBox(geojson: any): mapboxgl.LngLatBoundsLike | null {
  const coords: Array<[number, number]> = [];

  const pushCoord = (c: any) => {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
      coords.push([c[0], c[1]]);
    } else if (Array.isArray(c)) {
      for (const item of c) pushCoord(item);
    }
  };

  const features = geojson?.features ?? [];
  for (const f of features) {
    pushCoord(f?.geometry?.coordinates);
  }
  if (!coords.length) return null;

  let minX = coords[0][0],
    minY = coords[0][1],
    maxX = coords[0][0],
    maxY = coords[0][1];

  for (const [x, y] of coords) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return [minX, minY, maxX, maxY];
}
