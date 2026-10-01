const { getIceServers } = require('./turn')

const MAX_SIGNAL_BYTES = 64 * 1024
const MAX_TIMEOUT_MS = 2 ** 31 - 1
const QUALITY_REPORT_INTERVAL_MS = 10000

// Whitelist the fields relayed between peers so arbitrary payloads never pass through.
function sanitizeSignal(msg) {
  if (!msg || typeof msg !== 'object') return null
  let size
  try { size = Buffer.byteLength(JSON.stringify(msg)) } catch { return null }
  if (size > MAX_SIGNAL_BYTES) return null

  if (msg.description) {
    const { type, sdp } = msg.description
    if (!['offer', 'answer', 'rollback'].includes(type)) return null
    if (type !== 'rollback' && typeof sdp !== 'string') return null
    return { description: { type, sdp: sdp || '' } }
  }
  if ('candidate' in msg) {
    const c = msg.candidate
    if (c === null) return { candidate: null }
    if (typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 2048) return null
    return {
      candidate: {
        candidate: c.candidate,
        sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : null,
        sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
        usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment : null,
      },
    }
  }
  return null
}

function sanitizeQuality(report) {
  if (!report || typeof report !== 'object') return null
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)
  const level = ['good', 'fair', 'poor'].includes(report.level) ? report.level : null
  return {
    level,
    rttMs: num(report.rttMs),
    lossPct: num(report.lossPct),
    jitterMs: num(report.jitterMs),
    outKbps: num(report.outKbps),
    relayed: report.relayed === true,
  }
}

