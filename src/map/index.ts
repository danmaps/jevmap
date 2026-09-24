import type { Map as MapLibreMap } from "maplibre-gl";
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
}

export class MapLibreAdapter implements MapAdapter {
  public constructor(private readonly map: MapLibreMap) {}

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
      { padding: 40 },
    );
  }
}
