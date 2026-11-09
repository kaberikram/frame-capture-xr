// End-to-end smoke check in headless Chromium.
//
//   npm run smoke            desk demo + emulated headset (IWER)
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

async function desk(browser, failures) {
  const { context, page, errors } = await openPage(browser, '?preview=1&shot=1&ui=0', { fixedClock: true })
  check((await page.evaluate(() => window.__capture.warp)) === 'slow', 'desk: the time window starts in slow motion', failures)
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
      const before = window.__capture.amount
      const mode = window.__capture.cycle()
      window.__capture.nudge(0.2)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({ mode, warp: window.__capture.warp, before, after: window.__capture.amount })
      }))
    }))
    check(switched.mode === 'echo' && switched.warp === 'echo', `headset: the time mode cycles to echo (got ${switched.mode} / ${switched.warp})`, failures)
    check(switched.after > switched.before + 0.05, `headset: the time strength can be raised (${switched.before} → ${switched.after})`, failures)
  }
  const timing = logs.find((l) => l.includes('darkroom'))
  if (timing) console.log(`     ${timing}`)
  await context.close()
}

;(async () => {
  const { chromium } = loadPlaywright()
  const server = await ensureServer()
  const browser = await chromium.launch({ args: [...GL, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  const failures = []
  try {
    await desk(browser, failures)
    await headset(browser, failures, false)
    await headset(browser, failures, true)
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
