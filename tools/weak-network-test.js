// Weak-network test for a relayed call.
//
// Both browsers reach TURN through a UDP impairment proxy (like a clumsy filter on the TURN port)
// that adds delay / jitter / loss in both directions. The script walks through baseline, moderate,
// bad, recovery and full-outage phases and checks that the call adapts and recovers on its own.
//
// Requires a running coturn (see deploy/local/docker-compose.yml) and a local Chrome:
//   TURN_SECRET=<same as coturn> TURN_HOST=<your LAN IP> npm run test:weak-network
// Optional: CHROME_PATH, TURN_PORT (3478), PROXY_PORT (3479), PORT (8023),
//           AB_DISABLE_RED=1 to compare against plain Opus.
const { chromium } = require('playwright-core')
const { spawn } = require('child_process')
const dgram = require('dgram')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PORT = Number(process.env.PORT || 8023)
const BASE = `http://localhost:${PORT}`
const TURN_PORT = Number(process.env.TURN_PORT || 3478)
const PROXY_PORT = Number(process.env.PROXY_PORT || 3479)
const { TURN_SECRET, TURN_HOST } = process.env
const DISABLE_RED = !!process.env.AB_DISABLE_RED
const CHROME = process.env.CHROME_PATH || {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
}[process.platform]

if (!TURN_SECRET || !TURN_HOST) {
  console.error('Set TURN_SECRET (same as coturn) and TURN_HOST (your LAN IP, not 127.0.0.1).')
  process.exit(2)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// --- UDP impairment proxy ----------------------------------------------------

let impairment = { delayMs: 0, jitterMs: 0, loss: 0 }

function gaussian() {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function impaired(send) {
  if (Math.random() < impairment.loss) return
  const delay = Math.max(0, impairment.delayMs + impairment.jitterMs * gaussian())
  if (delay === 0) send()
  else setTimeout(send, delay)
}

// One upstream socket per client address, like a NAT, so coturn sees distinct clients.
function startProxy() {
  const front = dgram.createSocket('udp4')
  const upstreams = new Map()
  front.on('message', (msg, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`
    let up = upstreams.get(key)
    if (!up) {
      up = dgram.createSocket('udp4')
      up.on('message', reply => impaired(() => front.send(reply, rinfo.port, rinfo.address)))
      up.bind(0)
      upstreams.set(key, up)
    }
    impaired(() => up.send(msg, TURN_PORT, '127.0.0.1'))
  })
  front.bind(PROXY_PORT, '0.0.0.0')
  return () => {
    front.close()
    for (const u of upstreams.values()) u.close()
  }
}

// Same notation as netem / clumsy, e.g. "delay 40ms 10ms loss 1.5%"; applied per direction.
function setImpairment(spec) {
  const delay = spec && /delay (\d+)ms(?: (\d+)ms)?/.exec(spec)
  const loss = spec && /loss ([\d.]+)%/.exec(spec)
  impairment = {
    delayMs: delay ? Number(delay[1]) : 0,
    jitterMs: delay && delay[2] ? Number(delay[2]) : 0,
    loss: loss ? Number(loss[1]) / 100 : 0,
  }
}

// --- Measurement -------------------------------------------------------------

let failed = false
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`)
  if (!cond) failed = true
}

function sample(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs[window.__pcs.length - 1]
    const out = { state: pc.connectionState }
    const stats = await pc.getStats()
    let pair
    stats.forEach(r => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId)
      if (r.type === 'inbound-rtp' && r.kind === 'audio') Object.assign(out, { aPkts: r.packetsReceived, aLost: r.packetsLost, concealed: r.concealedSamples, samples: r.totalSamplesReceived })
      if (r.type === 'inbound-rtp' && r.kind === 'video') Object.assign(out, { inW: r.frameWidth, inFps: r.framesPerSecond, frames: r.framesDecoded })
      if (r.type === 'outbound-rtp' && r.kind === 'video') Object.assign(out, { outW: r.frameWidth, outFps: r.framesPerSecond })
    })
    out.rtt = pair && pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : null
    const audio = pc.getTransceivers().find(t => t.receiver.track.kind === 'audio')
    const codecs = audio.sender.getParameters().codecs
    out.aCodec = codecs && codecs[0] ? codecs[0].mimeType : null
    const video = pc.getTransceivers().find(t => t.receiver.track.kind === 'video')
    const enc = video.sender.getParameters().encodings
    out.maxKbps = enc && enc[0] && enc[0].maxBitrate ? enc[0].maxBitrate / 1000 : null
    out.level = document.querySelector('#quality').dataset.level
    out.banner = document.querySelector('#banner').hidden ? '' : document.querySelector('#banner-text').textContent
    out.status = document.querySelector('#conn-status').textContent
    return out
  })
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return
    } catch { /* not up yet */ }
    await sleep(100)
  }
  throw new Error('server did not start')
}

