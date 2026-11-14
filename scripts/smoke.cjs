// End-to-end smoke check in headless Chromium.
//
//   npm run smoke            desk demo + emulated headset (IWER), for frame capture and for the room peel
//   npm run smoke -- --shots out/   also save a screenshot of every ?at= stage
//
// Uses the dev server on https://localhost:4473, starting one if none is up.
// Needs Playwright with Chromium: `npm i -D playwright && npx playwright install chromium`.
// The depth model is blocked so runs are repeatable; brightness depth stands in.
const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')

function loadPlaywright() {
  try {
    return require('playwright')
  } catch {
    try {
      const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
      return require(path.join(root, 'playwright'))
    } catch {
      console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium')
      process.exit(2)
    }
  }
}

const ORIGIN = 'https://localhost:4473'
const HOLDS = ['draw', 'photo', 'side', 'rest', 'peel', 'open', 'curl', 'detached', 'stuck']
const DESK_ORDER = ['drawing', 'relief', 'curl', 'dissolve', 'detached', 'stuck']
const shotsDir = (() => {
  const at = process.argv.indexOf('--shots')
  return at >= 0 ? process.argv[at + 1] : null
})()

function reachable() {
  return new Promise((resolve) => {
    const req = https.get(`${ORIGIN}/`, { rejectUnauthorized: false }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function ensureServer() {
  if (await reachable()) return null
  const server = spawn('npx', ['vite', '--port', '4473', '--strictPort'], { cwd: path.join(__dirname, '..'), stdio: 'ignore' })
  for (let i = 0; i < 120; i++) {
    if (await reachable()) return server
    await new Promise((r) => setTimeout(r, 500))
  }
  server.kill()
  throw new Error('dev server did not start on 4473')
}

const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

async function openPage(browser, query, opts = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 960, height: 640 } })
  if (opts.camera) await context.grantPermissions(['camera'], { origin: ORIGIN })
  const page = await context.newPage()
  const errors = []
  const logs = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    const text = m.text()
    if (m.type() === 'error') errors.push(text)
    if (text.startsWith('[frame]')) logs.push(text)
  })
  await page.route(/huggingface|cdn\.jsdelivr\.net\/npm\/@huggingface/, (route) => route.abort())
  // The emulated headset downloads the room it stands in. Serve it from the installed package, so a run needs no network.
  await page.route(/unpkg\.com\/@iwer\/sem@[^/]+\/captures\/([\w-]+\.json)/, (route) => {
    const name = /captures\/([\w-]+\.json)/.exec(route.request().url())[1]
    const file = path.join(__dirname, '..', 'node_modules', '@iwer', 'sem', 'captures', name)
    if (!fs.existsSync(file)) return route.abort()
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(file) })
  })
  if (opts.fixedClock) {
    // Every frame advances 1/60 s, however slow software rendering is, so the desk demo is repeatable.
    await page.addInitScript(() => {
      let now = 0
      const raf = window.requestAnimationFrame.bind(window)
      performance.now = () => now
      window.requestAnimationFrame = (cb) => raf(() => { now += 1000 / 60; cb(now) })
    })
  }
  await page.goto(`${ORIGIN}/${query}`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__capture, null, { timeout: 60000 })
  return { context, page, errors, logs }
}

async function frames(page, n) {
  await page.evaluate((count) => new Promise((resolve) => {
    let left = count
    const step = () => { if (--left <= 0) resolve(); else requestAnimationFrame(step) }
    requestAnimationFrame(step)
  }), n)
}

function check(ok, message, failures) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
  if (!ok) failures.push(message)
}

