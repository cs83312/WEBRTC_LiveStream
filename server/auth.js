const crypto = require('crypto')
const jwt = require('jsonwebtoken')

const ISSUER = 'webrtc-consult'
const AUDIENCE = 'consult-room'
const ROLES = ['doctor', 'patient']

function createAuth(config) {
  function issueToken({ appointmentId, role, notBefore, expiresAt }) {
    if (!ROLES.includes(role)) throw new Error(`invalid role: ${role}`)
    return jwt.sign(
      {
        apt: appointmentId,
        role,
        nbf: Math.floor(notBefore.getTime() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
      },
      config.jwtSecret,
      { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, jwtid: crypto.randomUUID() },
    )
  }

  // Throws on invalid, expired or not-yet-valid tokens.
  function verifyToken(token) {
    if (typeof token !== 'string' || token.length > 2048) throw new Error('malformed token')
    const claims = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    if (!ROLES.includes(claims.role) || typeof claims.apt !== 'string') throw new Error('invalid claims')
    return { appointmentId: claims.apt, role: claims.role, expiresAt: claims.exp * 1000 }
  }

  function createAppointment({ startsAt, durationMinutes }) {
    const appointmentId = crypto.randomUUID()
    const notBefore = new Date(startsAt.getTime() - config.earlyJoinMinutes * 60000)
    const expiresAt = new Date(startsAt.getTime() + (durationMinutes + config.lateLeaveMinutes) * 60000)
    const tokens = {}
    for (const role of ROLES) tokens[role] = issueToken({ appointmentId, role, notBefore, expiresAt })
    return { appointmentId, notBefore, expiresAt, tokens }
  }

  return { issueToken, verifyToken, createAppointment }
}

module.exports = { createAuth, ROLES }
