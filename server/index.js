const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const helmet = require('helmet')
const { rateLimit } = require('express-rate-limit')
const { Server } = require('socket.io')
const { loadConfig } = require('./config')
const { createAuth } = require('./auth')
const { createAudit } = require('./audit')
const { createSignaling } = require('./signaling')

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function createServer(config, { auditSink } = {}) {
  const auth = createAuth(config)
  const audit = createAudit({ dir: config.auditDir, retentionDays: config.auditRetentionDays, sink: auditSink })

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', config.trustProxy)
  app.set('view engine', 'ejs')
  app.set('views', path.join(__dirname, '..', 'views'))

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  }))
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(), geolocation=()')
    next()
  })
  app.use(express.static(path.join(__dirname, '..', 'public')))
  app.use(express.json({ limit: '10kb' }))

  const noStore = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
  const baseUrl = req => config.publicUrl || `${req.protocol}://${req.get('host')}`
  const linksFor = (req, appointment) => ({
    appointmentId: appointment.appointmentId,
    notBefore: appointment.notBefore.toISOString(),
    expiresAt: appointment.expiresAt.toISOString(),
    // Token lives in the URL fragment so it never reaches server logs or Referer headers.
    doctorUrl: `${baseUrl(req)}/consult#token=${appointment.tokens.doctor}`,
    patientUrl: `${baseUrl(req)}/consult#token=${appointment.tokens.patient}`,
  })

  app.get('/', noStore, (req, res) => res.render('index'))
  app.get('/consult', noStore, (req, res) => res.render('consult'))
  app.get('/healthz', (req, res) => res.json({ ok: true }))

  const apiLimiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false })
  app.post('/api/appointments', apiLimiter, noStore, (req, res) => {
    const header = req.get('authorization') || ''
    if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), config.adminApiKey)) {
      audit.log('api-auth-rejected', { ip: req.ip })
      return res.status(401).json({ error: 'unauthorized' })
    }
    const startsAt = new Date(req.body?.startsAt)
    const durationMinutes = Number(req.body?.durationMinutes)
    if (Number.isNaN(startsAt.getTime()) || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 240) {
      return res.status(400).json({ error: 'startsAt (ISO date) and durationMinutes (1-240) are required' })
    }
    const appointment = auth.createAppointment({ startsAt, durationMinutes })
    audit.log('appointment-created', { appointmentId: appointment.appointmentId })
    res.status(201).json(linksFor(req, appointment))
  })

  if (config.enableDevRoutes) {
    // Create once, then redirect: reloading the page must keep showing the same pair of links.
    const devAppointments = new Map()
    app.get('/dev/new', noStore, (req, res) => {
      const appointment = auth.createAppointment({ startsAt: new Date(), durationMinutes: 60 })
      devAppointments.set(appointment.appointmentId, appointment)
      res.redirect(303, `/dev/appointments/${appointment.appointmentId}`)
    })
    app.get('/dev/appointments/:id', noStore, (req, res) => {
      const appointment = devAppointments.get(req.params.id)
      if (!appointment) return res.status(404).send('Unknown appointment; open /dev/new to create one.')
      res.render('dev', { ...linksFor(req, appointment), shortCode: appointment.appointmentId.slice(0, 4).toUpperCase() })
    })
  }

  const server = config.tlsCert && config.tlsKey
    ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey), minVersion: 'TLSv1.2' }, app)
    : http.createServer(app)

  const io = new Server(server, {
    maxHttpBufferSize: 100 * 1024,
    pingInterval: 10000,
    pingTimeout: 10000,
  })
  // Same proxy trust rules as Express, so HTTP and signaling agree on the client IP.
  const signaling = createSignaling(io, { auth, audit, config, trustProxy: app.get('trust proxy fn') })

  return {
    app,
    server,
    io,
    auth,
    close: () => new Promise(resolve => {
      signaling.close()
      io.close(() => resolve())
    }),
  }
}

if (require.main === module) {
  const config = loadConfig()
  const { server } = createServer(config)
  const scheme = config.tlsCert ? 'https' : 'http'
  server.listen(config.port, () => {
    console.log(`Consultation server listening on ${scheme}://localhost:${config.port}`)
    if (config.enableDevRoutes) console.log(`Dev: open ${scheme}://localhost:${config.port}/dev/new to create a test appointment`)
    if (!config.turnUrls.length) console.warn('[config] No TURN configured: calls across restrictive NATs/firewalls will fail')
  })
}

module.exports = { createServer }
