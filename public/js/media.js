export const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
export const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }

function withDevice(base, deviceId) {
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : base
}

export async function getLocalStream({ video = true } = {}) {
  return navigator.mediaDevices.getUserMedia({
    audio: AUDIO_CONSTRAINTS,
    video: video ? VIDEO_CONSTRAINTS : false,
  })
}

export async function getAudioTrack(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: withDevice(AUDIO_CONSTRAINTS, deviceId) })
  return stream.getAudioTracks()[0]
}

export async function getVideoTrack(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: withDevice(VIDEO_CONSTRAINTS, deviceId) })
  const track = stream.getVideoTracks()[0]
  // Hint the encoder that fine detail matters more than smooth motion (e.g. skin, wounds).
  if ('contentHint' in track) track.contentHint = 'detail'
  return track
}

export async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    mics: devices.filter(d => d.kind === 'audioinput'),
    cams: devices.filter(d => d.kind === 'videoinput'),
    speakers: devices.filter(d => d.kind === 'audiooutput'),
  }
}

export function describeMediaError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '瀏覽器未允許使用鏡頭或麥克風。請點選網址列左側的鎖頭圖示，將鏡頭與麥克風設為「允許」後重新整理頁面。'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '找不到可用的鏡頭或麥克風，請確認裝置已連接。'
    case 'NotReadableError':
    case 'AbortError':
      return '鏡頭或麥克風正被其他程式使用（例如其他視訊軟體），請關閉後再試一次。'
    default:
      return `無法取得鏡頭或麥克風（${(err && err.name) || '未知錯誤'}）。`
  }
}
