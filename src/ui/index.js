// garo já é global via contextBridge — não redeclarar

let isRecording = false
let timerInterval = null
let elapsedSeconds = 0

const btnRecord    = document.getElementById('btn-record')
const dot          = document.getElementById('status-dot')
const timerEl      = document.getElementById('timer')
const encoderBadge = document.getElementById('encoder-badge')
const bitrateSlider = document.getElementById('bitrate')
const bitrateVal   = document.getElementById('bitrate-val')

function pad(n) { return String(n).padStart(2, '0') }

function formatTime(s) {
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function setRecording(val) {
  isRecording = val
  dot.className = `dot ${val ? 'recording' : 'idle'}`
  btnRecord.className = `btn-record ${val ? 'recording' : 'idle'}`
  btnRecord.textContent = val ? '⏹ PARAR GRAVAÇÃO' : '⏺ INICIAR GRAVAÇÃO'

  if (val) {
    elapsedSeconds = 0
    timerInterval = setInterval(() => {
      elapsedSeconds++
      timerEl.textContent = formatTime(elapsedSeconds)
    }, 1000)
  } else {
    clearInterval(timerInterval)
    timerEl.textContent = '00:00:00'
  }
}

function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast')
  toast.textContent = msg
  toast.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => toast.classList.add('hidden'), duration)
}

async function loadRecent() {
  const list = document.getElementById('recent-list')
  const items = await garo.getRecent()
  if (!items.length) {
    list.innerHTML = '<div class="empty">Nenhuma gravação ainda</div>'
    return
  }
  list.innerHTML = items.map(item => {
    const folderPath = item.path.replace(/\\[^\\]+$/, '')
    const escapedPath   = item.path.replace(/\\/g, '\\\\')
    const escapedFolder = folderPath.replace(/\\/g, '\\\\')
    return `
      <div class="recent-item">
        <span class="name" title="${item.path}">${item.name}</span>
        <span class="size">${formatSize(item.size)}</span>
        <button class="icon-btn" onclick="garo.openFile('${escapedPath}')" title="Reproduzir">▶</button>
        <button class="icon-btn" onclick="garo.openFolder('${escapedFolder}')" title="Abrir pasta">📂</button>
      </div>`
  }).join('')
}

function markRecommended(selectId, recommendedValue) {
  const select = document.getElementById(selectId)
  if (!select) return
  for (const opt of select.options) {
    opt.textContent = opt.textContent.replace(' (Recomendado)', '')
    if (opt.value === String(recommendedValue)) {
      opt.textContent += ' (Recomendado)'
    }
  }
}

function applySettings(s) {
  document.getElementById('encoder').value       = s.encoder      || 'auto'
  document.getElementById('fps').value           = String(s.fps   || 60)
  document.getElementById('capture-mode').value  = s.captureMode  || 'ffmpeg'
  bitrateSlider.value = s.bitrate || 80
  bitrateVal.textContent = (s.bitrate || 80) + ' Mbps'
  document.getElementById('output-folder').value = s.outputFolder || ''
  if (s.source && s.source.name) {
    const icon = s.source.type === 'window' ? '🗔' : '🖥'
    document.getElementById('btn-source').textContent = `${icon} ${s.source.name}`
  }
  // Restore audio/webcam selections after devices are loaded
  if (s.micDevice)      { const el = document.getElementById('mic-device');      if (el) el.value = s.micDevice }
  if (s.sysAudioDevice) { const el = document.getElementById('sys-audio-device'); if (el) el.value = s.sysAudioDevice }
  if (s.webcamDevice)   { const el = document.getElementById('webcam-device');   if (el) el.value = s.webcamDevice }
}

async function collectSettings() {
  const saved = await garo.getSettings()
  return {
    encoder:        document.getElementById('encoder').value,
    fps:            parseInt(document.getElementById('fps').value),
    bitrate:        parseInt(bitrateSlider.value),
    captureMode:    document.getElementById('capture-mode').value,
    outputFolder:   document.getElementById('output-folder').value,
    micDevice:      document.getElementById('mic-device')?.value       || '',
    sysAudioDevice: document.getElementById('sys-audio-device')?.value || '',
    webcamDevice:   document.getElementById('webcam-device')?.value    || '',
    source:         saved.source || { type: 'desktop', name: 'Tela inteira' },
  }
}

async function autoSave() {
  const s = await collectSettings()
  await garo.saveSettings(s)
}

function applyRecommendations(detectedEncoder, monitorHz) {
  // Encoder: marca o detectado como recomendado
  if (detectedEncoder) {
    markRecommended('encoder', detectedEncoder)
    encoderBadge.textContent = detectedEncoder
  }

  // FPS: recomenda o fps mais proximo ao Hz do monitor (sem ultrapassar 144)
  if (monitorHz) {
    let recommended
    if (monitorHz >= 144)      recommended = 144
    else if (monitorHz >= 120) recommended = 120
    else if (monitorHz >= 60)  recommended = 60
    else                       recommended = 30
    markRecommended('fps', recommended)
  }
}

