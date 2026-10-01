const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { io: connect } = require('socket.io-client')
const { createServer } = require('../server/index')
const { createTurnCredentials } = require('../server/turn')
const { sanitizeSignal } = require('../server/signaling')

const config = {
  isProduction: false,
  port: 0,
  publicUrl: '',
  tlsCert: '',
  tlsKey: '',
  trustProxy: false,
  jwtSecret: 'test-jwt-secret',
  adminApiKey: 'test-admin-key',
  turnSecret: 'test-turn-secret',
  turnUrls: ['turn:turn.example.com:3478', 'turns:turn.example.com:443?transport=tcp'],
  stunUrls: ['stun:turn.example.com:3478'],
  turnTtlSeconds: 600,
  reconnectGraceMs: 200,
  connectionsPerIpPerMinute: 1000,
  earlyJoinMinutes: 30,
  lateLeaveMinutes: 30,
  auditDir: '',
  auditRetentionDays: 0,
  enableDevRoutes: false,
}

let ctx
let baseUrl
const auditEntries = []
const sockets = []

before(async () => {
  ctx = createServer(config, { auditSink: e => auditEntries.push(e) })
  await new Promise(resolve => ctx.server.listen(0, resolve))
  baseUrl = `http://localhost:${ctx.server.address().port}`
})

after(async () => {
  for (const s of sockets) s.close()
  await ctx.close()
})

function appointment() {
  return ctx.auth.createAppointment({ startsAt: new Date(), durationMinutes: 30 })
}

function client(token, sessionId = crypto.randomUUID()) {
  const s = connect(baseUrl, { auth: { token, sessionId }, transports: ['websocket'], reconnection: false, forceNew: true })
  sockets.push(s)
  return s
}

function once(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs)
    socket.once(event, (...args) => {
      clearTimeout(timer)
      resolve(args[0])
    })
  })
}

function never(socket, event, ms = 300) {
  return new Promise((resolve, reject) => {
    const handler = () => reject(new Error(`unexpected ${event}`))
    socket.once(event, handler)
    setTimeout(() => {
      socket.off(event, handler)
      resolve()
    }, ms)
  })
}

async function joinedPair() {
  const apt = appointment()
  const doctor = client(apt.tokens.doctor)
  await once(doctor, 'joined')
  const patient = client(apt.tokens.patient)
  await once(patient, 'joined')
  return { apt, doctor, patient }
}

describe('authentication', () => {
  test('rejects connection without a token', async () => {
    const err = await once(client(undefined), 'connect_error')
    assert.equal(err.message, 'unauthorized')
  })

  test('rejects a token signed with another secret', async () => {
    const other = createServer({ ...config, jwtSecret: 'other' })
    const forged = other.auth.createAppointment({ startsAt: new Date(), durationMinutes: 10 }).tokens.doctor
    await other.close()
    const err = await once(client(forged), 'connect_error')
    assert.equal(err.message, 'unauthorized')
  })

  test('rejects an expired token', async () => {
    const expired = ctx.auth.issueToken({
      appointmentId: 'a', role: 'doctor',
      notBefore: new Date(Date.now() - 7200000), expiresAt: new Date(Date.now() - 3600000),
    })
    const err = await once(client(expired), 'connect_error')
    assert.equal(err.message, 'unauthorized')
  })

  test('rejects a token used before its appointment window', async () => {
    const early = ctx.auth.createAppointment({ startsAt: new Date(Date.now() + 86400000), durationMinutes: 10 })
    const err = await once(client(early.tokens.patient), 'connect_error')
    assert.equal(err.message, 'unauthorized')
  })

  test('rejects a malformed session id', async () => {
    const err = await once(client(appointment().tokens.doctor, 'x'), 'connect_error')
    assert.equal(err.message, 'bad-session')
  })

  test('joined payload includes time-limited TURN credentials', async () => {
    const joined = await once(client(appointment().tokens.doctor), 'joined')
    assert.equal(joined.role, 'doctor')
    const turn = joined.iceServers.find(s => s.username)
    assert.ok(turn)
    assert.deepEqual(turn.urls, config.turnUrls)
  })
})

