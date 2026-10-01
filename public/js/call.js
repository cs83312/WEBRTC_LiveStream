// One peer-to-peer consultation call using the "perfect negotiation" pattern.
// The doctor (impolite) creates the transceivers and makes the first offer; the patient (polite)
// attaches its tracks to the transceivers created by that offer. Either side may later
// renegotiate (e.g. ICE restart) and offer collisions are resolved by the polite side rolling back.

const DISCONNECTED_RESTART_DELAY_MS = 3000
const MAX_RESTART_ATTEMPTS = 8
const HEARTBEAT_INTERVAL_MS = 2000
const HEARTBEAT_STALL_MS = 6000

export class Call extends EventTarget {
  constructor({ polite, peerSessionId, iceServers, iceTransportPolicy = 'all', sendSignal, fetchIceServers, localTracks }) {
    super()
    this.polite = polite
    this.peerSessionId = peerSessionId
    this.sendSignal = sendSignal
    this.fetchIceServers = fetchIceServers
    this.localTracks = { audio: localTracks.audio || null, video: localTracks.video || null }
    this.makingOffer = false
    this.ignoreOffer = false
    this.isSettingRemoteAnswerPending = false
    this.signalQueue = Promise.resolve()
    this.restartAttempts = 0
    this.closed = false
    this.channel = null
    this.lastPeerMessageAt = 0
    this.peerStalled = false

    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' })
    this.remoteStream = new MediaStream()
    this.wirePeerConnection()

    if (!polite) {
      for (const kind of ['audio', 'video']) {
        this.pc.addTransceiver(this.localTracks[kind] || kind, { direction: 'sendrecv' })
      }
      this.setupChannel(this.pc.createDataChannel('control', { ordered: true }))
    }
  }