function clientIp(socket, trustProxy) {
  const forwarded = socket.handshake.headers['x-forwarded-for']
  if (trustProxy && typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  return socket.handshake.address
}

function createSignaling(io, { auth, audit, config }) {
  const rooms = new Map()
  const endedAppointments = new Map() // appointmentId -> token expiry (ms)
  const connectionCounts = new Map() // ip -> { count, windowStart }

  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [id, exp] of endedAppointments) if (exp < now) endedAppointments.delete(id)
    for (const [ip, entry] of connectionCounts) if (now - entry.windowStart > 60000) connectionCounts.delete(ip)
  }, 60000)
  sweeper.unref()

  function getRoom(appointmentId) {
    let room = rooms.get(appointmentId)
    if (!room) {
      room = {
        id: appointmentId,
        sockets: { doctor: null, patient: null },
        sessions: { doctor: null, patient: null },
        graceTimers: { doctor: null, patient: null },
        admitted: false,
        callStartedAt: null,
      }
      rooms.set(appointmentId, room)
    }
    return room
  }

  function maybeDeleteRoom(room) {
    const idle = ['doctor', 'patient'].every(r => !room.sockets[r] && !room.graceTimers[r])
    if (idle) rooms.delete(room.id)
  }

  function startCall(room) {
    const { doctor, patient } = room.sockets
    if (!room.admitted || !doctor || !patient) return
    // Doctor is the impolite peer, patient the polite one (perfect negotiation).
    doctor.emit('call-ready', { peerSessionId: room.sessions.patient, polite: false })
    patient.emit('call-ready', { peerSessionId: room.sessions.doctor, polite: true })
    if (!room.callStartedAt) {
      room.callStartedAt = Date.now()
      audit.log('call-started', { appointmentId: room.id })
    }
  }

  function endAppointment(room, expiresAt, reason) {
    endedAppointments.set(room.id, expiresAt)
    const durationSec = room.callStartedAt ? Math.round((Date.now() - room.callStartedAt) / 1000) : 0
    audit.log('appointment-ended', { appointmentId: room.id, reason, durationSec })
    for (const role of ['doctor', 'patient']) {
      clearTimeout(room.graceTimers[role])
      room.graceTimers[role] = null
      const s = room.sockets[role]
      room.sockets[role] = null
      if (s) {
        s.emit('call-ended', { reason })
        s.disconnect(true)
      }
    }
    rooms.delete(room.id)
  }

  io.use((socket, next) => {
    const ip = clientIp(socket, config.trustProxy)
    const now = Date.now()
    const entry = connectionCounts.get(ip)
    if (!entry || now - entry.windowStart > 60000) connectionCounts.set(ip, { count: 1, windowStart: now })
    else if (++entry.count > config.connectionsPerIpPerMinute) return next(new Error('rate-limited'))

    const { token, sessionId } = socket.handshake.auth || {}
    let claims
    try {
      claims = auth.verifyToken(token)
    } catch (err) {
      audit.log('auth-rejected', { ip, reason: err.name || 'invalid' })
      return next(new Error('unauthorized'))
    }
    if (endedAppointments.has(claims.appointmentId)) return next(new Error('ended'))
    if (typeof sessionId !== 'string' || !/^[\w-]{8,64}$/.test(sessionId)) return next(new Error('bad-session'))
    socket.data = { ...claims, sessionId, ip }
    next()
  })

  io.on('connection', socket => {
    const { appointmentId, role, sessionId, expiresAt, ip } = socket.data
    const other = role === 'doctor' ? 'patient' : 'doctor'
    const room = getRoom(appointmentId)

    const previous = room.sockets[role]
    if (previous) {
      audit.log('session-replaced', { appointmentId, role })
      room.sockets[role] = null
      previous.emit('session-replaced')
      previous.disconnect(true)
    }
    clearTimeout(room.graceTimers[role])
    room.graceTimers[role] = null
    room.sockets[role] = socket
    room.sessions[role] = sessionId
    audit.log('joined', { appointmentId, role, ip })

    const expiryTimer = setTimeout(() => {
      socket.emit('token-expired')
      socket.disconnect(true)
    }, Math.min(Math.max(expiresAt - Date.now(), 0), MAX_TIMEOUT_MS))

    // Token bucket: 50 msg/s sustained, bursts up to 200 (ICE candidates arrive in bursts).
    let tokens = 200
    let lastRefill = Date.now()
    let dropped = 0
    function allow() {
      const now = Date.now()
      tokens = Math.min(200, tokens + ((now - lastRefill) / 1000) * 50)
      lastRefill = now
      if (tokens < 1) return false
      tokens -= 1
      return true
    }
    function on(event, handler) {
      socket.on(event, (...args) => {
        if (!allow()) {
          if (++dropped > 100) socket.disconnect(true)
          return
        }
        try {
          handler(...args)
        } catch (err) {
          console.error(`[signaling] ${event} handler failed`, err)
        }
      })
    }

    socket.emit('joined', {
      role,
      admitted: room.admitted,
      peerOnline: !!room.sockets[other],
      peerSessionId: room.sockets[other] ? room.sessions[other] : null,
      iceServers: getIceServers(config, `${appointmentId}:${role}`),
      iceTransportPolicy: config.iceTransportPolicy,
    })
    const peer = room.sockets[other]
    if (peer) peer.emit('peer-online', { role, admitted: room.admitted, peerSessionId: sessionId })
    startCall(room)

    on('admit', () => {
      if (role !== 'doctor' || room.admitted) return
      room.admitted = true
      audit.log('patient-admitted', { appointmentId })
      startCall(room)
    })

    on('signal', msg => {
      if (!room.admitted) return
      const clean = sanitizeSignal(msg)
      const target = room.sockets[other]
      if (clean && target) target.emit('signal', clean)
    })

    on('get-ice-servers', ack => {
      if (typeof ack === 'function') ack(getIceServers(config, `${appointmentId}:${role}`))
    })

    let lastQualityAt = 0
    on('quality', report => {
      const now = Date.now()
      if (now - lastQualityAt < QUALITY_REPORT_INTERVAL_MS) return
      const clean = sanitizeQuality(report)
      if (!clean) return
      lastQualityAt = now
      audit.log('quality', { appointmentId, role, ...clean })
    })

    on('hang-up', () => {
      if (role === 'doctor') return endAppointment(room, expiresAt, 'doctor-ended')
      // Patient leaving requires the doctor to admit them again.
      room.admitted = false
      room.sockets.patient = null
      room.sessions.patient = null
      audit.log('patient-left', { appointmentId })
      const target = room.sockets.doctor
      if (target) target.emit('peer-left')
      socket.disconnect(true)
      maybeDeleteRoom(room)
    })

    socket.on('disconnect', reason => {
      clearTimeout(expiryTimer)
      if (room.sockets[role] !== socket) return
      room.sockets[role] = null
      audit.log('disconnected', { appointmentId, role, reason })
      const target = room.sockets[other]
      if (target) target.emit('peer-offline')
      // Keep the slot (and the peer's media connection) alive while signaling reconnects.
      room.graceTimers[role] = setTimeout(() => {
        room.graceTimers[role] = null
        if (room.sockets[role]) return
        room.sessions[role] = null
        audit.log('left', { appointmentId, role })
        const t = room.sockets[other]
        if (t) t.emit('peer-left')
        maybeDeleteRoom(room)
      }, config.reconnectGraceMs)
    })
  })

  return {
    rooms,
    close() {
      clearInterval(sweeper)
      for (const room of rooms.values()) for (const t of Object.values(room.graceTimers)) clearTimeout(t)
    },
  }
}

module.exports = { createSignaling, sanitizeSignal, sanitizeQuality }
