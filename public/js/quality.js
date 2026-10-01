import { updateParameters } from './call.js'

const SAMPLE_INTERVAL_MS = 2000

export function classify({ rttMs, lossPct, jitterMs }) {
  if (rttMs > 400 || lossPct > 8 || jitterMs > 50) return 'poor'
  if (rttMs > 200 || lossPct > 3 || jitterMs > 30) return 'fair'
  return 'good'
}

// Samples getStats() and reports round-trip time, packet loss, jitter and bandwidth.
export class QualityMonitor extends EventTarget {
  constructor(pc) {
    super()
    this.pc = pc
    this.previous = new Map()
  }

  start() {
    this.timer = setInterval(() => this.sample().catch(() => {}), SAMPLE_INTERVAL_MS)
  }

  stop() {
    clearInterval(this.timer)
  }

  async sample() {
    if (this.pc.connectionState !== 'connected') return
    const stats = await this.pc.getStats()
    let pair = null
    let audioJitterMs = 0
    let lost = 0
    let received = 0
    let remoteLossPct = 0

    stats.forEach(report => {
      if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId)
      if (!pair && report.type === 'candidate-pair' && (report.selected || (report.nominated && report.state === 'succeeded'))) pair = report
      if (report.type === 'inbound-rtp') {
        const prev = this.previous.get(report.id)
        if (prev) {
          lost += Math.max(0, (report.packetsLost || 0) - prev.packetsLost)
          received += Math.max(0, (report.packetsReceived || 0) - prev.packetsReceived)
        }
        this.previous.set(report.id, { packetsLost: report.packetsLost || 0, packetsReceived: report.packetsReceived || 0 })
        if (report.kind === 'audio' && report.jitter) audioJitterMs = report.jitter * 1000
      }
      if (report.type === 'remote-inbound-rtp' && typeof report.fractionLost === 'number') {
        remoteLossPct = Math.max(remoteLossPct, report.fractionLost * 100)
      }
    })

    const localCandidate = pair && stats.get(pair.localCandidateId)
    const inboundLossPct = lost + received > 0 ? (lost / (lost + received)) * 100 : 0
    const sample = {
      rttMs: pair && pair.currentRoundTripTime ? pair.currentRoundTripTime * 1000 : 0,
      lossPct: Math.max(inboundLossPct, remoteLossPct),
      jitterMs: audioJitterMs,
      outKbps: pair && pair.availableOutgoingBitrate ? pair.availableOutgoingBitrate / 1000 : null,
      relayed: !!localCandidate && localCandidate.candidateType === 'relay',
    }
    sample.level = classify(sample)
    this.dispatchEvent(new CustomEvent('sample', { detail: sample }))
  }
}

// Steps the outgoing video down when the link is poor and back up when it recovers.
// Resolution is held as long as possible because clinical detail matters more than frame rate.
const VIDEO_STEPS = [
  { maxBitrate: 1_500_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
  { maxBitrate: 800_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
  { maxBitrate: 450_000, maxFramerate: 20, scaleResolutionDownBy: 1 },
  { maxBitrate: 250_000, maxFramerate: 15, scaleResolutionDownBy: 1.5 },
  { maxBitrate: 120_000, maxFramerate: 10, scaleResolutionDownBy: 2 },
]
const POOR_SAMPLES_TO_STEP_DOWN = 3
const GOOD_SAMPLES_TO_STEP_UP = 5
const POOR_SAMPLES_TO_SUGGEST_AUDIO_ONLY = 8

export class VideoAdapter extends EventTarget {
  constructor(getSender) {
    super()
    this.getSender = getSender
    this.step = 0
    this.poorStreak = 0
    this.goodStreak = 0
  }

  onSample(level) {
    if (level === 'poor') {
      this.poorStreak += 1
      this.goodStreak = 0
      const atBottom = this.step === VIDEO_STEPS.length - 1
      if (!atBottom && this.poorStreak >= POOR_SAMPLES_TO_STEP_DOWN) {
        this.setStep(this.step + 1)
        this.poorStreak = 0
      } else if (atBottom && this.poorStreak >= POOR_SAMPLES_TO_SUGGEST_AUDIO_ONLY) {
        this.poorStreak = 0
        this.dispatchEvent(new CustomEvent('suggest-audio-only'))
      }
    } else if (level === 'good') {
      this.goodStreak += 1
      this.poorStreak = 0
      if (this.step > 0 && this.goodStreak >= GOOD_SAMPLES_TO_STEP_UP) {
        this.setStep(this.step - 1)
        this.goodStreak = 0
      }
    } else {
      this.poorStreak = 0
      this.goodStreak = 0
    }
  }

  setStep(step) {
    this.step = step
    return this.apply()
  }

  apply() {
    const sender = this.getSender()
    if (!sender || !sender.track) return Promise.resolve()
    const target = VIDEO_STEPS[this.step]
    return updateParameters(sender, params => {
      params.degradationPreference = 'maintain-resolution'
      Object.assign(params.encodings[0], target)
    })
  }
}
