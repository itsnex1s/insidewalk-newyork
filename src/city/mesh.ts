import * as THREE from 'three/webgpu'

/**
 * Geometry built vertex by vertex: the walls, roofs, cornices and fire escapes of a thousand buildings, each kind one
 * merged mesh, so the district is a few dozen draws however many buildings it has. Every vertex carries the
 * attributes named when the builder is made, set before each face from `set`.
 */
export class Builder {
  private position: number[] = []
  private normal: number[] = []
  private data: Record<string, number[]> = {}
  /** The values of the extra attributes the next faces take. */
  readonly set: Record<string, number[]> = {}

  constructor(private sizes: Record<string, number> = {}) {
    for (const name of Object.keys(sizes)) {
      this.data[name] = []
      this.set[name] = new Array(sizes[name]).fill(0)
    }
  }

  get empty() {
    return this.position.length === 0
  }

  /** One vertex: three make a triangle, counter-clockwise from the side its normal faces. */
  vertex(p: THREE.Vector3Like, n: THREE.Vector3Like) {
    this.position.push(p.x, p.y, p.z)
    this.normal.push(n.x, n.y, n.z)
    for (const name in this.data) this.data[name].push(...this.set[name])
  }

  /** A triangle, its corners counter-clockwise seen from the side `n` faces. */
  triangle(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, n: THREE.Vector3Like) {
    this.vertex(a, n)
    this.vertex(b, n)
    this.vertex(c, n)
  }

  /** A quad a b c d counter-clockwise seen from the side `n` faces. */
  quad(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, d: THREE.Vector3Like, n: THREE.Vector3Like) {
    this.triangle(a, b, c, n)
    this.triangle(a, c, d, n)
  }

  /** A box round `c`, its half-axes `ax`, `ay`, `az` any three directions (a slanted stair stringer as well as a cornice). */
  box(c: THREE.Vector3, ax: THREE.Vector3, ay: THREE.Vector3, az: THREE.Vector3) {
    // A right-handed frame, so each face's corners run counter-clockwise from outside.
    if (ax.clone().cross(ay).dot(az) < 0) az = az.clone().negate()
    const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
      [ax, ay, az], [ay, az, ax], [az, ax, ay],
      [ax.clone().negate(), az, ay], [ay.clone().negate(), ax, az], [az.clone().negate(), ay, ax],
    ]
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    const normal = new THREE.Vector3()
    for (const [n, u, v] of faces) {
      p[0].copy(c).add(n).sub(u).sub(v)
      p[1].copy(c).add(n).add(u).sub(v)
      p[2].copy(c).add(n).add(u).add(v)
      p[3].copy(c).add(n).sub(u).add(v)
      this.quad(p[0], p[1], p[2], p[3], normal.copy(n).normalize())
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3))
    for (const name in this.data) g.setAttribute(name, new THREE.Float32BufferAttribute(this.data[name], this.sizes[name]))
    g.computeBoundingSphere()
    return g
  }

  mesh(material: THREE.Material, shadows = true) {
    const mesh = new THREE.Mesh(this.geometry(), material)
    mesh.castShadow = mesh.receiveShadow = shadows
    return mesh
  }
}

/** A colour's linear components, for a vertex attribute. */
export const rgb = (hex: number) => {
  const c = new THREE.Color(hex)
  return [c.r, c.g, c.b]
}
