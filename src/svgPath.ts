/** Vertices in the outline handed to native. Fixed, so the mask path can be interpolated. */
const SAMPLES = 128;

/**
 * Turns SVG path data into the unit polygon native draws the reveal with: a flat
 * `[x0, y0, x1, y1, …]`, centred on its centroid, furthest vertex at distance 1.
 *
 * Why a polygon and not the curves themselves — Core Animation can only
 * interpolate two paths with identical structure, so the outline is flattened
 * and resampled to a fixed vertex count. See `IrisShape` in the native code.
 *
 * Supports every path command (M L H V C S Q T A Z, absolute and relative).
 * Only the first subpath is used. Returns `null` when the data is malformed,
 * encloses no area, or does not contain its own centroid.
 */
export function svgPathToPolygon(d: string): number[] | null {
  const ring = flatten(d);
  if (!ring || ring.length < 6) return null;
  return normalize(resample(ring));
}

const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;

function flatten(d: string): number[] | null {
  const out: number[] = [];
  let i = 0;
  let x = 0;
  let y = 0;
  // Last control point, for the reflection in S and T.
  let ctrlX = 0;
  let ctrlY = 0;
  let cmd = '';
  let prev = '';

  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  const num = () => {
    skip();
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(d);
    if (!match) throw new Error('number expected');
    i = NUMBER.lastIndex;
    return Number(match[0]);
  };
  // Arc flags may be written without separators ("a1 1 0 011 1"), so they are
  // one character, not a number.
  const flag = () => {
    skip();
    const c = d[i++];
    if (c !== '0' && c !== '1') throw new Error('flag expected');
    return c === '1';
  };
  const line = (px: number, py: number) => {
    out.push(px, py);
    x = px;
    y = py;
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    const x0 = x;
    const y0 = y;
    for (let step = 1; step <= 16; step++) {
      const t = step / 16;
      const u = 1 - t;
      out.push(
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
      );
    }
    ctrlX = x2;
    ctrlY = y2;
    x = x3;
    y = y3;
  };
  const quad = (x1: number, y1: number, x2: number, y2: number) => {
    // A quadratic is a cubic with its control points two thirds along.
    cubic(x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2), x2, y2);
    ctrlX = x1;
    ctrlY = y1;
  };
  const arc = (rx: number, ry: number, deg: number, large: boolean, sweep: boolean, x2: number, y2: number) => {
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (x === x2 && y === y2) return;
    if (!rx || !ry) return line(x2, y2);

    // Endpoint to centre parameterisation, SVG spec F.6.5.
    const phi = (deg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (x - x2) / 2;
    const dy = (y - y2) / 2;
    const px = cos * dx + sin * dy;
    const py = -sin * dx + cos * dy;
    const scale = (px * px) / (rx * rx) + (py * py) / (ry * ry);
    if (scale > 1) {
      rx *= Math.sqrt(scale);
      ry *= Math.sqrt(scale);
    }
    const num2 = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px;
    const den = rx * rx * py * py + ry * ry * px * px;
    const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
    const cxp = (k * rx * py) / ry;
    const cyp = (-k * ry * px) / rx;
    const cx = cos * cxp - sin * cyp + (x + x2) / 2;
    const cy = sin * cxp + cos * cyp + (y + y2) / 2;
    const start = Math.atan2((py - cyp) / ry, (px - cxp) / rx);
    let delta = Math.atan2((-py - cyp) / ry, (-px - cxp) / rx) - start;
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    if (sweep && delta < 0) delta += 2 * Math.PI;

    for (let step = 1; step <= 32; step++) {
      const t = start + (delta * step) / 32;
      out.push(
        cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
        cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos
      );
    }
    x = x2;
    y = y2;
  };

  try {
    for (;;) {
      skip();
      if (i >= d.length) break;
      if (/[a-zA-Z]/.test(d[i]!)) cmd = d[i++]!;
      else if (!cmd || cmd === 'z' || cmd === 'Z') return null;

      const rel = cmd === cmd.toLowerCase();
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      const letter = cmd.toUpperCase();

      // The first subpath only: a second move, or a close, ends the outline.
      if ((letter === 'M' && out.length) || letter === 'Z') break;

      switch (letter) {
        case 'M': {
          line(num() + ox, num() + oy);
          // Further pairs after a move are implicit lines.
          cmd = rel ? 'l' : 'L';
          break;
        }
        case 'L':
          line(num() + ox, num() + oy);
          break;
        case 'H':
          line(num() + ox, y);
          break;
        case 'V':
          line(x, num() + oy);
          break;
        case 'C':
          cubic(num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy);
          break;
        case 'S': {
          const smooth = prev === 'C' || prev === 'S';
          cubic(smooth ? 2 * x - ctrlX : x, smooth ? 2 * y - ctrlY : y, num() + ox, num() + oy, num() + ox, num() + oy);
          break;
        }
        case 'Q':
          quad(num() + ox, num() + oy, num() + ox, num() + oy);
          break;
        case 'T': {
          const smooth = prev === 'Q' || prev === 'T';
          quad(smooth ? 2 * x - ctrlX : x, smooth ? 2 * y - ctrlY : y, num() + ox, num() + oy);
          break;
        }
        case 'A':
          arc(num(), num(), num(), flag(), flag(), num() + ox, num() + oy);
          break;
        default:
          return null;
      }
      prev = letter;
    }
  } catch {
    return null;
  }

  return out;
}

