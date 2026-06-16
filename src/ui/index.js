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

// ── Navegação por abas ─────────────────────────────────────────
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'))
    tab.classList.add('active')
    document.getElementById(`tab-${tab.dataset.tab}`).classList.remove('hidden')
  })
})

// ── Gravações recentes ─────────────────────────────────────────
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
    if (opt.value === String(recommendedValue)) opt.textContent += ' (Recomendado)'
  }
}

// ── Configurações ──────────────────────────────────────────────
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
    cameras:        collectCameraSettings(),
    source:         saved.source || { type: 'desktop', name: 'Tela inteira' },
  }
}

async function autoSave() {
  const s = await collectSettings()
  await garo.saveSettings(s)
}

function applyRecommendations(detectedEncoder, monitorHz) {
  if (detectedEncoder) {
    markRecommended('encoder', detectedEncoder)
    encoderBadge.textContent = detectedEncoder
  }
  if (monitorHz) {
    let recommended
    if (monitorHz >= 144)      recommended = 144
    else if (monitorHz >= 120) recommended = 120
    else if (monitorHz >= 60)  recommended = 60
    else                       recommended = 30
    markRecommended('fps', recommended)
  }
}

// Event listeners de configuração
document.getElementById('encoder').addEventListener('change', autoSave)
document.getElementById('fps').addEventListener('change', autoSave)
document.getElementById('capture-mode').addEventListener('change', autoSave)
document.getElementById('mic-device').addEventListener('change', autoSave)
document.getElementById('sys-audio-device').addEventListener('change', autoSave)
bitrateSlider.addEventListener('change', autoSave)

// ── Câmeras — UI e configuração ────────────────────────────────
function collectCameraSettings() {
  return Array.from(document.querySelectorAll('.camera-card')).map(card => ({
    name:     card.dataset.camName,
    deviceId: card.dataset.camId || null,
    enabled:  card.querySelector('.cam-toggle').checked,
    position: card.querySelector('.pos-q.active, .pos-btn-full.active')?.dataset.pos || 'br',
  }))
}

function renderCameraList(cams, savedCameras) {
  const container = document.getElementById('cameras-list')
  if (!cams.length) {
    container.innerHTML = '<div class="empty cam-loading">Nenhuma câmera detectada</div>'
    return
  }

  const positions = [
    { p: 'tl', title: 'Superior esquerdo' },
    { p: 'tr', title: 'Superior direito'  },
    { p: 'bl', title: 'Inferior esquerdo' },
    { p: 'br', title: 'Inferior direito'  },
  ]

  container.innerHTML = cams.map((cam, i) => {
    const saved   = (savedCameras || []).find(c => c.name === cam.label) || {}
    const enabled = saved.enabled || false
    const pos     = saved.position || 'br'
    const safeName = (cam.label || '').replace(/"/g, '&quot;')
    const safeDeviceId = (cam.deviceId || '').replace(/"/g, '&quot;')
    return `
    <div class="camera-card" data-cam-name="${safeName}" data-cam-id="${safeDeviceId}">
      <div class="camera-header">
        <input type="checkbox" id="cam-chk-${i}" class="cam-toggle"${enabled ? ' checked' : ''}>
        <label for="cam-chk-${i}" title="${safeName}">${cam.label || 'Câmera ' + (i + 1)}</label>
      </div>
      <div class="camera-options"${!enabled ? ' style="display:none"' : ''}>
        <span class="pos-label">Posição:</span>
        <div class="pos-grid2x2">
          ${positions.map(({ p, title }) =>
            `<button class="pos-q${pos === p ? ' active' : ''}" data-pos="${p}" title="${title}">▪</button>`
          ).join('')}
        </div>
        <button class="pos-btn-full${pos === 'full' ? ' active' : ''}" data-pos="full" title="Câmera ocupa a tela toda">Tela cheia</button>
      </div>
    </div>`
  }).join('')

  // Eventos de câmera
  container.querySelectorAll('.cam-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const opts = cb.closest('.camera-card').querySelector('.camera-options')
      opts.style.display = cb.checked ? '' : 'none'
      autoSave()
    })
  })

  container.querySelectorAll('.pos-q, .pos-btn-full').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.camera-options').querySelectorAll('.pos-q, .pos-btn-full').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      autoSave()
    })
  })
}

