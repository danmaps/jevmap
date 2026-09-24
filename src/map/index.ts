import type { Map as MapLibreMap, PaddingOptions } from "maplibre-gl";
import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
import type { BBox } from "../state/index.js";

export interface MapViewportState {
  bbox: BBox;
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface MapAdapter {
  getViewport(): MapViewportState;
  fitBounds(bounds: BBox): void;
  addGeoJSONLayer(
    id: string,
    data: FeatureCollection<Geometry, GeoJsonProperties>,
    color: string,
  ): void;
  removeGeoJSONLayer(id: string): void;
}

export class MapLibreAdapter implements MapAdapter {
  public constructor(
    private readonly map: MapLibreMap,
    private readonly getFitPadding: () => number | PaddingOptions = () => 40,
  ) {}

  public getViewport(): MapViewportState {
    const bounds = this.map.getBounds();

    return {
      bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
    };
  }

  public fitBounds(bounds: BBox): void {
    this.map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: this.getFitPadding() },
    );
  }

  public addGeoJSONLayer(
    id: string,
    data: FeatureCollection<Geometry, GeoJsonProperties>,
    color: string,
  ): void {
    const sourceId = `jevmap-${id}`;
    const existing = this.map.getSource(sourceId);
    if (existing) {
      if ("setData" in existing && typeof existing.setData === "function") existing.setData(data);
      return;
    }

    this.map.addSource(sourceId, { type: "geojson", data });
    this.map.addLayer({
      id: `${sourceId}-fill`,
      type: "fill",
      source: sourceId,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": color, "fill-opacity": 0.18, "fill-outline-color": color },
    });
    this.map.addLayer({
      id: `${sourceId}-line`,
      type: "line",
      source: sourceId,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": color, "line-width": 3, "line-opacity": 0.9 },
    });
    this.map.addLayer({
      id: `${sourceId}-point`,
      type: "circle",
      source: sourceId,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": color,
        "circle-radius": 6,
        "circle-stroke-color": "#fff4df",
        "circle-stroke-width": 1.5,
      },
    });
  }

  public removeGeoJSONLayer(id: string): void {
    const sourceId = `jevmap-${id}`;
    for (const suffix of ["fill", "line", "point"]) {
      const layerId = `${sourceId}-${suffix}`;
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    }
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }
}
