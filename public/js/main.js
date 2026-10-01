import { Call } from './call.js'
import { getLocalStream, getAudioTrack, getVideoTrack, listDevices, describeMediaError } from './media.js'
import { QualityMonitor, VideoAdapter } from './quality.js'

const $ = id => document.getElementById(id)
const TOKEN_KEY = 'consult-token'
const QUALITY_REPORT_INTERVAL_MS = 15000
const ROLE_LABEL = { doctor: '醫師', patient: '病患' }

// --- Token & identity ------------------------------------------------------

function readToken() {
  const match = /[#&]token=([^&]+)/.exec(location.hash)
  if (match) {
    sessionStorage.setItem(TOKEN_KEY, match[1])
    // Remove the token from the address bar and history.
    history.replaceState(null, '', location.pathname)
    return match[1]
  }
  return sessionStorage.getItem(TOKEN_KEY)
}

// Decoded only to pick the UI; the server verifies the signature.
function decodeClaims(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(decodeURIComponent(escape(atob(payload))))
  } catch {
    return null
  }
}

const token = readToken()
const claims = token && decodeClaims(token)
const role = claims && claims.role
const isDoctor = role === 'doctor'
// New per page load: a reload means a brand-new peer connection on this side.
const sessionId = crypto.randomUUID()

// --- State -----------------------------------------------------------------

let socket = null
let localStream = new MediaStream()
let iceServers = []
let iceTransportPolicy = 'all'
let admitted = false
let peerOnline = false
let call = null
let monitor = null
let adapter = null
let lastSample = null
let qualityReportTimer = null
let callStartedAt = null
let timerInterval = null
let wakeLock = null
let ended = false
const selected = { mic: '', cam: '', speaker: '' }

// --- UI helpers ------------------------------------------------------------

function showScreen(name) {
  for (const s of ['consent', 'call', 'ended']) $(`screen-${s}`).hidden = s !== name
}

function setStatus(text, state) {
  $('conn-status').textContent = text
  $('conn-status').dataset.state = state
}

function showBanner(text, action) {
  $('banner-text').textContent = text
  const btn = $('banner-action')
  btn.hidden = !action
  if (action) {
    btn.textContent = action.label
    btn.onclick = action.onClick
  }
  $('banner').hidden = false
}

function hideBanner() {
  $('banner').hidden = true
}

function setLobby(text, { showAdmit = false } = {}) {
  $('lobby-text').textContent = text
  $('btn-admit').hidden = !showAdmit
  $('remote-placeholder').hidden = false
}

function updateLobby() {
  if (call) return
  if (isDoctor) {
    if (!peerOnline) setLobby('等待病患進入候診室…')
    else if (!admitted) setLobby('病患已在候診室', { showAdmit: true })
    else setLobby('建立連線中…')
  } else {
    if (!admitted) setLobby('您已在候診室，請稍候醫師允許進入。')
    else if (!peerOnline) setLobby('等待醫師連線…')
    else setLobby('建立連線中…')
  }
}

function endSession(title, text) {
  if (ended) return
  ended = true
  teardownCall()
  if (socket) socket.disconnect()
  for (const t of localStream.getTracks()) t.stop()
  sessionStorage.removeItem(TOKEN_KEY)
  if (wakeLock) wakeLock.release().catch(() => {})
  $('ended-title').textContent = title
  $('ended-text').textContent = text || ''
  hideBanner()
  setStatus('已結束', 'idle')
  showScreen('ended')
}

function startTimer() {
  if (callStartedAt) return
  callStartedAt = Date.now()
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - callStartedAt) / 1000)
    $('call-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }, 1000)
}

function renderControls() {
  const audio = localStream.getAudioTracks()[0]
  const video = localStream.getVideoTracks()[0]
  const micOn = !!audio && audio.enabled
  const camOn = !!video && video.readyState === 'live'
  $('btn-mic').textContent = micOn ? '麥克風 開' : '麥克風 關'
  $('btn-mic').setAttribute('aria-pressed', String(micOn))
  $('btn-cam').textContent = camOn ? '鏡頭 開' : '鏡頭 關'
  $('btn-cam').setAttribute('aria-pressed', String(camOn))
  $('local-video').hidden = !camOn
}

// --- Media -----------------------------------------------------------------

function replaceLocalTrack(kind, track) {
  for (const old of localStream.getTracks().filter(t => t.kind === kind)) {
    old.stop()
    localStream.removeTrack(old)
  }
  if (track) {
    localStream.addTrack(track)
    watchTrack(track)
  }
  $('local-video').srcObject = localStream
  renderControls()
  if (call) return call.setLocalTrack(kind, track)
}