/** `SAMPLES` points evenly spaced by arc length along the closed ring. */
function resample(ring: number[]): number[] {
  const count = ring.length / 2;
  const lengths: number[] = [0];
  for (let k = 0; k < count; k++) {
    const next = (k + 1) % count;
    lengths.push(lengths[k]! + Math.hypot(ring[next * 2]! - ring[k * 2]!, ring[next * 2 + 1]! - ring[k * 2 + 1]!));
  }
  const total = lengths[count]!;
  const out: number[] = [];
  let seg = 0;
  for (let n = 0; n < SAMPLES; n++) {
    const target = (total * n) / SAMPLES;
    while (seg < count - 1 && lengths[seg + 1]! < target) seg++;
    const span = lengths[seg + 1]! - lengths[seg]!;
    const f = span > 0 ? (target - lengths[seg]!) / span : 0;
    const next = (seg + 1) % count;
    out.push(
      ring[seg * 2]! + f * (ring[next * 2]! - ring[seg * 2]!),
      ring[seg * 2 + 1]! + f * (ring[next * 2 + 1]! - ring[seg * 2 + 1]!)
    );
  }
  return out;
}

/** Centre on the area centroid and scale the furthest vertex to 1. */
function normalize(points: number[]): number[] | null {
  const count = points.length / 2;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < count; k++) {
    const next = (k + 1) % count;
    const cross = points[k * 2]! * points[next * 2 + 1]! - points[next * 2]! * points[k * 2 + 1]!;
    area += cross;
    cx += (points[k * 2]! + points[next * 2]!) * cross;
    cy += (points[k * 2 + 1]! + points[next * 2 + 1]!) * cross;
  }
  if (Math.abs(area) < 1e-9) return null;
  cx /= 3 * area;
  cy /= 3 * area;

  // Native scales the outline until its nearest edge clears the screen, measured
  // from the centroid. A centroid OUTSIDE the outline (a "C", a crescent) never
  // covers the screen that way: the reveal would start with a hole in it and end
  // with old-theme pieces popping off. Reject it so the caller gets the default.
  if (!contains(points, cx, cy)) return null;

  let radius = 0;
  for (let k = 0; k < count; k++) radius = Math.max(radius, Math.hypot(points[k * 2]! - cx, points[k * 2 + 1]! - cy));
  if (!(radius > 0)) return null;

  return points.map((value, index) => (value - (index % 2 ? cy : cx)) / radius);
}

/** Even-odd ray cast: whether (px, py) lies inside the closed ring. */
function contains(points: number[], px: number, py: number): boolean {
  const count = points.length / 2;
  let inside = false;
  for (let k = 0, j = count - 1; k < count; j = k++) {
    const xk = points[k * 2]!;
    const yk = points[k * 2 + 1]!;
    const xj = points[j * 2]!;
    const yj = points[j * 2 + 1]!;
    if (yk > py !== yj > py && px < ((xj - xk) * (py - yk)) / (yj - yk) + xk) inside = !inside;
  }
  return inside;
}