// Init via IPC
garo.onInit(async ({ settings, detectedEncoder, monitorHz }) => {
  applySettings(settings)
  applyRecommendations(detectedEncoder, monitorHz)
  await Promise.all([loadRecent(), loadMediaDevices()])
})

// Fallback se onInit disparou antes do listener
setTimeout(async () => {
  try {
    const data = await garo.getInitData()
    applySettings(data.settings)
    applyRecommendations(data.detectedEncoder, data.monitorHz)
  } catch (e) {
    try {
      const s = await garo.getSettings()
      applySettings(s)
      const detected = await garo.detectEncoder()
      applyRecommendations(detected, null)
    } catch {}
  }
  await Promise.all([loadRecent(), loadMediaDevices()])
}, 400)

// Botão gravar
btnRecord.addEventListener('click', async () => {
  if (!isRecording) {
    await autoSave()
    await garo.startRecording()
  } else {
    await garo.stopRecording()
  }
})

// Settings
document.getElementById('encoder').addEventListener('change', autoSave)
document.getElementById('fps').addEventListener('change', autoSave)
document.getElementById('capture-mode').addEventListener('change', autoSave)
document.getElementById('mic-device').addEventListener('change', autoSave)
document.getElementById('sys-audio-device').addEventListener('change', autoSave)
document.getElementById('webcam-device').addEventListener('change', autoSave)
bitrateSlider.addEventListener('change', autoSave)

// ── Detecção de dispositivos de áudio e vídeo ─────────────────
async function loadMediaDevices() {
  // Solicita permissão de microfone para obter labels nos dispositivos
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    s.getTracks().forEach(t => t.stop())
  } catch (e) {
    console.warn('[Devices] Permissao de microfone negada:', e.message)
  }

  // Browser API: microfones e webcams
  let browserDevices = []
  try { browserDevices = await navigator.mediaDevices.enumerateDevices() } catch {}

  const mics = browserDevices.filter(d =>
    d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label
  )
  const cams = browserDevices.filter(d => d.kind === 'videoinput' && d.label)

  // Popula Microfone (label = nome DirectShow, usado no FFmpeg dshow)
  const micSel = document.getElementById('mic-device')
  mics.forEach(d => {
    const opt = document.createElement('option')
    opt.value = d.label
    opt.textContent = d.label
    micSel.appendChild(opt)
  })

  // DirectShow: áudio sistema (Stereo Mix etc.) e webcams adicionais
  try {
    const dshow = await garo.getDshowDevices()
    const sysSel = document.getElementById('sys-audio-device')
    ;(dshow.audio || []).forEach(name => {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      sysSel.appendChild(opt)
    })

    const camSel = document.getElementById('webcam-device')
    const camList = cams.length > 0 ? cams.map(d => ({ value: d.label, label: d.label }))
      : (dshow.video || []).map(n => ({ value: n, label: n }))
    camList.forEach(d => {
      const opt = document.createElement('option')
      opt.value = d.value
      opt.textContent = d.label
      camSel.appendChild(opt)
    })
  } catch (e) {
    console.warn('[Devices] getDshowDevices falhou:', e.message)
  }

  // Restaura seleções salvas (após população)
  const saved = await garo.getSettings()
  if (saved.micDevice)      { micSel.value = saved.micDevice }
  if (saved.sysAudioDevice) { document.getElementById('sys-audio-device').value = saved.sysAudioDevice }
  if (saved.webcamDevice)   { document.getElementById('webcam-device').value    = saved.webcamDevice }
}

// ── Seletor de fonte ──────────────────────────────────────────
let allSources = []
let displays   = []
let selectedSource = null
let activeTab = 'screen'

function openSourceModal() {
  document.getElementById('source-modal').classList.remove('hidden')
  loadSources()
}

function closeSourceModal() {
  document.getElementById('source-modal').classList.add('hidden')
}

async function loadSources() {
  const grid = document.getElementById('source-grid')
  grid.innerHTML = '<div style="color:#666;padding:16px;grid-column:1/-1">Carregando...</div>'
  try {
    ;[allSources, displays] = await Promise.all([garo.getSources(), garo.getDisplays()])
    renderSourceGrid()
  } catch (e) {
    grid.innerHTML = `<div style="color:#e55;padding:16px;grid-column:1/-1">Erro: ${e.message}</div>`
  }
}

function renderSourceGrid() {
  const grid = document.getElementById('source-grid')
  const filtered = allSources.filter(s => s.type === activeTab)

  if (!filtered.length) {
    grid.innerHTML = '<div style="color:#666;padding:16px;grid-column:1/-1">Nenhuma fonte encontrada</div>'
    return
  }

  grid.innerHTML = filtered.map((s, i) => {
    const thumb = s.thumbnail
      ? `<img src="${s.thumbnail}" alt="${s.name}">`
      : `<div class="thumb-placeholder">${s.type === 'screen' ? '🖥' : '🗔'}</div>`
    return `
    <div class="source-card${selectedSource && selectedSource.id === s.id ? ' selected' : ''}"
         data-idx="${i}" onclick="window._selectSource(${i})">
      ${thumb}
      <div class="source-name" title="${s.name}">${s.name}</div>
    </div>`
  }).join('')
}

