import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { clip, LAYERS, onTexels, SUN } from '../src/inspect/app/scene.ts'

// Boardville's sun follows the camera. Its shadow map must move in whole texels, or every shadow's edge is
// drawn a little differently each frame the camera moves, and the shadows shimmer.

const TEXEL = 4400 / 2048
const along = SUN.clone().negate().normalize()
const right = new Vector3().crossVectors(along, new Vector3(0, 1, 0)).normalize()
const up = new Vector3().crossVectors(right, along).normalize()
const offTexel = (value: number) => Math.abs(value / TEXEL - Math.round(value / TEXEL))

describe('the sun over boardville', () => {
  it('stands on whole texels of its shadow map wherever the camera looks, within a texel of it', () => {
    // A camera panning by less than a texel a frame, as a slow drag does.
    for (let i = 0; i < 400; i++) {
      const at = new Vector3(123.4 + i * 0.37, 0, -56.7 + i * 0.29)
      const sun = onTexels(at, SUN, TEXEL)
      expect(offTexel(sun.dot(right))).toBeLessThan(1e-6)
      expect(offTexel(sun.dot(up))).toBeLessThan(1e-6)
      expect(sun.distanceTo(at)).toBeLessThan(TEXEL)
    }
  })

  it('keeps its shadow map still while the camera moves less than a texel, so no shadow moves', () => {
    // Only where the map stands across and up, as the sun sees the ground, moves a shadow: along the sun's own
    // direction, the map sees the same thing.
    const at = new Vector3(500, 0, 500)
    const where = (v: Vector3) => `${v.dot(right).toFixed(6)},${v.dot(up).toFixed(6)}`
    const first = where(onTexels(at, SUN, TEXEL))
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) seen.add(where(onTexels(at.clone().add(new Vector3(i * 0.02, 0, 0)), SUN, TEXEL)))
    // Twenty steps of 0.02 cross at most one texel's edge across and one up: three places at most. A sun that
    // followed the camera exactly would stand in twenty.
    expect(seen.size).toBeLessThanOrEqual(3)
    expect(seen).toContain(first)
    const unsnapped = new Set(Array.from({ length: 20 }, (_, i) => where(at.clone().add(new Vector3(i * 0.02, 0, 0)))))
    expect(unsnapped.size).toBe(20)
  })
})

describe('the ground of boardville', () => {
  // A 24-bit depth buffer tells two surfaces apart only as far apart as one step of it, which grows with the
  // square of their distance from the camera and shrinks with its near plane. Closer than that, they fight,
  // and the ground flickers as the camera moves.
  const step = (near: number, far: number, z: number) => ((far - near) * z * z) / (far * near * 2 ** 24)
  const gaps = [LAYERS.road - LAYERS.grass, LAYERS.slab - LAYERS.road, LAYERS.floor - LAYERS.slab]

  it('keeps its layers further apart than the depth buffer can blur, at every zoom and as far as the fog', () => {
    for (let distance = 320; distance <= 60_000; distance *= 1.25) {
      const { near, far } = clip(distance)
      // The camera sees the ground from nearer than it looks, out to where the fog hides it, at 3 times as far.
      for (const z of [distance * 0.5, distance, distance * 3]) expect(step(near, far, z)).toBeLessThan(Math.min(...gaps) / 4)
    }
  })

  it('would have flickered with a near plane fixed close by', () => {
    // The near plane this had before, at the distance a big city is seen from: the layers were 1 unit apart.
    expect(step(10, 30_000, 10_000)).toBeGreaterThan(0.5)
  })
})