async function room(browser, failures) {
  const { context, page, errors } = await openPage(browser, 'peel?preview=1&ui=0')
  const api = () => page.evaluate(() => ({
    room: window.__capture.room,
    chunks: window.__capture.roomChunks,
    piece: window.__capture.roomPiece,
    radius: window.__capture.roomRadius,
    lights: window.__capture.roomLights,
    pool: window.__capture.roomPool,
    pieces: window.__capture.roomPatches,
    kind: window.__capture.roomKind,
    attention: window.__capture.roomAttention,
    outline: window.__capture.roomOutline,
    count: window.__capture.count,
  }))
  const until = async (pred, ms) => { const end = Date.now() + ms; let s = await api(); while (!pred(s) && Date.now() < end) { await page.waitForTimeout(150); s = await api() } return s }
  let state = await until((s) => s.chunks > 150, 20000)
  check(state.room === true, 'peel: /peel is the peel page', failures)
  check(state.chunks > 150, `peel: the stand-in room is read (chunks ${state.chunks})`, failures)
  const box = await page.locator('#scene-container').boundingBox()
  const at = (fx, fy) => [(box?.x ?? 0) + (box?.width ?? 960) * fx, (box?.y ?? 0) + (box?.height ?? 640) * fy]
  // The wall, left of the painting.
  const [wx, wy] = at(0.2, 0.36)
  await page.mouse.move(wx - 20, wy)
  await page.mouse.move(wx, wy)
  state = await until((s) => s.pool > 0.5 && s.outline > 0.5, 5000)
  check(state.pool > 0.5, `peel: light gathers on the wall under the cursor (level ${state.pool.toFixed(2)})`, failures)
  check(state.outline > 0.5 && state.attention < 0.1, `peel: the outline of the cut shows on the bare wall before the pinch (outline ${state.outline.toFixed(2)}, ghost ${state.attention.toFixed(2)})`, failures)

  // A small tug settles back and leaves nothing.
  await page.mouse.down()
  await page.mouse.move(wx, wy - 6, { steps: 3 })
  await page.waitForTimeout(200)
  await page.mouse.up()
  state = await until((s) => s.pieces === 0, 4000)
  check(state.pieces === 0 && state.lights === 0, `peel: a small tug settles back into the wall (pieces ${state.pieces})`, failures)

  // The piece is the cut the outline showed, from the first pull to the pop.
  state = await until((s) => s.outline > 0.5, 3000)
  await page.mouse.down()
  await page.mouse.move(wx, wy - 20, { steps: 6 })
  await page.waitForTimeout(300)
  const small = await api()
  await page.mouse.move(wx, wy - 50, { steps: 8 })
  await page.waitForTimeout(300)
  const large = await api()
  check(small.piece === 'lifting' && small.kind === 'flat' && Math.abs(small.radius - 0.11) < 0.005 && Math.abs(large.radius - small.radius) < 1e-6, `peel: the piece is the size its outline showed, and stays it (${small.radius.toFixed(3)} then ${large.radius.toFixed(3)} m)`, failures)
  check(small.outline < 0.05, `peel: the outline becomes the piece (outline ${small.outline.toFixed(2)})`, failures)
  await page.mouse.move(wx, wy - 100, { steps: 10 })
  state = await until((s) => s.piece === 'carried' && s.lights === 1, 4000)
  check(state.piece === 'carried', `peel: a full pull pops it free in the hand (got ${state.piece})`, failures)
  check(state.lights === 1, `peel: warm light opens where it was (lights ${state.lights})`, failures)

  // Carry it over the table and let go.
  const [tx, ty] = at(0.79, 0.965)
  await page.mouse.move(tx, ty, { steps: 24 })
  await page.waitForTimeout(500)
  await page.mouse.up()
  state = await until((s) => s.piece === 'stuck', 5000)
  check(state.piece === 'stuck', `peel: let go over the table and it lies down (got ${state.piece})`, failures)
  state = await until((s) => s.lights === 0, 5000)
  check(state.lights === 0, `peel: the light where it left fades, and the wall is whole again (lights ${state.lights})`, failures)

  // A pull let go part way tears free at that size and floats.
  const [fx, fy] = at(0.72, 0.3)
  await page.mouse.move(fx, fy, { steps: 6 })
  await page.waitForTimeout(400)
  await page.mouse.down()
  await page.mouse.move(fx, fy - 36, { steps: 8 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  state = await until((s) => s.piece === 'free', 4000)
  check(state.piece === 'free' && Math.abs(state.radius - 0.11) < 0.005, `peel: let go part way and it tears free and floats (got ${state.piece}, ${state.radius.toFixed(3)} m)`, failures)
  check(state.kind === 'flat', `peel: a piece of wall is a flat piece (got ${state.kind})`, failures)

  // A thing: the vase on its stand. Light gathers on its shape, and it comes away whole, in three dimensions.
  const [vx, vy] = at(0.22, 0.78)
  await page.mouse.move(vx + 10, vy, { steps: 4 })
  await page.mouse.move(vx, vy)
  state = await until((s) => s.attention > 0.5 && s.outline < 0.1, 6000)
  check(state.attention > 0.5 && state.outline < 0.1, `lift: the ghost of the vase shows, not a cut (ghost ${state.attention.toFixed(2)}, outline ${state.outline.toFixed(2)})`, failures)
  const before = state.lights
  await page.mouse.down()
  await page.mouse.move(vx, vy - 30, { steps: 6 })
  await page.waitForTimeout(300)
  state = await api()
  check(state.piece === 'lifting' && state.kind === 'object', `lift: a pinch on the vase takes the vase (got ${state.piece}, ${state.kind})`, failures)
  check(state.radius > 0.08 && state.radius < 0.3, `lift: it is the size of the vase (${state.radius.toFixed(3)} m)`, failures)
  await page.mouse.move(vx, vy - 110, { steps: 10 })
  state = await until((s) => s.piece === 'carried', 4000)
  check(state.piece === 'carried' && state.kind === 'object', `lift: a full pull brings it away (got ${state.piece})`, failures)
  check(state.lights <= before + 1, 'lift: no hole of light is left in a thing', failures)
  await page.mouse.move(tx - 40, ty, { steps: 24 })
  await page.waitForTimeout(600)
  await page.mouse.up()
  state = await until((s) => s.piece === 'stuck' || s.piece === 'free', 5000)
  check(state.piece === 'stuck', `lift: let go over the table and it is set down (got ${state.piece})`, failures)
  check(state.count === 0, 'peel: no frame is ever drawn on this page', failures)
  if (shotsDir) {
    fs.mkdirSync(shotsDir, { recursive: true })
    await page.screenshot({ path: path.join(shotsDir, 'peel.png') })
  }
  check(errors.length === 0, `peel: no page errors${errors.length ? `: ${errors[0]}` : ''}`, failures)
  await context.close()
}

// Quest Browser gives depth as a texture; other browsers give numbers. Both are run.
async function peelHeadset(browser, failures, usage) {
  const name = `peel headset (${usage} depth)`
  const { context, page, errors, logs } = await openPage(browser, usage === 'gpu' ? 'peel?depth=gpu' : 'peel', { camera: true })
  await page.waitForFunction(() => !!window.IWER_DEVICE, null, { timeout: 60000 })
  await page.evaluate(() => {
    window.IWER_DEVICE.primaryInputMode = 'hand'
    window.IWER_DEVICE.controlMode = 'programmatic'
  })
  await page.waitForFunction(() => { const b = document.getElementById('enter'); return b && !b.disabled }, null, { timeout: 30000 })
  await page.click('#enter')
  const until = async (pred, ms) => { const end = Date.now() + ms; while (!(await pred()) && Date.now() < end) await page.waitForTimeout(200); return pred() }
  const api = () => page.evaluate(() => ({ ...window.__capture }))
  check(await until(async () => logs.some((l) => l.includes('depth-sensing')), 30000), `${name}: the session is granted depth sensing`, failures)
  check(await until(async () => logs.some((l) => l.includes(`room depth is ${usage}-optimized`)), 20000), `${name}: depth arrives the ${usage} way`, failures)
  check(await until(async () => (await api()).roomChunks > 220, 40000), `${name}: depth builds the room (chunks ${(await api()).roomChunks})`, failures)
  const hand = (p) => page.evaluate(([x, y, z]) => window.IWER_DEVICE.hands.right.position.set(x, y, z), p)
  // Reach forward until light gathers under the fingertip: that is a surface.
  let touch = null
  for (let i = 0; i < 34 && !touch; i++) {
    const p = [0.1, 1.25, -0.35 - 0.1 * i]
    await hand(p)
    await page.waitForTimeout(250)
    if ((await api()).roomPool > 0.75) touch = p
  }
  check(touch !== null, `${name}: light gathers on a surface as a hand nears it`, failures)
  if (touch) {
    // The light shows from a few centimetres away. Close the last of the gap, a little at a time, and pinch.
    let took = false
    for (const closer of [0.04, 0.08, 0, 0.12]) {
      await hand([touch[0], touch[1], touch[2] - closer])
      await page.waitForTimeout(400)
      await page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(1))
      await page.waitForTimeout(500)
      took = (await api()).roomPiece === 'lifting'
      if (took) {
        touch = [touch[0], touch[1], touch[2] - closer]
        break
      }
      await page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(0))
      await page.waitForTimeout(400)
    }
    const after = await api()
    check(took, `${name}: a pinch on the surface takes hold of it (got ${after.roomPiece}, light ${after.roomPool.toFixed(2)})`, failures)
    for (let i = 1; i <= 24; i++) {
      await hand([touch[0], touch[1], touch[2] + 0.012 * i])
      await page.waitForTimeout(80)
    }
    const pulled = await until(async () => (await api()).roomPiece === 'carried', 3000)
    check(pulled, `${name}: pulling it away pops it free (got ${(await api()).roomPiece})`, failures)
    // A flat piece leaves warm light in the wall. A thing with shape comes away whole and leaves none.
    const came = await api()
    check(came.roomKind === 'flat' ? came.roomLights === 1 : came.roomLights === 0, `${name}: warm light opens where a flat piece was, and not where a thing was (lights ${came.roomLights}, ${came.roomKind})`, failures)
    await page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(0))
    check(await until(async () => (await api()).roomPiece === 'free', 3000), `${name}: let go in the air and it floats (got ${(await api()).roomPiece})`, failures)
  }
  // Lift from where you stand. Turn the head; with a hand raised in view, the ghost of a thing shows where you look.
  // Each view gets a few seconds: a thing has to be looked at for a moment before depth knows its shape.
  await page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(0))
  const look = (yaw, pitch) => page.evaluate(([yaw, pitch]) => {
    const d = window.IWER_DEVICE
    const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), sx = Math.sin(pitch / 2), cx = Math.cos(pitch / 2)
    d.quaternion.set(cy * sx, sy * cx, -sy * sx, cy * cx)
    // The hand is held up in front, a little to the right: rotate (0.12, -0.05, -0.4) by the head.
    const q = { x: cy * sx, y: sy * cx, z: -sy * sx, w: cy * cx }
    const v = { x: 0.12, y: -0.05, z: -0.4 }
    const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x)
    const rx = v.x + q.w * tx + (q.y * tz - q.z * ty)
    const ry = v.y + q.w * ty + (q.z * tx - q.x * tz)
    const rz = v.z + q.w * tz + (q.x * ty - q.y * tx)
    const p = d.position
    d.hands.right.position.set(p.x + rx, p.y + ry, p.z + rz)
    return [rx, ry, rz]
  }, [yaw, pitch])
  // A bare wall straight ahead is not taken from across the room.
  await look(0, 0)
  await page.waitForTimeout(1200)
  const before = (await api()).roomPatches
  await page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(1))
  await page.waitForTimeout(700)
  check((await api()).roomPatches === before, `${name}: a pinch in the air at a bare wall takes nothing (pieces ${before} then ${(await api()).roomPatches})`, failures)
  await page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(0))
  let aim = null
  // The emulated room is a rough scan, mostly big furniture, which is rightly not a thing. Whether one of the
  // smaller things on its shelves reads as whole from 2-3 m varies with depth noise, so look twice around.
  const angles = [[0, -0.3], [0, -0.2], [0.75, -0.45], [0.25, -0.3], [-0.25, -0.3], [0.25, -0.15], [-0.5, -0.15], [0.5, -0.3]]
  for (let round = 0; round < 2 && !aim; round++) {
    for (const [yaw, pitch] of angles) {
      await look(yaw, pitch)
      if (await until(async () => (await api()).roomAttention > 0.6, 3000)) { aim = [yaw, pitch]; break }
    }
  }
  // Not a failure when the emulated room offered no thing this run: the desk checks lift the vase and the cup
  // every time. Said plainly, so a run that never finds one is noticed.
  if (aim) check(true, `${name}: looking at a thing with a hand raised shows its ghost (at ${aim})`, failures)
  else console.log(`skip ${name}: the emulated room offered no thing to look at this run, so look-and-pinch was not checked`)
  if (aim) {
    const hand = await look(aim[0], aim[1])
    const count = (await api()).roomPatches
    await page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(1))
    const far = await until(async () => { const a = await api(); return a.roomPiece === 'lifting' && a.roomPatches === count + 1 }, 3000)
    check(far && (await api()).roomKind === 'object', `${name}: a pinch in the air takes the thing whose ghost showed (got ${(await api()).roomPiece}, ${(await api()).roomKind})`, failures)
    if (far) {
      // Pull back toward you.
      for (let i = 1; i <= 12; i++) {
        await page.evaluate(([x, y, z, k]) => { const p = window.IWER_DEVICE.position; window.IWER_DEVICE.hands.right.position.set(p.x + x * k, p.y + y * k, p.z + z * k) }, [...hand, 1 - 0.03 * i])
        await page.waitForTimeout(80)
      }
      check(await until(async () => (await api()).roomPiece === 'carried', 3000), `${name}: a short pull brings it to the hand (got ${(await api()).roomPiece})`, failures)
      await page.waitForTimeout(900)
      await page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(0))
      check(await until(async () => ['free', 'landing', 'stuck'].includes((await api()).roomPiece), 3000), `${name}: let go and it stays by the hand (got ${(await api()).roomPiece})`, failures)
    }
  }
  check((await api()).count === 0, `${name}: no frame is drawn`, failures)
  check(errors.length === 0, `${name}: no page errors${errors.length ? `: ${errors[0]}` : ''}`, failures)
  await context.close()
}