// If a device is unplugged, fall back to the default device automatically.
function watchTrack(track) {
  track.onended = async () => {
    if (ended || !localStream.getTracks().includes(track)) return
    try {
      const replacement = track.kind === 'audio' ? await getAudioTrack() : await getVideoTrack()
      await replaceLocalTrack(track.kind, replacement)
      showBanner(track.kind === 'audio' ? '麥克風已中斷，已切換至預設麥克風。' : '鏡頭已中斷，已切換至預設鏡頭。')
      setTimeout(hideBanner, 5000)
    } catch {
      await replaceLocalTrack(track.kind, null)
      showBanner(track.kind === 'audio' ? '找不到可用的麥克風。' : '鏡頭已中斷，已改為純語音。')
    }
  }
}

async function toggleCamera() {
  const video = localStream.getVideoTracks()[0]
  if (video && video.readyState === 'live') return replaceLocalTrack('video', null)
  try {
    await replaceLocalTrack('video', await getVideoTrack(selected.cam))
  } catch (err) {
    showBanner(describeMediaError(err))
  }
}

function toggleMic() {
  const audio = localStream.getAudioTracks()[0]
  if (!audio) return
  audio.enabled = !audio.enabled
  renderControls()
  if (call) call.notifyMediaState()
}

async function fillDeviceSelects() {
  const { mics, cams, speakers } = await listDevices()
  const fill = (select, devices, current, fallback) => {
    select.replaceChildren(...devices.map((d, i) => {
      const opt = document.createElement('option')
      opt.value = d.deviceId
      opt.textContent = d.label || `${fallback} ${i + 1}`
      opt.selected = d.deviceId === current
      return opt
    }))
  }
  const currentMic = localStream.getAudioTracks()[0]?.getSettings().deviceId || selected.mic
  const currentCam = localStream.getVideoTracks()[0]?.getSettings().deviceId || selected.cam
  fill($('select-mic'), mics, currentMic, '麥克風')
  fill($('select-cam'), cams, currentCam, '鏡頭')
  const canChooseSpeaker = 'setSinkId' in HTMLMediaElement.prototype && speakers.length > 0
  $('speaker-row').hidden = !canChooseSpeaker
  if (canChooseSpeaker) fill($('select-speaker'), speakers, selected.speaker, '喇叭')
}

// --- Call lifecycle --------------------------------------------------------

function fetchIceServers() {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) return reject(new Error('signaling offline'))
    socket.timeout(3000).emit('get-ice-servers', (err, servers) => {
      if (err) return reject(err)
      iceServers = servers
      resolve(servers)
    })
  })
}

function startCall({ peerSessionId, polite }) {
  if (call && call.peerSessionId === peerSessionId) {
    // Same remote page as before: our signaling reconnected, the media path may still be fine.
    call.resume()
    if (call.pc.connectionState === 'connected') setStatus('通話中', 'ok')
    return
  }
  teardownCall()

  call = new Call({
    polite,
    peerSessionId,
    iceServers,
    iceTransportPolicy,
    sendSignal: msg => socket.emit('signal', msg),
    fetchIceServers,
    localTracks: { audio: localStream.getAudioTracks()[0], video: localStream.getVideoTracks()[0] },
  })

  const remoteVideo = $('remote-video')
  call.addEventListener('remote-stream', ({ detail }) => {
    remoteVideo.srcObject = detail
    remoteVideo.play().catch(() => showBanner('瀏覽器暫停了聲音播放。', { label: '點此播放', onClick: () => { remoteVideo.play(); hideBanner() } }))
  })

  call.addEventListener('state', ({ detail: state }) => {
    if (state === 'connected') {
      hideBanner()
      setStatus('通話中', 'ok')
      $('remote-placeholder').hidden = true
      startTimer()
    } else if (state === 'disconnected') {
      setStatus('網路不穩，重新連線中…', 'warn')
    } else if (state === 'connecting' || state === 'new') {
      setStatus('建立連線中…', 'warn')
    }
  })
  call.addEventListener('restarting', ({ detail: attempt }) => {
    setStatus(`重新連線中（第 ${attempt} 次）…`, 'warn')
  })
  call.addEventListener('failed', () => {
    setStatus('連線失敗', 'error')
    showBanner('無法與對方建立連線，請檢查網路（建議改用行動網路或其他 Wi-Fi）後重試。', {
      label: '重試',
      onClick: () => { hideBanner(); call.resume() },
    })
  })
  call.addEventListener('peer-stalled', ({ detail: stalled }) => {
    if (stalled) showBanner(`${ROLE_LABEL[isDoctor ? 'patient' : 'doctor']}的畫面可能已凍結或網路中斷…`)
    else hideBanner()
  })
  call.addEventListener('control', ({ detail: msg }) => {
    if (msg.t === 'media') {
      $('remote-placeholder').hidden = !!msg.video
      if (!msg.video) setLobby(msg.audio ? '對方已關閉鏡頭（語音進行中）' : '對方已關閉鏡頭與麥克風')
    }
  })

  adapter = new VideoAdapter(() => {
    const t = call && call.transceiverFor('video')
    return t && t.sender
  })
  call.addEventListener('senders-ready', () => adapter.apply())
  adapter.addEventListener('suggest-audio-only', () => {
    const video = localStream.getVideoTracks()[0]
    if (!video || video.readyState !== 'live') return
    showBanner('網路品質不佳，建議關閉鏡頭以確保語音清晰。', {
      label: '改為純語音',
      onClick: () => { hideBanner(); toggleCamera() },
    })
  })

  monitor = new QualityMonitor(call.pc)
  monitor.addEventListener('sample', ({ detail }) => {
    lastSample = detail
    $('quality').dataset.level = detail.level
    $('quality').title = `連線品質：延遲 ${Math.round(detail.rttMs)} ms，掉包 ${detail.lossPct.toFixed(1)}%，抖動 ${Math.round(detail.jitterMs)} ms${detail.relayed ? '（經 TURN 中繼）' : ''}`
    adapter.onSample(detail.level)
  })
  monitor.start()
  clearInterval(qualityReportTimer)
  qualityReportTimer = setInterval(() => {
    if (lastSample && socket && socket.connected) socket.emit('quality', lastSample)
  }, QUALITY_REPORT_INTERVAL_MS)

  setStatus('建立連線中…', 'warn')
}

