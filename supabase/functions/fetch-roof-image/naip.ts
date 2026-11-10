// gh-1413 / D-317 cl. 6: pure helpers for the NAIP roof-image crop. No network, no Deno APIs, so they unit-test cleanly.
// Source: USGS National Map USGSNAIPImagery ImageServer (USDA FSA NAIP imagery). No API key, no vendor.
export const NAIP_EXPORT_URL =
  "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage";
export const CENSUS_GEOCODE_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
export const ATTRIBUTION = "Imagery: USDA/USGS NAIP";
export const IMAGE_WIDTH_PX = 800;
export const IMAGE_HEIGHT_PX = 600;
// Ground footprint of the crop in metres (4:3). 150 m x 112.5 m frames a residential lot and its neighbours.
export const GROUND_WIDTH_M = 150;
const EARTH_RADIUS_M = 6378137;

export function lonLatToWebMercator(lon: number, lat: number): { x: number; y: number } {
  const x = (EARTH_RADIUS_M * lon * Math.PI) / 180;
  const y = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return { x, y };
}

/** Fixed-size bbox in EPSG:3857 around a point. Web Mercator stretches distances by 1/cos(lat), so the half-width is scaled to keep the ground footprint constant. */
export function buildBbox(lon: number, lat: number): [number, number, number, number] {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    throw new Error("invalid coordinates");
  }
  const { x, y } = lonLatToWebMercator(lon, lat);
  const k = 1 / Math.cos((lat * Math.PI) / 180);
  const halfW = (GROUND_WIDTH_M / 2) * k;
  const halfH = (GROUND_WIDTH_M * (IMAGE_HEIGHT_PX / IMAGE_WIDTH_PX) / 2) * k;
  return [x - halfW, y - halfH, x + halfW, y + halfH];
}

export function buildNaipUrl(lon: number, lat: number): string {
  const bbox = buildBbox(lon, lat).map((n) => n.toFixed(2)).join(",");
  const p = new URLSearchParams({
    bbox,
    bboxSR: "3857",
    imageSR: "3857",
    size: `${IMAGE_WIDTH_PX},${IMAGE_HEIGHT_PX}`,
    format: "jpg",
    f: "image",
  });
  return `${NAIP_EXPORT_URL}?${p.toString()}`;
}

export function buildGeocodeUrl(address: string): string {
  const p = new URLSearchParams({ address, benchmark: "Public_AR_Current", format: "json" });
  return `${CENSUS_GEOCODE_URL}?${p.toString()}`;
}

/** Returns {lon, lat} from a Census onelineaddress response, or null when there is no match. */
export function parseGeocode(json: unknown): { lon: number; lat: number } | null {
  // deno-lint-ignore no-explicit-any
  const m = (json as any)?.result?.addressMatches;
  if (!Array.isArray(m) || m.length === 0) return null;
  const { x, y } = m[0]?.coordinates ?? {};
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { lon: x, lat: y };
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 2000 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function buildAddress(c: { property_address?: string | null; property_city?: string | null; property_state?: string | null; property_zip?: string | null }): string {
  return [c.property_address, c.property_city, [c.property_state, c.property_zip].filter(Boolean).join(" ")]
    .map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
}