describe('waiting room and signaling', () => {
  test('patient waits until the doctor admits them', async () => {
    const apt = appointment()
    const patient = client(apt.tokens.patient)
    const joined = await once(patient, 'joined')
    assert.equal(joined.admitted, false)
    assert.equal(joined.peerOnline, false)

    const doctor = client(apt.tokens.doctor)
    const doctorJoined = await once(doctor, 'joined')
    assert.equal(doctorJoined.peerOnline, true)
    assert.equal(doctorJoined.admitted, false)

    // Signals before admission are dropped.
    patient.emit('signal', { description: { type: 'offer', sdp: 'v=0' } })
    await never(doctor, 'signal')

    const doctorReady = once(doctor, 'call-ready')
    const patientReady = once(patient, 'call-ready')
    doctor.emit('admit')
    assert.deepEqual(await doctorReady, { peerSessionId: patient.auth.sessionId, polite: false })
    assert.deepEqual(await patientReady, { peerSessionId: doctor.auth.sessionId, polite: true })
  })

  test('patient cannot admit themselves', async () => {
    const { patient } = await joinedPair()
    patient.emit('admit')
    await never(patient, 'call-ready')
  })

  test('relays only whitelisted signal fields to the other participant', async () => {
    const { doctor, patient } = await joinedPair()
    doctor.emit('admit')
    await once(patient, 'call-ready')

    const received = once(doctor, 'signal')
    patient.emit('signal', { description: { type: 'offer', sdp: 'v=0', evil: 1 }, extra: 'x' })
    assert.deepEqual(await received, { description: { type: 'offer', sdp: 'v=0' } })

    patient.emit('signal', { description: { type: 'bogus', sdp: 'v=0' } })
    patient.emit('signal', { description: { type: 'offer', sdp: 'x'.repeat(70 * 1024) } })
    await never(doctor, 'signal')
  })

  test('a second connection for the same role replaces the first', async () => {
    const apt = appointment()
    const first = client(apt.tokens.doctor)
    await once(first, 'joined')
    const replaced = once(first, 'session-replaced')
    const second = client(apt.tokens.doctor)
    await once(second, 'joined')
    await replaced
  })

  test('peer is told offline immediately and left after the grace period', async () => {
    const { doctor, patient } = await joinedPair()
    const offline = once(doctor, 'peer-offline')
    const left = once(doctor, 'peer-left')
    patient.disconnect()
    await offline
    await left
  })

  test('reconnecting within the grace period resumes the admitted call', async () => {
    const { apt, doctor, patient } = await joinedPair()
    doctor.emit('admit')
    await once(patient, 'call-ready')
    const sessionId = patient.auth.sessionId
    patient.disconnect()
    await once(doctor, 'peer-offline')

    const ready = once(doctor, 'call-ready')
    const back = client(apt.tokens.patient, sessionId)
    const joined = await once(back, 'joined')
    assert.equal(joined.admitted, true)
    assert.equal((await ready).peerSessionId, sessionId)
    await never(doctor, 'peer-left', 300)
  })

  test('patient hang-up requires re-admission', async () => {
    const { apt, doctor, patient } = await joinedPair()
    doctor.emit('admit')
    await once(patient, 'call-ready')
    const left = once(doctor, 'peer-left')
    patient.emit('hang-up')
    await left

    const again = client(apt.tokens.patient)
    const joined = await once(again, 'joined')
    assert.equal(joined.admitted, false)
  })

  test('doctor ending the consultation closes the room for good', async () => {
    const { apt, doctor, patient } = await joinedPair()
    const ended = once(patient, 'call-ended')
    doctor.emit('hang-up')
    assert.deepEqual(await ended, { reason: 'doctor-ended' })
    const err = await once(client(apt.tokens.patient), 'connect_error')
    assert.equal(err.message, 'ended')
    assert.ok(auditEntries.some(e => e.event === 'appointment-ended' && e.appointmentId === apt.appointmentId))
  })

  test('audit log never contains tokens or SDP', () => {
    const dump = JSON.stringify(auditEntries)
    assert.ok(!dump.includes('v=0'))
    assert.ok(!dump.includes('eyJ'))
  })
})

describe('HTTP API', () => {
  test('creating appointments requires the admin API key', async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ startsAt: new Date().toISOString(), durationMinutes: 15 }),
    })
    assert.equal(res.status, 401)
  })

  test('creates an appointment with doctor and patient links', async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminApiKey}` },
      body: JSON.stringify({ startsAt: new Date().toISOString(), durationMinutes: 15 }),
    })
    assert.equal(res.status, 201)
    const body = await res.json()
    const doctorToken = body.doctorUrl.split('#token=')[1]
    const patientToken = body.patientUrl.split('#token=')[1]
    assert.equal(ctx.auth.verifyToken(doctorToken).role, 'doctor')
    assert.equal(ctx.auth.verifyToken(patientToken).appointmentId, body.appointmentId)
  })

  test('rejects invalid appointment input', async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminApiKey}` },
      body: JSON.stringify({ startsAt: 'nope', durationMinutes: 15 }),
    })
    assert.equal(res.status, 400)
  })

  test('consult page sends strict security headers', async () => {
    const res = await fetch(`${baseUrl}/consult`)
    assert.equal(res.status, 200)
    const csp = res.headers.get('content-security-policy')
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('x-powered-by'), null)
  })

  test('dev routes are disabled when configured off', async () => {
    const res = await fetch(`${baseUrl}/dev/new`)
    assert.equal(res.status, 404)
  })
})

describe('unit', () => {
  test('TURN credentials follow the coturn REST API format', () => {
    const now = 1_700_000_000_000
    const { username, credential, expiry } = createTurnCredentials('secret', 'apt:doctor', 600, now)
    assert.equal(expiry, 1_700_000_600)
    assert.equal(username, '1700000600:apt:doctor')
    assert.equal(credential, crypto.createHmac('sha1', 'secret').update(username).digest('base64'))
  })

  test('sanitizeSignal accepts candidates and end-of-candidates', () => {
    assert.deepEqual(sanitizeSignal({ candidate: null }), { candidate: null })
    assert.deepEqual(
      sanitizeSignal({ candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } }),
      { candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null } },
    )
    assert.equal(sanitizeSignal({ candidate: { candidate: 5 } }), null)
    assert.equal(sanitizeSignal('x'), null)
  })
})