// ── Detecção de dispositivos ───────────────────────────────────
async function loadMediaDevices() {
  // Solicita permissão de microfone para obter labels
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    s.getTracks().forEach(t => t.stop())
  } catch (e) {
    console.warn('[Devices] Permissao de mic negada:', e.message)
  }

  // Solicita permissão de câmera
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true })
    s.getTracks().forEach(t => t.stop())
  } catch (e) {
    console.warn('[Devices] Permissao de camera negada:', e.message)
  }

  let browserDevices = []
  try { browserDevices = await navigator.mediaDevices.enumerateDevices() } catch {}

  const mics = browserDevices.filter(d =>
    d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label
  )
  const cams = browserDevices.filter(d => d.kind === 'videoinput' && d.label)

  // Microfone
  const micSel = document.getElementById('mic-device')
  mics.forEach(d => {
    const opt = document.createElement('option')
    opt.value = d.label
    opt.textContent = d.label
    micSel.appendChild(opt)
  })

  // Áudio do sistema + câmeras via DirectShow
  let dshowCamList = []
  try {
    const dshow = await garo.getDshowDevices()

    const sysSel = document.getElementById('sys-audio-device')
    ;(dshow.audio || []).forEach(name => {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      sysSel.appendChild(opt)
    })

    // Câmeras: usa nomes DirectShow (compatíveis com FFmpeg dshow).
    // Faz match com deviceId do browser removendo o sufixo USB "(xxxx:xxxx)" que
    // o Chromium adiciona ao label mas que não faz parte do nome DirectShow.
    dshowCamList = (dshow.video || []).map(name => {
      const match = cams.find(d => {
        const clean = d.label.replace(/\s*\([0-9a-f:]+\)\s*$/i, '').trim()
        return clean === name || d.label === name
      })
      return { label: name, deviceId: match ? match.deviceId : null }
    })

    // Fallback: se DirectShow não devolveu câmeras, usa browser API
    if (dshowCamList.length === 0) {
      dshowCamList = cams.map(d => ({ label: d.label, deviceId: d.deviceId }))
    }
  } catch (e) {
    console.warn('[Devices] getDshowDevices falhou:', e.message)
    dshowCamList = cams.map(d => ({ label: d.label, deviceId: d.deviceId }))
  }

  // Câmeras + restore de seleções salvas
  const saved = await garo.getSettings()
  renderCameraList(dshowCamList, saved.cameras || [])

  if (saved.micDevice)      micSel.value = saved.micDevice
  if (saved.sysAudioDevice) document.getElementById('sys-audio-device').value = saved.sysAudioDevice
}

// ── Init ───────────────────────────────────────────────────────
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
  } catch {
    try {
      const s = await garo.getSettings()
      applySettings(s)
      const detected = await garo.detectEncoder()
      applyRecommendations(detected, null)
    } catch {}
  }
  await Promise.all([loadRecent(), loadMediaDevices()])
}, 400)

// ── Botão gravar ───────────────────────────────────────────────
btnRecord.addEventListener('click', async () => {
  if (!isRecording) {
    await autoSave()
    await garo.startRecording()
  } else {
    await garo.stopRecording()
  }
})

// ── Seletor de fonte ───────────────────────────────────────────
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

// ── Pasta de saída ─────────────────────────────────────────────
window._abrirPasta = async function () {
  showToast('Abrindo seletor de pasta...')
  try {
    const folder = await garo.selectFolder()
    if (folder) {
      document.getElementById('output-folder').value = folder
      autoSave()
      showToast('Pasta salva!')
    } else {
      showToast('Nenhuma pasta selecionada.')
    }
  } catch (e) {
    showToast('Erro: ' + e.message)
  }
}

document.getElementById('btn-refresh').addEventListener('click', loadRecent)

// ── WGC Recording ──────────────────────────────────────────────
let wgcRecorder  = null
let wgcStream    = null
let wgcAnimFrame = null
let wgcCamStreams = []

