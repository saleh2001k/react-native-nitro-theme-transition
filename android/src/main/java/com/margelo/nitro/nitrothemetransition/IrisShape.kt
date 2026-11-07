package com.margelo.nitro.nitrothemetransition

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The outlines `iris` collapses the old screen into. The counterpart of
 * `IrisShape` in `ios/HybridThemeTransition.swift` — keep the two in step, or
 * the platforms stop matching.
 *
 * ── Why they are all polygons ──
 * `circularReveal` animates a path from a big circle to a tiny one, and on iOS
 * Core Animation interpolates that point by point. Anything `iris` draws has to
 * survive the same treatment, which rules out arcs and rounded-rect helpers: the
 * number of segments those emit depends on the radius, so the two endpoints
 * would not match and the interpolation would produce garbage.
 *
 * So every shape here is a fixed-vertex polygon on the unit circle, scaled by
 * the radius. Android redraws the path per frame and would not care either way,
 * but the two platforms share the definition so they share the look.
 *
 * Points are stored flat — `[x0, y0, x1, y1, …]` — to keep the per-frame path
 * build allocation-free.
 */
internal object IrisShape {

  fun polygon(shape: ThemeTransitionShape): FloatArray =
    when (shape) {
      // Enough segments to read as a circle, few enough to stay cheap.
      ThemeTransitionShape.CIRCLE -> regular(48, 0.0)
      ThemeTransitionShape.DIAMOND -> regular(4, -PI / 2)
      ThemeTransitionShape.HEXAGON -> regular(6, -PI / 2)
      ThemeTransitionShape.ROUNDEDRECT -> squircle(32)
    }

  private fun regular(sides: Int, rotation: Double): FloatArray {
    val out = FloatArray(sides * 2)
    for (index in 0 until sides) {
      val angle = rotation + 2 * PI * index / sides
      out[index * 2] = cos(angle).toFloat()
      out[index * 2 + 1] = sin(angle).toFloat()
    }
    return out
  }

  /** A superellipse — the rounded square people mean by "rounded rect". */
  private fun squircle(samples: Int): FloatArray {
    val out = FloatArray(samples * 2)
    for (index in 0 until samples) {
      val angle = 2 * PI * index / samples
      val c = cos(angle)
      val s = sin(angle)
      // |cos|^0.5 with the sign put back: exponent 2/n for n = 4.
      out[index * 2] = ((if (c < 0) -1.0 else 1.0) * sqrt(abs(c))).toFloat()
      out[index * 2 + 1] = ((if (s < 0) -1.0 else 1.0) * sqrt(abs(s))).toFloat()
    }
    return out
  }

  /**
   * The largest disc that fits inside the unit outline.
   *
   * The reveal has to start with the old screen fully covered, and a polygon's
   * edges are closer to the centre than its vertices are — scaling it to the
   * distance of the furthest corner would leave the corners poking out.
   * Dividing the required radius by this puts the EDGES at that distance.
   */
  fun inradius(polygon: FloatArray): Float {
    if (polygon.size < 6) return 1f

    var smallest = Float.MAX_VALUE
    val points = polygon.size / 2

    for (index in 0 until points) {
      val ax = polygon[index * 2]
      val ay = polygon[index * 2 + 1]
      val next = (index + 1) % points
      val dx = polygon[next * 2] - ax
      val dy = polygon[next * 2 + 1] - ay
      val lengthSquared = dx * dx + dy * dy
      if (lengthSquared <= 0f) continue
      // Distance from the origin to the SEGMENT a-b, not the infinite line: a
      // custom outline can be concave, where the line would under-measure.
      val t = (-(ax * dx + ay * dy) / lengthSquared).coerceIn(0f, 1f)
      smallest = minOf(smallest, hypot(ax + t * dx, ay + t * dy))
    }

    return if (smallest.isFinite() && smallest > 0f) smallest else 1f
  }
}
