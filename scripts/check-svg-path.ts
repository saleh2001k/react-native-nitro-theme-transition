// Run with `bun scripts/check-svg-path.ts`.
import assert from 'node:assert';
import { svgPathToPolygon } from '../src/svgPath';

const radii = (p: number[]) => p.filter((_, i) => i % 2 === 0).map((x, k) => Math.hypot(x, p[k * 2 + 1]!));

// A square: 128 vertices, centred, furthest vertex at exactly 1 (a corner).
const square = svgPathToPolygon('M0 0H10V10H0Z')!;
assert.equal(square.length, 256);
assert.ok(Math.abs(Math.max(...radii(square)) - 1) < 1e-9);
assert.ok(Math.abs(square.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b) / 128) < 1e-6);

// Arcs (with compact flags) and relative commands: a circle comes out round.
const circle = svgPathToPolygon('M0 5a5 5 0 1010 0a5 5 0 10-10 0')!;
assert.ok(Math.min(...radii(circle)) > 0.99);

// Curves, smooth curves, compact negatives and implicit repeats parse; garbage does not.
assert.ok(svgPathToPolygon('M0 0C0-10 20-10 20 0Q20 10 10 10T0 0'));
assert.ok(svgPathToPolygon('M0 5c0-10 10-10 10 0s-10 10-10 0'));
assert.ok(svgPathToPolygon('M0 0L10 0 10 10 0 10z'));
assert.equal(svgPathToPolygon('hello'), null);
assert.equal(svgPathToPolygon('M0 0L10 0'), null); // no area

// The centroid has to sit inside the outline, or native cannot cover the screen.
assert.equal(svgPathToPolygon('M0 0H10V2H2V8H10V10H0Z'), null); // a "C"

// The example app's shapes all qualify.
for (const d of [
  'M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z', // star
  'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z', // heart
  'M13 2L4 14h6l-1 8 9-12h-6z', // bolt
]) {
  assert.ok(svgPathToPolygon(d), d);
}
console.log('svgPath ok');