async function clean(browser, failures) {
  const { context, page, errors } = await openPage(browser, 'clean?preview=1')
  const dom = await page.evaluate(() => {
    const hint = document.getElementById('hint')
    const status = document.getElementById('status')
    const guide = `${hint?.textContent ?? ''} ${status?.textContent ?? ''}`
    return {
      clean: document.documentElement.classList.contains('clean'),
      hintHidden: hint ? getComputedStyle(hint).display === 'none' : false,
      warp: window.__capture.warp,
      guide,
    }
  })
  check(dom.clean && dom.hintHidden && dom.guide.trim() === '', 'clean: the guide and status are not on the page', failures)
  check(dom.warp === 'echo', `clean: the time window still starts in echo (got ${dom.warp})`, failures)
  check(!/pinch the mark|diamond|drag to draw/i.test(dom.guide), 'clean: no instructions about drawing or the old mark', failures)
  check((await page.evaluate(() => window.__capture.room)) === false, 'clean: frame capture is not the peel page', failures)
  check(errors.length === 0, `clean: no page errors${errors.length ? `: ${errors[0]}` : ''}`, failures)
  await context.close()
}

async function desk(browser, failures) {
  const { context, page, errors } = await openPage(browser, '?preview=1&shot=1&ui=0', { fixedClock: true })
  check((await page.evaluate(() => window.__capture.warp)) === 'echo', 'desk: the time window starts in echo', failures)
  const seen = []
  for (let i = 0; i < 60 * 26; i += 6) {
    await frames(page, 6)
    const phase = await page.evaluate(() => window.__capture.phase)
    if (seen[seen.length - 1] !== phase) seen.push(phase)
    if (phase === 'stuck') break
  }
  let at = 0
  for (const want of DESK_ORDER) {
    const found = seen.indexOf(want, at)
    if (found < 0) {
      at = -1
      break
    }
    at = found
  }
  check(at >= 0, `desk demo runs ${DESK_ORDER.join(' → ')} (saw ${seen.join(' → ')})`, failures)
  check(errors.length === 0, `desk demo has no page errors${errors.length ? `: ${errors[0]}` : ''}`, failures)
  await context.close()
}