  wirePeerConnection() {
    const pc = this.pc

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true
        await pc.setLocalDescription()
        this.sendSignal({ description: pc.localDescription })
      } catch (err) {
        console.error('[call] negotiation failed', err)
      } finally {
        this.makingOffer = false
      }
    }

    pc.onicecandidate = ({ candidate }) => this.sendSignal({ candidate: candidate ? candidate.toJSON() : null })

    pc.ontrack = ({ track }) => {
      for (const old of this.remoteStream.getTracks().filter(t => t.kind === track.kind)) this.remoteStream.removeTrack(old)
      this.remoteStream.addTrack(track)
      this.emit('remote-stream', this.remoteStream)
    }

    // Surfaces TURN misconfiguration (bad credentials, unreachable server) in the console.
    pc.onicecandidateerror = e => console.warn('[call] ICE candidate error', e.errorCode, e.errorText, e.url)

    pc.ondatachannel = ({ channel }) => this.setupChannel(channel)

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      clearTimeout(this.disconnectTimer)
      if (state === 'failed') {
        this.restartIce()
      } else if (state === 'disconnected') {
        // Often recovers on its own (e.g. Wi-Fi roaming); restart only if it persists.
        this.disconnectTimer = setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') this.restartIce()
        }, DISCONNECTED_RESTART_DELAY_MS)
      } else if (state === 'connected' || state === 'completed') {
        this.restartAttempts = 0
        clearTimeout(this.restartTimer)
        this.restarting = false
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.configureSenders()
      this.emit('state', pc.connectionState)
    }
  }

  setupChannel(channel) {
    this.channel = channel
    channel.onopen = () => {
      this.lastPeerMessageAt = Date.now()
      this.sendControl({ t: 'media', ...this.mediaState() })
      clearInterval(this.heartbeat)
      this.heartbeat = setInterval(() => this.checkHeartbeat(), HEARTBEAT_INTERVAL_MS)
    }
    channel.onmessage = ({ data }) => {
      this.lastPeerMessageAt = Date.now()
      if (this.peerStalled) {
        this.peerStalled = false
        this.emit('peer-stalled', false)
      }
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (msg.t !== 'ping') this.emit('control', msg)
    }
    channel.onclose = () => clearInterval(this.heartbeat)
  }

  checkHeartbeat() {
    this.sendControl({ t: 'ping' })
    const stalled = this.pc.connectionState === 'connected' && Date.now() - this.lastPeerMessageAt > HEARTBEAT_STALL_MS
    if (stalled && !this.peerStalled) {
      this.peerStalled = true
      this.emit('peer-stalled', true)
    }
  }

  sendControl(msg) {
    if (this.channel && this.channel.readyState === 'open') this.channel.send(JSON.stringify(msg))
  }

  mediaState() {
    const { audio, video } = this.localTracks
    return { audio: !!audio && audio.enabled, video: !!video && video.readyState === 'live' }
  }

  notifyMediaState() {
    this.sendControl({ t: 'media', ...this.mediaState() })
  }

  handleSignal(msg) {
    this.signalQueue = this.signalQueue
      .then(() => this.processSignal(msg))
      .catch(err => console.error('[call] signal handling failed', err))
  }

  async processSignal({ description, candidate }) {
    if (this.closed) return
    const pc = this.pc
    if (description) {
      const readyForOffer = !this.makingOffer && (pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending)
      const offerCollision = description.type === 'offer' && !readyForOffer
      this.ignoreOffer = !this.polite && offerCollision
      if (this.ignoreOffer) return

      this.isSettingRemoteAnswerPending = description.type === 'answer'
      await pc.setRemoteDescription(description)
      this.isSettingRemoteAnswerPending = false

      if (description.type === 'offer') {
        await this.attachLocalTracks()
        await pc.setLocalDescription()
        this.sendSignal({ description: pc.localDescription })
      }
    } else if (candidate !== undefined) {
      try {
        await pc.addIceCandidate(candidate)
      } catch (err) {
        if (!this.ignoreOffer) console.warn('[call] addIceCandidate failed', err)
      }
    }
  }

  transceiverFor(kind) {
    return this.pc.getTransceivers().find(t => !t.stopped && t.receiver.track && t.receiver.track.kind === kind)
  }

  // Polite side: bind local tracks to the transceivers the remote offer created.
  async attachLocalTracks() {
    for (const kind of ['audio', 'video']) {
      const transceiver = this.transceiverFor(kind)
      if (!transceiver) continue
      transceiver.direction = 'sendrecv'
      if (transceiver.sender.track !== this.localTracks[kind]) {
        await transceiver.sender.replaceTrack(this.localTracks[kind])
      }
    }
  }

  // Swap a local track without renegotiation (device switch, camera on/off).
  async setLocalTrack(kind, track) {
    this.localTracks[kind] = track
    const transceiver = this.transceiverFor(kind)
    if (transceiver) {
      await transceiver.sender.replaceTrack(track)
      await this.configureSenders()
    }
    this.notifyMediaState()
  }

  async configureSenders() {
    const audio = this.transceiverFor('audio')
    if (audio) {
      await updateParameters(audio.sender, params => {
        // Voice is the most important signal in a consultation: protect it first.
        for (const enc of params.encodings) {
          enc.priority = 'high'
          enc.networkPriority = 'high'
        }
      })
    }
    this.dispatchEvent(new CustomEvent('senders-ready'))
  }

  async restartIce() {
    if (this.closed || this.restarting) return
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.emit('failed')
      return
    }
    this.restarting = true
    this.restartAttempts += 1
    this.emit('restarting', this.restartAttempts)
    try {
      // TURN credentials are short-lived; fetch fresh ones before gathering again.
      const iceServers = await this.fetchIceServers()
      if (iceServers && !this.closed) this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers })
    } catch (err) {
      console.warn('[call] could not refresh ICE servers', err)
    }
    if (this.closed) return
    this.pc.restartIce()
    clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restarting = false
      const state = this.pc.iceConnectionState
      if (state !== 'connected' && state !== 'completed') this.restartIce()
    }, Math.min(5000 * this.restartAttempts, 15000))
  }

  // Called when signaling comes back after an outage: resend a stuck offer or restart ICE.
  resume() {
    if (this.closed) return
    const pc = this.pc
    if (pc.signalingState === 'have-local-offer' && pc.localDescription) {
      this.sendSignal({ description: pc.localDescription })
    }
    if (pc.connectionState !== 'connected') {
      this.restartAttempts = 0
      this.restarting = false
      this.restartIce()
    }
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.disconnectTimer)
    clearTimeout(this.restartTimer)
    clearInterval(this.heartbeat)
    if (this.channel) this.channel.close()
    this.pc.close()
  }
}

export async function updateParameters(sender, mutate) {
  try {
    const params = sender.getParameters()
    if (!params.encodings || !params.encodings.length) return
    mutate(params)
    await sender.setParameters(params)
  } catch (err) {
    console.warn('[call] setParameters failed', err)
  }
}