;(async () => {
  const stopProxy = startProxy()
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      AUDIT_DIR: '',
      TURN_SECRET,
      TURN_URLS: `turn:${TURN_HOST}:${PROXY_PORT}?transport=udp`,
      ICE_TRANSPORT_POLICY: 'relay',
    },
  })
  const browsers = []
  const pages = {}

  try {
    await waitForServer()
    const html = await (await fetch(`${BASE}/dev/new`)).text()
    const [doctorUrl, patientUrl] = [...html.matchAll(/href="([^"]+#token=[^"]+)"/g)].map(m => m[1])

    // Separate browser processes so one side's network emulation can never leak into the other.
    for (const [name, url] of [['patient', patientUrl], ['doctor', doctorUrl]]) {
      const browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
      })
      browsers.push(browser)
      const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] })
      // Test-only hook so the script can read the app's peer connection stats.
      await ctx.addInitScript(() => {
        const Orig = RTCPeerConnection
        window.__pcs = []
        window.RTCPeerConnection = function (cfg) {
          const pc = new Orig(cfg)
          window.__pcs.push(pc)
          return pc
        }
        window.RTCPeerConnection.prototype = Orig.prototype
      })
      if (DISABLE_RED) await ctx.addInitScript(() => { RTCRtpTransceiver.prototype.setCodecPreferences = function () {} })
      const page = await ctx.newPage()
      page.on('pageerror', e => console.log(`[${name}] PAGEERROR ${e.message}`))
      page.on('dialog', d => d.accept())
      await page.goto(url)
      if (name === 'patient') await page.check('#consent')
      await page.click('#btn-join')
      pages[name] = page
    }
    await pages.doctor.waitForSelector('#btn-admit', { state: 'visible' })
    await pages.doctor.click('#btn-admit')
    await pages.doctor.waitForFunction(() => document.querySelector('#conn-status').textContent.includes('通話中'), null, { timeout: 20000 })
    console.log(`call connected via TURN relay${DISABLE_RED ? ' (RED disabled for A/B)' : ''}`)

    const t0 = Date.now()
    async function runPhase(name, seconds, spec) {
      console.log(`\n--- ${name}: ${spec || 'no impairment'} (${seconds}s)`)
      console.log('time  phase     | D.level D.rtt D.maxKbps D.outW D.outFps | D<-P inW inFps aLoss% conceal% | P.level P.maxKbps | status / banner')
      setImpairment(spec)
      const rows = []
      let prev = await sample(pages.doctor)
      const end = Date.now() + seconds * 1000
      while (Date.now() < end) {
        await sleep(4000)
        const d = await sample(pages.doctor)
        const p = await sample(pages.patient)
        const pkts = (d.aPkts || 0) - (prev.aPkts || 0)
        const lost = (d.aLost || 0) - (prev.aLost || 0)
        const samples = (d.samples || 0) - (prev.samples || 0)
        const row = {
          t: Math.round((Date.now() - t0) / 1000),
          d,
          p,
          audioPkts: pkts,
          lossPct: pkts + lost > 0 ? (100 * lost) / (pkts + lost) : 0,
          conceal: samples > 0 ? (100 * ((d.concealed || 0) - (prev.concealed || 0))) / samples : 100,
          framesDelta: (d.frames || 0) - (prev.frames || 0),
        }
        rows.push(row)
        const status = d.banner ? `${d.status} / ${d.banner}` : p.banner ? `${d.status} / P: ${p.banner}` : d.status
        console.log(`${String(row.t).padStart(4)}s ${name.padEnd(9)} | ${String(d.level).padEnd(7)} ${String(d.rtt).padStart(5)} ${String(d.maxKbps).padStart(9)} ${String(d.outW).padStart(6)} ${String(d.outFps ?? '-').padStart(8)} | ${String(d.inW).padStart(8)} ${String(d.inFps ?? '-').padStart(5)} ${row.lossPct.toFixed(1).padStart(6)} ${row.conceal.toFixed(1).padStart(8)} | ${String(p.level).padEnd(7)} ${String(p.maxKbps).padStart(9)} | ${status}`)
        prev = d
      }
      const avg = rows.reduce((a, r) => a + r.conceal, 0) / rows.length
      console.log(`    avg audio concealment: ${avg.toFixed(1)}%  (audio codec: ${rows[rows.length - 1].d.aCodec})`)
      return rows
    }

    const base = await runPhase('baseline', 12, null)
    check(base.every(r => r.d.state === 'connected' && r.d.level === 'good'), 'baseline: connected with good quality')
    if (!DISABLE_RED) check(base[base.length - 1].d.aCodec === 'audio/red', 'audio negotiated with RED redundancy')

    // Applied per direction on each client<->TURN leg: one-way impact doubles end to end, x4 on RTT.
    const moderate = await runPhase('moderate', 32, 'delay 40ms 10ms loss 1.5%')
    check(moderate.every(r => r.d.state === 'connected'), 'moderate: call never drops')
    check(moderate.every(r => r.audioPkts > 0), 'moderate: audio keeps flowing')
    check(moderate.some(r => r.d.level !== 'good'), 'moderate: quality indicator reflects degradation')

    const bad = await runPhase('bad', 60, 'delay 90ms 30ms loss 6%')
    check(bad.every(r => r.d.state === 'connected'), 'bad: call never drops')
    check(bad.every(r => r.audioPkts > 0), 'bad: audio keeps flowing every sample')
    check(bad.some(r => r.d.level === 'poor'), 'bad: indicator shows poor')
    check(bad.some(r => r.d.maxKbps !== null && r.d.maxKbps < 1500), 'bad: video bitrate cap stepped down')
    check(bad.some(r => /關閉鏡頭/.test(r.d.banner + r.p.banner)), 'bad: audio-only suggestion shown')

    const recovery = await runPhase('recovery', 64, null)
    const last = recovery[recovery.length - 1]
    check(last.d.level === 'good', 'recovery: quality back to good')
    check(last.d.maxKbps === 1500 && last.p.maxKbps === 1500, 'recovery: video bitrate stepped back up to 1500 kbps')
    check(!/關閉鏡頭/.test(last.d.banner + last.p.banner), 'recovery: audio-only suggestion cleared')

    const outage = await runPhase('outage', 12, 'loss 100%')
    const restored = await runPhase('restored', 32, null)
    check(outage.some(r => r.d.level === 'poor'), 'outage: quality indicator drops to poor')
    check(outage.some(r => r.framesDelta === 0 || r.d.state !== 'connected' || /重新連線|不穩/.test(r.d.status)), 'outage: interruption detected')
    check(restored.slice(-3).every(r => r.d.state === 'connected' && r.framesDelta > 0 && r.audioPkts > 0), 'restored: media flowing again without user action')
    const resumed = restored.find(r => r.d.state === 'connected' && r.framesDelta > 0)
    if (resumed) console.log(`media resumed within ~${resumed.t - restored[0].t + 4}s after network restored`)
  } catch (err) {
    console.error('ERROR', err)
    failed = true
  } finally {
    setImpairment(null)
    stopProxy()
    for (const b of browsers) await b.close()
    server.kill()
    console.log(failed ? '\nWEAK-NETWORK TEST FAILED' : '\nWEAK-NETWORK TEST PASSED')
    process.exit(failed ? 1 : 0)
  }
})()