garo.onWgcStart(async ({ sourceId, outputPath, tempPath, bitrate, micDevice, cameras }) => {
  let micStream = null
  try {
    // Stream de tela via WGC
    wgcStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 60 } },
    })

    // Microfone
    if (micDevice) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const match = devices.find(d => d.kind === 'audioinput' && d.label === micDevice)
        const constraint = match ? { deviceId: { exact: match.deviceId } } : true
        micStream = await navigator.mediaDevices.getUserMedia({ audio: constraint, video: false })
      } catch (e) {
        console.warn('[WGC] Mic:', e.message)
        showToast('Microfone indisponivel, gravando sem audio', 4000)
      }
    }

    // Câmeras para PiP
    const enabledCams = (cameras || []).filter(c => c.enabled)
    wgcCamStreams = []
    if (enabledCams.length > 0) {
      const devices = await navigator.mediaDevices.enumerateDevices()
      for (const cam of enabledCams) {
        try {
          // Usa deviceId salvo em detectção; fallback: fuzzy match strip sufixo USB "(xxxx:xxxx)"
          let deviceId = cam.deviceId || null
          if (!deviceId) {
            const dev = devices.find(d => {
              if (d.kind !== 'videoinput') return false
              const clean = d.label.replace(/\s*\([0-9a-f:]+\)\s*$/i, '').trim()
              return clean === cam.name || d.label === cam.name
            })
            deviceId = dev ? dev.deviceId : null
          }
          if (!deviceId) { console.warn('[WGC] Camera sem deviceId:', cam.name); continue }
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 360 } },
            audio: false,
          })
          wgcCamStreams.push({ stream, position: cam.position })
        } catch (e) {
          console.warn('[WGC] Camera:', cam.name, e.message)
        }
      }
    }

    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=h264', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm'

    let recordStream

    if (wgcCamStreams.length > 0) {
      // Composição via canvas: tela + câmeras em PiP
      const screenTrack = wgcStream.getVideoTracks()[0]
      const { width = 1920, height = 1080 } = screenTrack.getSettings()

      const canvas = document.createElement('canvas')
      canvas.width  = width
      canvas.height = height
      const ctx = canvas.getContext('2d', { alpha: false })

      const screenVideo = document.createElement('video')
      screenVideo.srcObject = wgcStream
      screenVideo.muted = true
      await new Promise(r => { screenVideo.onloadedmetadata = r })
      screenVideo.play()

      const camVideos = []
      for (const { stream, position } of wgcCamStreams) {
        const v = document.createElement('video')
        v.srcObject = stream
        v.muted = true
        await new Promise(r => { v.onloadedmetadata = r })
        v.play()
        camVideos.push({ video: v, position })
      }

      function drawFrame() {
        if (screenVideo.readyState >= 2)
          ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height)

        for (const { video, position } of camVideos) {
          if (video.readyState < 2) continue
          let x, y, w, h
          if (position === 'full') {
            x = 0; y = 0; w = canvas.width; h = canvas.height
          } else {
            w = Math.floor(canvas.width  * 0.25)
            h = Math.floor(w * 9 / 16)
            const pad = 20
            switch (position) {
              case 'tl': x = pad;                    y = pad; break
              case 'tr': x = canvas.width  - w - pad; y = pad; break
              case 'bl': x = pad;                    y = canvas.height - h - pad; break
              default:   x = canvas.width  - w - pad; y = canvas.height - h - pad; break
            }
          }
          ctx.drawImage(video, x, y, w, h)
        }
        wgcAnimFrame = requestAnimationFrame(drawFrame)
      }
      drawFrame()

      const canvasStream = canvas.captureStream(60)
      if (micStream) micStream.getAudioTracks().forEach(t => canvasStream.addTrack(t))
      recordStream = canvasStream
    } else {
      // Sem câmeras: stream de tela + mic diretamente
      const tracks = [...wgcStream.getVideoTracks()]
      if (micStream) tracks.push(...micStream.getAudioTracks())
      recordStream = new MediaStream(tracks)
    }

    wgcRecorder = new MediaRecorder(recordStream, {
      mimeType,
      videoBitsPerSecond: Math.min(bitrate || 20, 80) * 1024 * 1024,
    })

    await garo.wgcStartWrite(tempPath)

    wgcRecorder.ondataavailable = (e) => {
      if (e.data.size > 0)
        e.data.arrayBuffer().then(buf => garo.wgcChunk(Array.from(new Uint8Array(buf))))
    }

    wgcRecorder.onstop = async () => {
      if (wgcAnimFrame) { cancelAnimationFrame(wgcAnimFrame); wgcAnimFrame = null }
      wgcStream && wgcStream.getTracks().forEach(t => t.stop())
      micStream && micStream.getTracks().forEach(t => t.stop())
      wgcCamStreams.forEach(({ stream }) => stream.getTracks().forEach(t => t.stop()))
      wgcCamStreams = []
      wgcStream = null
      await garo.wgcFinalize(outputPath)
    }

    wgcRecorder.start(1000)
    console.log('[WGC] Iniciado:', mimeType, micDevice ? '+mic' : '', `+${wgcCamStreams.length}cam`)

  } catch (e) {
    console.error('[WGC] Erro:', e)
    if (wgcAnimFrame) { cancelAnimationFrame(wgcAnimFrame); wgcAnimFrame = null }
    wgcStream && wgcStream.getTracks().forEach(t => t.stop())
    micStream && micStream.getTracks().forEach(t => t.stop())
    wgcCamStreams.forEach(({ stream }) => stream.getTracks().forEach(t => t.stop()))
    wgcCamStreams = []
    wgcStream = null
    await garo.wgcError(e.message)
  }
})

garo.onWgcStop(() => {
  if (wgcAnimFrame) { cancelAnimationFrame(wgcAnimFrame); wgcAnimFrame = null }
  if (wgcRecorder && wgcRecorder.state !== 'inactive') {
    setRecording(false)
    showToast('Convertendo para MP4...', 30000)
    wgcRecorder.stop()
    wgcRecorder = null
  }
})

// ── Eventos de gravação ────────────────────────────────────────
garo.onRecordingStarted(() => {
  setRecording(true)
  showToast('Gravação iniciada')
})

garo.onRecordingStopped(async () => {
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