window._selectSource = function (idx) {
  const filtered = allSources.filter(s => s.type === activeTab)
  selectedSource = filtered[idx]
  document.getElementById('btn-source-confirm').disabled = false
  renderSourceGrid()
}

document.querySelectorAll('.source-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.source-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    activeTab = tab.dataset.tab
    selectedSource = null
    document.getElementById('btn-source-confirm').disabled = true
    renderSourceGrid()
  })
})

document.getElementById('btn-source').addEventListener('click', openSourceModal)
document.getElementById('source-modal-close').addEventListener('click', closeSourceModal)
document.getElementById('btn-source-cancel').addEventListener('click', closeSourceModal)

document.getElementById('btn-source-confirm').addEventListener('click', async () => {
  if (!selectedSource) return
  closeSourceModal()

  let sourceSettings = { type: selectedSource.type, name: selectedSource.name, id: selectedSource.id }

  if (selectedSource.type === 'screen') {
    const disp = displays.find(d => d.id === selectedSource.display_id)
    if (disp) {
      sourceSettings.bounds = disp.bounds
      sourceSettings.scaleFactor = disp.scaleFactor
    }
  }

  const label = selectedSource.type === 'screen' ? `🖥 ${selectedSource.name}` : `🗔 ${selectedSource.name}`
  document.getElementById('btn-source').textContent = label

  const s = await collectSettings()
  s.source = sourceSettings
  await garo.saveSettings(s)
  showToast('Fonte selecionada: ' + selectedSource.name)
})

// ── Pasta de saída ────────────────────────────────────────────
window._abrirPasta = async function () {
  showToast('Abrindo seletor de pasta...')
  try {
    const folder = await garo.selectFolder()
    console.log('Pasta selecionada:', folder)
    if (folder) {
      document.getElementById('output-folder').value = folder
      autoSave()
      showToast('Pasta salva!')
    } else {
      showToast('Nenhuma pasta selecionada.')
    }
  } catch (e) {
    console.error('Erro ao selecionar pasta:', e)
    showToast('Erro: ' + e.message)
  }
}

document.getElementById('btn-refresh').addEventListener('click', loadRecent)

// ── WGC Recording (MediaRecorder via Chromium WGC) ───────────────────────────
let wgcRecorder = null
let wgcStream   = null

garo.onWgcStart(async ({ sourceId, outputPath, tempPath, bitrate, micDevice }) => {
  let micStream = null
  try {
    wgcStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 60 } },
    })

    // Captura microfone se selecionado
    if (micDevice) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const match = devices.find(d => d.kind === 'audioinput' && d.label === micDevice)
        const audioConstraint = match ? { deviceId: { exact: match.deviceId } } : true
        micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false })
      } catch (e) {
        console.warn('[WGC] Microfone indisponivel:', e.message)
        showToast('Microfone indisponivel, gravando sem audio', 4000)
      }
    }

    // Combina tracks de video + microfone
    const tracks = [...wgcStream.getVideoTracks()]
    if (micStream) tracks.push(...micStream.getAudioTracks())
    const combinedStream = new MediaStream(tracks)

    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=h264', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm'

    wgcRecorder = new MediaRecorder(combinedStream, {
      mimeType,
      videoBitsPerSecond: Math.min(bitrate || 20, 80) * 1024 * 1024,
    })

    await garo.wgcStartWrite(tempPath)

    wgcRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        e.data.arrayBuffer().then(buf => garo.wgcChunk(Array.from(new Uint8Array(buf))))
      }
    }

    wgcRecorder.onstop = async () => {
      wgcStream && wgcStream.getTracks().forEach(t => t.stop())
      micStream && micStream.getTracks().forEach(t => t.stop())
      wgcStream = null
      await garo.wgcFinalize(outputPath)
    }

    wgcRecorder.start(1000)
    console.log('[WGC] Iniciado com', mimeType, micDevice ? '+ mic' : '')

  } catch (e) {
    console.error('[WGC] Erro:', e)
    wgcStream && wgcStream.getTracks().forEach(t => t.stop())
    micStream && micStream.getTracks().forEach(t => t.stop())
    wgcStream = null
    await garo.wgcError(e.message)
  }
})

garo.onWgcStop(() => {
  if (wgcRecorder && wgcRecorder.state !== 'inactive') {
    setRecording(false)
    showToast('Convertendo para MP4...', 30000)
    wgcRecorder.stop()
    wgcRecorder = null
  }
})

// Eventos de gravação
garo.onRecordingStarted(() => {
  setRecording(true)
  showToast('Gravação iniciada')
})

garo.onRecordingStopped(async ({ outputPath }) => {
  setRecording(false)
  showToast('Gravação salva!')
  await loadRecent()
})

garo.onRecordingError(({ message }) => {
  setRecording(false)
  showToast('Erro: ' + message, 6000)
})

garo.onRecordingWarn(({ message }) => {
  showToast('⚠ ' + message, 4000)
})
