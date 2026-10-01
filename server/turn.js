const crypto = require('crypto')

// Time-limited TURN credentials per the coturn "TURN REST API" (use-auth-secret):
// username = "<expiry unix ts>:<id>", credential = base64(HMAC-SHA1(secret, username)).
function createTurnCredentials(secret, id, ttlSeconds, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + ttlSeconds
  const username = `${expiry}:${id}`
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64')
  return { username, credential, expiry }
}

function getIceServers(config, id) {
  const servers = []
  if (config.stunUrls.length) servers.push({ urls: config.stunUrls })
  if (config.turnUrls.length && config.turnSecret) {
    const { username, credential } = createTurnCredentials(config.turnSecret, id, config.turnTtlSeconds)
    servers.push({ urls: config.turnUrls, username, credential })
  }
  return servers
}

module.exports = { createTurnCredentials, getIceServers }
