/**
 * Per-channel values drawn at their electrode positions.
 *
 * Canvas 2D rather than WebGL, deliberately: a channel map is one mark per
 * channel and the channel ceiling is in the hundreds, so the whole scene is a
 * few hundred filled circles per frame. That is nothing for the 2D context, and
 * it buys text — labels and a colour bar — for free, which is the part of this
 * view that actually needs doing well.
 */

export type ScatterConfig = {
  positions: Array<[number, number]>;
  labels: string[] | null;
  darkMode: boolean;
};

export type ScatterView = {
  /** Half-range around zero the colour scale spans; 0 means autoscale. */
  manualHalfRange: number;
  showLabels: boolean;
};

/**
 * Diverging blue-white-red, so sign is readable at a glance.
 *
 * Sequential would be wrong here: these values are signed deviations and a
 * sequential ramp hides the zero crossing, which is usually the thing being
 * looked for.
 */
function divergingColor(normalized: number): string {
  const clamped = Math.max(-1, Math.min(1, normalized));
  if (clamped >= 0) {
    const mix = clamped;
    const red = 255;
    const green = Math.round(255 - 150 * mix);
    const blue = Math.round(255 - 190 * mix);
    return `rgb(${red}, ${green}, ${blue})`;
  }
  const mix = -clamped;
  const red = Math.round(255 - 190 * mix);
  const green = Math.round(255 - 130 * mix);
  const blue = 255;
  return `rgb(${red}, ${green}, ${blue})`;
}

export class ScatterRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private config: ScatterConfig = { positions: [], labels: null, darkMode: false };
  private view: ScatterView = { manualHalfRange: 0, showLabels: true };
  private values: Float32Array = new Float32Array(0);
  private autoHalfRange = 1;

  private cssWidth = 1;
  private cssHeight = 1;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D is not available in this browser");
    }
    this.canvas = canvas;
    this.context = context;
  }

  configure(config: ScatterConfig): void {
    this.config = config;
    this.values = new Float32Array(config.positions.length);
    this.autoHalfRange = 1;
  }

  setView(view: Partial<ScatterView>): void {
    this.view = { ...this.view, ...view };
  }

  /** Take the latest per-channel frame; `payload` is `(1, n_channels)`. */
  push(payload: Float32Array, nChannels: number): void {
    const count = Math.min(nChannels, this.values.length);
    for (let index = 0; index < count; index += 1) {
      this.values[index] = payload[index];
    }

    let extreme = 0;
    for (let index = 0; index < count; index += 1) {
      const magnitude = Math.abs(this.values[index]);
      if (magnitude > extreme) {
        extreme = magnitude;
      }
    }
    if (Number.isFinite(extreme) && extreme > 0) {
      // Same asymmetry as the trace renderer: jump up, ease down, so a quiet
      // moment does not repaint the whole map at full saturation.
      const smoothing = extreme > this.autoHalfRange ? 1.0 : 0.05;
      this.autoHalfRange += (extreme - this.autoHalfRange) * smoothing;
    }
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    const width = Math.max(1, Math.round(cssWidth * devicePixelRatio));
    const height = Math.max(1, Math.round(cssHeight * devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  getRange(): number {
    return this.view.manualHalfRange > 0 ? this.view.manualHalfRange : this.autoHalfRange;
  }

  render(): void {
    const context = this.context;
    const { positions, labels, darkMode } = this.config;
    const width = this.cssWidth;
    const height = this.cssHeight;

    context.fillStyle = darkMode ? "#17191d" : "#ffffff";
    context.fillRect(0, 0, width, height);
    if (positions.length === 0) {
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of positions) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);

    // One shared scale for both axes, so the electrode layout keeps its real
    // aspect ratio -- a grid array must not be drawn as a rectangle.
    const margin = 28;
    const scale = Math.min((width - 2 * margin) / spanX, (height - 2 * margin) / spanY);
    const drawnWidth = spanX * scale;
    const drawnHeight = spanY * scale;
    const originX = (width - drawnWidth) / 2;
    const originY = (height - drawnHeight) / 2;

    // Radius from nearest-neighbour spacing so a dense array does not overlap
    // and a sparse one does not vanish.
    const spacing = Math.min(
      drawnWidth / Math.max(1, Math.sqrt(positions.length) - 1),
      drawnHeight / Math.max(1, Math.sqrt(positions.length) - 1)
    );
    const radius = Math.max(3, Math.min(26, spacing * 0.42));

    const halfRange = Math.max(1e-12, this.getRange());
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `${Math.max(8, Math.min(12, radius * 0.8))}px ui-monospace, monospace`;

    for (let index = 0; index < positions.length; index += 1) {
      const [x, y] = positions[index];
      const centerX = originX + (x - minX) * scale;
      // Canvas y grows downward; electrode y grows upward.
      const centerY = originY + drawnHeight - (y - minY) * scale;
      const value = this.values[index] ?? 0;

      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.fillStyle = divergingColor(value / halfRange);
      context.fill();
      context.lineWidth = 1;
      context.strokeStyle = darkMode ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)";
      context.stroke();

      if (this.view.showLabels && labels && radius >= 9) {
        context.fillStyle = "#1c1c1c";
        context.fillText(labels[index] ?? String(index), centerX, centerY);
      }
    }
  }
}