function teardownCall() {
  if (monitor) monitor.stop()
  clearInterval(qualityReportTimer)
  if (call) call.close()
  call = null
  monitor = null
  adapter = null
  lastSample = null
  $('remote-video').srcObject = null
  $('quality').dataset.level = 'unknown'
}

// --- Signaling -------------------------------------------------------------

// After a signaling server restart the room state (including admission) is gone. If the doctor
// is still in a live call with this exact patient page, re-admit it so renegotiation keeps working.
function readmitIfSameCall(peerSessionId) {
  if (isDoctor && !admitted && call && peerSessionId && call.peerSessionId === peerSessionId) socket.emit('admit')
}

function connectSignaling() {
  socket = io({
    auth: { token, sessionId },
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  })

  socket.on('connect', () => setStatus(call ? '已重新連線' : '已連線', call ? 'warn' : 'ok'))

  socket.on('disconnect', reason => {
    if (ended) return
    setStatus('與伺服器中斷，重新連線中…', 'warn')
    // Media keeps flowing peer-to-peer while signaling reconnects.
    if (reason === 'io server disconnect') setTimeout(() => !ended && socket.connect(), 2000)
  })

  socket.on('connect_error', err => {
    if (err.message === 'unauthorized') return endSession('連結無效或已過期', '請確認看診時間，或聯絡診所重新取得連結。')
    if (err.message === 'ended') return endSession('看診已結束', '本次看診已由醫師結束。')
    setStatus('無法連線伺服器，重試中…', 'error')
    // Middleware rejections are not retried automatically by Socket.IO.
    if (!socket.active) setTimeout(() => !ended && socket.connect(), err.message === 'rate-limited' ? 15000 : 3000)
  })

  socket.on('joined', data => {
    iceServers = data.iceServers
    iceTransportPolicy = data.iceTransportPolicy || 'all'
    admitted = data.admitted
    peerOnline = data.peerOnline
    readmitIfSameCall(data.peerSessionId)
    updateLobby()
  })

  socket.on('peer-online', data => {
    peerOnline = true
    admitted = data.admitted
    hideBanner()
    readmitIfSameCall(data.peerSessionId)
    updateLobby()
  })

  socket.on('peer-offline', () => {
    showBanner(`${ROLE_LABEL[isDoctor ? 'patient' : 'doctor']}的網路暫時中斷，等待重新連線…`)
  })

  socket.on('peer-left', () => {
    peerOnline = false
    if (isDoctor) admitted = false
    hideBanner()
    teardownCall()
    setStatus('已連線', 'ok')
    if (isDoctor) setLobby('病患已離開。')
    else updateLobby()
  })

  socket.on('call-ready', data => {
    admitted = true
    peerOnline = true
    startCall(data)
  })

  socket.on('signal', msg => {
    if (call) call.handleSignal(msg)
  })

  socket.on('session-replaced', () => endSession('已在其他視窗開啟', '此看診已在另一個分頁或裝置上開啟，本視窗已中斷。'))
  socket.on('call-ended', () => endSession('看診已結束', '感謝您使用視訊看診。'))
  socket.on('token-expired', () => endSession('看診時段已結束', '如需繼續，請聯絡診所重新預約。'))
}

