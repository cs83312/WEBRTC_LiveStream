require('dotenv').config()
const crypto = require('crypto')

const isProduction = process.env.NODE_ENV === 'production'

function secret(name) {
  const value = process.env[name]
  if (value) return value
  if (isProduction) throw new Error(`${name} must be set in production`)
  console.warn(`[config] ${name} not set, using a random value (dev only)`)
  return crypto.randomBytes(32).toString('hex')
}

function list(name) {
  return (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean)
}

function loadConfig(overrides = {}) {
  const config = {
    isProduction,
    port: Number(process.env.PORT || 8009),
    publicUrl: process.env.PUBLIC_URL || '',
    tlsCert: process.env.TLS_CERT || '',
    tlsKey: process.env.TLS_KEY || '',
    trustProxy: process.env.TRUST_PROXY === 'true',
    jwtSecret: secret('JWT_SECRET'),
    adminApiKey: secret('ADMIN_API_KEY'),
    turnSecret: process.env.TURN_SECRET || '',
    turnUrls: list('TURN_URLS'),
    stunUrls: list('STUN_URLS'),
    turnTtlSeconds: Number(process.env.TURN_TTL_SECONDS || 600),
    // 'relay' forces all media through TURN: peers never learn each other's IP addresses.
    iceTransportPolicy: process.env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all',
    // How long a disconnected participant keeps their slot before the peer is told they left.
    reconnectGraceMs: Number(process.env.RECONNECT_GRACE_MS || 30000),
    connectionsPerIpPerMinute: Number(process.env.CONNECTIONS_PER_IP_PER_MINUTE || 30),
    // Tokens are valid from (start - earlyJoin) to (end + lateLeave).
    earlyJoinMinutes: Number(process.env.EARLY_JOIN_MINUTES || 30),
    lateLeaveMinutes: Number(process.env.LATE_LEAVE_MINUTES || 30),
    auditDir: process.env.AUDIT_DIR === undefined ? 'logs' : process.env.AUDIT_DIR,
    auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS || 180),
    enableDevRoutes: !isProduction && process.env.ENABLE_DEV_ROUTES !== 'false',
    ...overrides,
  }

  if (config.turnUrls.length && !config.turnSecret) {
    if (isProduction) throw new Error('TURN_SECRET must be set when TURN_URLS is configured')
    console.warn('[config] TURN_URLS set without TURN_SECRET; TURN will be ignored')
  }
  if (isProduction && !(config.tlsCert && config.tlsKey) && !config.trustProxy) {
    throw new Error('Production requires TLS_CERT/TLS_KEY or TRUST_PROXY=true behind a TLS-terminating proxy')
  }
  return config
}

module.exports = { loadConfig }