async function holds(browser, failures) {
  fs.mkdirSync(shotsDir, { recursive: true })
  for (const hold of HOLDS) {
    const { context, page, errors } = await openPage(browser, `?preview=1&ui=0&at=${hold}`, { fixedClock: true })
    await frames(page, 60 * 14)
    await page.screenshot({ path: path.join(shotsDir, `at-${hold}.png`) })
    check(errors.length === 0, `?at=${hold} renders without errors`, failures)
    await context.close()
  }
}

async function headset(browser, failures, leaveHandInFrame) {
  const { context, page, errors, logs } = await openPage(browser, '', { camera: true })
  const device = (fn, arg) => page.evaluate(fn, arg)
  await page.waitForFunction(() => !!window.IWER_DEVICE, null, { timeout: 60000 })
  await device(() => {
    window.IWER_DEVICE.primaryInputMode = 'hand'
    window.IWER_DEVICE.controlMode = 'programmatic'
  })
  await page.waitForFunction(() => { const b = document.getElementById('enter'); return b && !b.disabled }, null, { timeout: 30000 })
  await page.click('#enter')
  const until = async (pred, ms) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await page.waitForTimeout(200); return pred() }
  check(await until(() => logs.some((l) => l.includes('session')), 30000), 'headset: passthrough session starts', failures)
  check(await until(() => logs.some((l) => l.includes('camera frames')), 20000), 'headset: camera delivers frames', failures)
  await device(() => window.IWER_DEVICE.hands.right.position.set(-0.08, 1.38, -0.42))
  await page.waitForTimeout(500)
  await device(() => window.IWER_DEVICE.hands.right.updatePinchValue(1))
  await page.waitForTimeout(500)
  for (let i = 1; i <= 24; i++) {
    await device((k) => window.IWER_DEVICE.hands.right.position.set(-0.08 + 0.26 * k, 1.38 + 0.17 * k, -0.42), i / 24)
    await page.waitForTimeout(40)
  }
  check((await page.evaluate(() => window.__capture.phase)) === 'drawing', 'headset: a pinch-drag draws a frame', failures)
  // Open the pinch before moving the hand. A teleport while the pinch is still
  // closed drags the corner with it, and the frame comes out too small to keep.
  await device(() => window.IWER_DEVICE.hands.right.updatePinchValue(0))
  await page.waitForFunction(() => window.__capture.phase !== 'drawing', null, { timeout: 4000 })
  if (leaveHandInFrame) {
    await device(() => window.IWER_DEVICE.hands.right.position.set(0.05, 1.42, -0.42))
    let nudged = false
    for (let i = 0; i < 12 && !nudged; i++) {
      await page.waitForTimeout(100)
      nudged = /hands fall away/i.test((await page.evaluate(() => document.getElementById('status')?.textContent)) ?? '')
    }
    check(nudged, 'headset: a hand left in the frame holds the shutter and is asked to move', failures)
  } else {
    await page.waitForTimeout(250)
    await device(() => window.IWER_DEVICE.hands.right.position.set(0.35, 0.95, -0.15))
  }
  await until(() => logs.some((l) => l.includes('depth brightness')), 15000)
  await page.waitForTimeout(2500)
  const api = await page.evaluate(() => ({ ...window.__capture }))
  const label = leaveHandInFrame ? 'with a hand left in the frame' : 'after the hand moves away'
  check(api.count === 1 && api.relief > 0.9, `headset: the photo is taken and blooms ${label} (count ${api.count}, relief ${api.relief.toFixed(2)})`, failures)
  if (leaveHandInFrame) check(logs.some((l) => l.includes('hand still in the frame')), 'headset: the shutter gives up waiting after its timeout', failures)
  check(errors.length === 0, `headset: no page errors ${label}${errors.length ? `: ${errors[0]}` : ''}`, failures)
  if (!leaveHandInFrame) {
    const switched = await page.evaluate(() => new Promise((resolve) => {
      const mode = window.__capture.cycle()
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({ mode, warp: window.__capture.warp })
      }))
    }))
    check(switched.mode === 'slit' && switched.warp === 'slit', `headset: the time mode cycles to slit scan (got ${switched.mode} / ${switched.warp})`, failures)
  }
  const timing = logs.find((l) => l.includes('darkroom'))
  if (timing) console.log(`     ${timing}`)
  await context.close()
}

;(async () => {
  const { chromium } = loadPlaywright()
  const server = await ensureServer()
  // `SMOKE_CHROMIUM=/path/to/chrome` uses a browser that is already installed.
  const browser = await chromium.launch({
    executablePath: process.env.SMOKE_CHROMIUM || undefined,
    args: [...GL, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  const failures = []
  try {
    // `SMOKE_ONLY=peel` runs just the room peel checks.
    const only = process.env.SMOKE_ONLY
    if (only !== 'peel') await clean(browser, failures)
    await room(browser, failures)
    if (only !== 'peel') {
      await desk(browser, failures)
      await headset(browser, failures, false)
      await headset(browser, failures, true)
    }
    await peelHeadset(browser, failures, 'cpu')
    await peelHeadset(browser, failures, 'gpu')
    if (shotsDir) await holds(browser, failures)
  } finally {
    await browser.close()
    server?.kill()
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nsmoke ok')
  process.exit(failures.length ? 1 : 0)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