// --- Entry -----------------------------------------------------------------

async function join({ video }) {
  $('consent-error').textContent = ''
  $('btn-join').disabled = true
  $('btn-join-audio').disabled = true
  try {
    localStream = await getLocalStream({ video })
  } catch (err) {
    $('consent-error').textContent = describeMediaError(err)
    $('btn-join').disabled = !isDoctor && !$('consent').checked
    $('btn-join-audio').disabled = !isDoctor && !$('consent').checked
    return
  }
  const videoTrack = localStream.getVideoTracks()[0]
  if (videoTrack && 'contentHint' in videoTrack) videoTrack.contentHint = 'detail'
  for (const t of localStream.getTracks()) watchTrack(t)
  $('local-video').srcObject = localStream
  renderControls()
  showScreen('call')
  updateLobby()
  connectSignaling()
  try { wakeLock = await navigator.wakeLock?.request('screen') } catch { /* optional */ }
}

function init() {
  if (!token || !claims || !ROLE_LABEL[role]) {
    showScreen('ended')
    $('ended-title').textContent = '連結無效'
    $('ended-text').textContent = '請使用預約通知中的看診連結進入。'
    return
  }
  if (!window.isSecureContext) {
    $('consent-error').textContent = '此頁面必須透過 HTTPS 開啟才能使用鏡頭與麥克風。'
  }

  $('role-label').textContent = `${ROLE_LABEL[role]}端`
  $('btn-hangup').textContent = isDoctor ? '結束看診' : '離開'

  // Consent is required from the patient before any media is captured.
  $('consent-row').hidden = isDoctor
  const syncConsent = () => {
    const ok = isDoctor || $('consent').checked
    $('btn-join').disabled = !ok
    $('btn-join-audio').disabled = !ok
  }
  $('consent').addEventListener('change', syncConsent)
  syncConsent()

  $('btn-join').addEventListener('click', () => join({ video: true }))
  $('btn-join-audio').addEventListener('click', () => join({ video: false }))
  $('btn-admit').addEventListener('click', () => {
    $('btn-admit').hidden = true
    socket.emit('admit')
  })
  $('btn-mic').addEventListener('click', toggleMic)
  $('btn-cam').addEventListener('click', toggleCamera)
  $('btn-hangup').addEventListener('click', () => {
    const question = isDoctor ? '確定要結束本次看診嗎？雙方都將離線。' : '確定要離開看診嗎？'
    if (!confirm(question)) return
    socket.emit('hang-up')
    endSession(isDoctor ? '看診已結束' : '您已離開看診', isDoctor ? '' : '如需重新進入，請再次開啟看診連結。')
  })

  $('btn-settings').addEventListener('click', async () => {
    await fillDeviceSelects().catch(() => {})
    $('settings').showModal()
  })
  $('select-mic').addEventListener('change', async e => {
    selected.mic = e.target.value
    const wasEnabled = localStream.getAudioTracks()[0]?.enabled ?? true
    try {
      const track = await getAudioTrack(selected.mic)
      track.enabled = wasEnabled
      await replaceLocalTrack('audio', track)
    } catch (err) {
      showBanner(describeMediaError(err))
    }
  })
  $('select-cam').addEventListener('change', async e => {
    selected.cam = e.target.value
    try {
      await replaceLocalTrack('video', await getVideoTrack(selected.cam))
    } catch (err) {
      showBanner(describeMediaError(err))
    }
  })
  $('select-speaker').addEventListener('change', async e => {
    selected.speaker = e.target.value
    try { await $('remote-video').setSinkId(selected.speaker) } catch (err) { showBanner('無法切換喇叭。') }
  })
  navigator.mediaDevices?.addEventListener('devicechange', () => {
    if ($('settings').open) fillDeviceSelects().catch(() => {})
  })

  window.addEventListener('online', () => {
    if (call) call.resume()
  })
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && wakeLock?.released && !ended && call) {
      try { wakeLock = await navigator.wakeLock.request('screen') } catch { /* optional */ }
    }
  })

  showScreen('consent')
}

init()
