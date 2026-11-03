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

// Curves, smooth curves and implicit repeats parse; garbage does not.
assert.ok(svgPathToPolygon('M0 0C0 10 10 10 10 0S20-10 20 0Q10 5 0 0'));
assert.equal(svgPathToPolygon('hello'), null);
assert.equal(svgPathToPolygon('M0 0L10 0'), null); // no area
console.log('svgPath ok');
