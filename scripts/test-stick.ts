import {
  appendBoxFaces,
  DESK_SURFACES,
  DESK_TABLE,
  DESK_WALL,
  nearestSurface,
  raySurface,
  stickBasis,
} from '../src/surfaces.ts'

const cam = { x: 0.02, y: 1.48, z: 0.42 }

const onWall = nearestSurface(0, 1.4, -2.17, DESK_SURFACES, 0.04, cam.x, cam.y, cam.z)
if (!onWall || Math.abs(onWall.distance - 0.03) > 0.002) throw new Error(`wall snap ${onWall?.distance}`)
if (Math.abs(onWall.nz - 1) > 1e-4) throw new Error('wall normal should face the room')

const far = nearestSurface(0, 1.4, -2.05, DESK_SURFACES, 0.04, cam.x, cam.y, cam.z)
if (far) throw new Error('8 cm off the wall should not snap')

const behind = nearestSurface(0, 1.4, -2.23, DESK_SURFACES, 0.04, cam.x, cam.y, cam.z)
if (behind) throw new Error('the far side of the wall should not snap')

const table = nearestSurface(0.78, 0.54, -1.35, DESK_SURFACES, 0.04, cam.x, cam.y, cam.z)
if (!table || Math.abs(table.ny - 1) > 1e-4) throw new Error(`table snap ${table?.distance}`)
if (Math.abs(table.distance - 0.03) > 0.002) throw new Error(`table distance ${table.distance}`)

const offTable = nearestSurface(0.2, 0.54, -1.35, DESK_SURFACES, 0.04, cam.x, cam.y, cam.z)
if (offTable) throw new Error('beside the table should miss')

const ray = raySurface(0, 1.4, 0, 0, 0, -1, [DESK_WALL])
if (!ray || Math.abs(ray.z + 2.2) > 1e-4 || Math.abs(ray.nz - 1) > 1e-4) throw new Error('ray should meet the back wall')

const wallBasis = stickBasis(0, 0, 1, 0, 0, 1)
if (Math.abs(wallBasis.zx) > 1e-4 || Math.abs(wallBasis.zz - 1) > 1e-4) throw new Error('wall photo faces +Z')
if (Math.abs(wallBasis.yy - 1) > 1e-4) throw new Error('wall photo stays upright')

const tableBasis = stickBasis(0, 1, 0, 0, 1, 1)
if (Math.abs(tableBasis.zy - 1) > 1e-4) throw new Error('table photo faces up')
if (tableBasis.yz > -0.5) throw new Error('table photo top points away from the camera')

const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const faces: typeof DESK_SURFACES = []
appendBoxFaces(faces, id, [-0.3, 0, -0.2], [0.3, 0.5, 0.2])
const top = nearestSurface(0, 0.53, 0, faces, 0.04, 0, 2, 0)
if (!top || Math.abs(top.distance - 0.03) > 0.002 || Math.abs(top.ny - 1) > 1e-4) {
  throw new Error(`box top ${top?.distance} ${top?.ny}`)
}

if (DESK_TABLE.py !== 0.51) throw new Error('table height')

console.log('stick ok')
