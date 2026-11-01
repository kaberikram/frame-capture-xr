import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  CanvasTexture,
  SRGBColorSpace,
} from '@iwsdk/core'

/** A small room the desk preview films, standing in for passthrough. */
export function buildStandIn(): Group {
  const room = new Group()
  room.name = 'stand-in'

  const plaster = new MeshStandardMaterial({ color: new Color('#c8c2b6'), roughness: 0.92 })
  const floorMat = new MeshStandardMaterial({ color: new Color('#8d8578'), roughness: 0.95 })
  const wood = new MeshStandardMaterial({ color: new Color('#6e4b32'), roughness: 0.8 })
  const clay = new MeshStandardMaterial({ color: new Color('#d7c4ae'), roughness: 0.55 })
  const lamp = new MeshStandardMaterial({ color: new Color('#f7f1e4'), roughness: 0.4, emissive: new Color('#3a2a16'), emissiveIntensity: 0.4 })

  const floor = new Mesh(new PlaneGeometry(8, 8), floorMat)
  floor.rotation.x = -Math.PI / 2
  room.add(floor)

  const wall = new Mesh(new PlaneGeometry(5.2, 2.8), plaster)
  wall.position.set(0, 1.4, -2.2)
  room.add(wall)

  const side = new Mesh(new PlaneGeometry(4, 2.8), plaster)
  side.position.set(-2.4, 1.4, -0.4)
  side.rotation.y = Math.PI / 2
  room.add(side)

  const art = new Mesh(new PlaneGeometry(1.2, 0.86), new MeshBasicMaterial({ map: artTexture() }))
  art.position.set(0.02, 1.42, -2.16)
  art.name = 'stand-in-art'
  room.add(art)

  const plinth = new Mesh(new BoxGeometry(0.34, 0.62, 0.34), wood)
  plinth.position.set(-0.72, 0.31, -1.45)
  room.add(plinth)

  const vase = new Mesh(new SphereGeometry(0.13, 28, 20), clay)
  vase.scale.set(1, 1.25, 1)
  vase.position.set(-0.72, 0.74, -1.45)
  room.add(vase)

  const table = new Mesh(new BoxGeometry(0.72, 0.06, 0.42), wood)
  table.position.set(0.78, 0.48, -1.35)
  room.add(table)

  const leg = new Mesh(new BoxGeometry(0.05, 0.46, 0.05), wood)
  leg.position.set(0.78, 0.23, -1.35)
  room.add(leg)

  // Sits in the preview frame's view, nearer than the painting, so the relief has a foreground.
  const cup = new Mesh(new CylinderGeometry(0.07, 0.06, 0.16, 20), lamp)
  cup.position.set(0.16, 1.22, -1.25)
  room.add(cup)

  const hemi = new HemisphereLight('#f4f0e8', '#6a6258', 0.85)
  room.add(hemi)
  const sun = new DirectionalLight('#fff5e8', 1.35)
  sun.position.set(1.2, 3.2, 1.4)
  room.add(sun)

  return room
}

function artTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 768
  canvas.height = 550
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas is unavailable')
  const w = canvas.width
  const h = canvas.height
  ctx.fillStyle = '#1a3148'
  ctx.fillRect(0, 0, w, h)
  const sky = ctx.createLinearGradient(0, 0, 0, h)
  sky.addColorStop(0, '#243e5c')
  sky.addColorStop(1, '#14283c')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, h)

  const glow = ctx.createRadialGradient(w * 0.58, h * 0.36, 10, w * 0.58, h * 0.36, w * 0.34)
  glow.addColorStop(0, '#fff8ea')
  glow.addColorStop(0.35, '#f2c98a')
  glow.addColorStop(1, 'rgba(26, 49, 72, 0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(w * 0.58, h * 0.36, w * 0.2, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#e23b3b'
  ctx.beginPath()
  ctx.arc(w * 0.2, h * 0.22, w * 0.045, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#16324a'
  ctx.beginPath()
  ctx.moveTo(0, h * 0.78)
  ctx.quadraticCurveTo(w * 0.28, h * 0.5, w * 0.5, h * 0.72)
  ctx.quadraticCurveTo(w * 0.74, h * 0.92, w, h * 0.6)
  ctx.lineTo(w, h)
  ctx.lineTo(0, h)
  ctx.fill()

  ctx.fillStyle = '#ffb15e'
  ctx.fillRect(w * 0.3, h * 0.62, w * 0.07, h * 0.1)
  ctx.fillStyle = '#1a3148'
  ctx.fillRect(w * 0.331, h * 0.62, w * 0.008, h * 0.1)
  ctx.fillRect(w * 0.3, h * 0.666, w * 0.07, h * 0.008)

  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  return tex
}
