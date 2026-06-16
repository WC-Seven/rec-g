const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, dialog, nativeImage, shell, screen, desktopCapturer, session } = require('electron')
const path = require('path')
const os   = require('os')
const fs   = require('fs')
const { execFile, spawn } = require('child_process')
const { Recorder } = require('./src/recorder')

let ffmpegPath
try { ffmpegPath = require('ffmpeg-static') } catch { ffmpegPath = 'ffmpeg' }

// Estado do modo WGC (MediaRecorder no renderer)
let wgcState = { active: false, writeStream: null, tempPath: null, outputPath: null, hasAudio: false }

// Auto-split de gravação
let splitTimer         = null
let segmentCount       = 0
let pendingAutoRestart = false

function startSplitTimer(intervalSec) {
  clearTimeout(splitTimer)
  splitTimer = null
  if (!intervalSec || intervalSec <= 0) return
  splitTimer = setTimeout(() => {
    if (app.isQuitting) return
    console.log('[Split] Corte automatico, encerrando segmento', segmentCount)
    handleStop(true)
  }, intervalSec * 1000)
}

function stopSplitTimer() {
  clearTimeout(splitTimer)
  splitTimer = null
}

async function convertWebmToMp4(webmPath, mp4Path, hasAudio = false) {
  const enc = detectedEncoder || 'libx264'
  const encArgs = (enc.includes('qsv') || enc.includes('amf') || enc.includes('nvenc'))
    ? ['-c:v', enc, '-b:v', '20M']
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']
  const audioArgs = hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']
  const args = ['-i', webmPath, ...encArgs, ...audioArgs, '-y', mp4Path]
  console.log('[WGC→MP4] Args:', args.join(' '))
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    proc.stderr.on('data', d => process.stdout.write('[WGC→MP4] ' + d))
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`code ${code}`)))
    proc.on('error', reject)
  })
}

// Desabilita WGC apenas para captura de TELAS (causa E_INVALIDARG em dual-monitor).
// WebRtcAllowWgcWindowCapturer permanece ATIVO — necessario para o modo de gravacao WGC
// que usa getUserMedia no renderer para isolar janelas individualmente.
app.commandLine.appendSwitch(
  'disable-features',
  'WindowsGraphicsCapture,WebRtcAllowWgcScreenCapturer,WebRtcAllowWgcDesktopCapturer'
)

let mainWindow = null
let tray = null
const recorder = new Recorder()

// Inicia deteccao imediatamente
const encoderDetectionPromise = recorder.detectEncoder()
let detectedEncoder = 'libx264'
encoderDetectionPromise.then(enc => {
  detectedEncoder = enc
  console.log('[Garo] Encoder detectado:', enc)
})

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json')

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
  } catch {
    return {
      outputFolder: path.join(os.homedir(), 'Videos', 'Garo'),
      fps: 60,
      bitrate: 80,
      encoder: 'auto',
      captureAudio: false,
      source: { type: 'desktop', name: 'Tela inteira' },
    }
  }
}

function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2))
  } catch {}
}

function getOutputPath(folder) {
  const now = new Date()
  const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  fs.mkdirSync(folder, { recursive: true })
  return path.join(folder, `garo_${ts}.mp4`)
}

function makeTrayIcon(recording) {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = recording ? 220 : 80
    buf[i * 4 + 1] = recording ? 50  : 80
    buf[i * 4 + 2] = recording ? 50  : 80
    buf[i * 4 + 3] = 255
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

function isAnyRecording() { return recorder.isRecording || wgcState.active }

function updateTray() {
  if (!tray) return
  const rec = isAnyRecording()
  tray.setImage(makeTrayIcon(rec))
  tray.setToolTip(rec ? 'Garo — Gravando...' : 'Garo Producoes')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: isAnyRecording() ? 'Parar gravacao  (F10)' : 'Iniciar gravacao  (F9)',
      click: () => isAnyRecording() ? handleStop() : handleStart()
    },
    { type: 'separator' },
    { label: 'Abrir painel', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit() } }
  ]))
}

// Extrai o HWND decimal do source ID do Electron ("window:12345:0")
function hwndFromSourceId(sourceId) {
  const m = sourceId && sourceId.match(/^window:(\d+)/)
  return m ? m[1] : null
}

// Codifica script PowerShell como base64 UTF-16LE para -EncodedCommand
// Evita todos os problemas de escape de here-strings e aspas
function encodePsCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

// Obtem bounds reais de uma janela.
// Estrategia: 1) HWND do source ID (rapido)  2) Get-Process pelo titulo (fallback robusto)
// Saida PS: linha1="x,y,w,h"  linha2="titulo atual da janela"
function getWindowBoundsAsync(sourceId, windowTitle) {
  const hwnd    = hwndFromSourceId(sourceId) || '0'
  const safeName = (windowTitle || '').replace(/'/g, "''")

  // Script unificado: tenta HWND, cai para Get-Process se HWND estiver invalido
  const script = `
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WBND {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT pv, int cb);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    public struct RECT { public int L, T, R, B; }
}
'@ -Language CSharp -ErrorAction SilentlyContinue

  $target = [IntPtr]::Zero

  $hval = [long]'${hwnd}'
  if ($hval -ne 0) {
    $h = [IntPtr]$hval
    if ([WBND]::IsWindow($h)) { $target = $h }
  }

  if ($target -eq [IntPtr]::Zero -and '${safeName}' -ne '') {
    $proc = Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${safeName}*' } |
      Select-Object -First 1
    if ($proc) { $target = [IntPtr]$proc.MainWindowHandle }
  }

  if ($target -ne [IntPtr]::Zero) {
    $root = [WBND]::GetAncestor($target, 2)
    if ($root -ne [IntPtr]::Zero) { $target = $root }
    $r = New-Object WBND+RECT
    $sz = [System.Runtime.InteropServices.Marshal]::SizeOf($r)
    if ([WBND]::DwmGetWindowAttribute($target, 9, [ref]$r, $sz) -ne 0) {
      [WBND]::GetWindowRect($target, [ref]$r) | Out-Null
    }
    $sb = New-Object System.Text.StringBuilder(512)
    [WBND]::GetWindowText($target, $sb, 512) | Out-Null
    Write-Output "$($r.L),$($r.T),$($r.R-$r.L),$($r.B-$r.T)"
    Write-Output $sb.ToString()
  } else {
    Write-Output "0,0,0,0"
    Write-Output ""
  }
} catch {
  Write-Output "0,0,0,0"
  Write-Output ""
}`

  return new Promise((resolve) => {
    const encoded = encodePsCommand(script)
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 8000 },
      (err, stdout, stderr) => {
        const raw = stdout.trim()
        console.log('[Garo] PS bounds raw:', raw || '(vazio)', err ? `| err: ${err.code}` : '')
        if (err && !raw) { resolve(null); return }
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
        const parts = (lines[0] || '').split(',').map(n => parseInt(n, 10))
        const title = lines[1] || ''
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          console.log('[Garo] Titulo da janela:', title || '(sem titulo)')
          resolve({ x: parts[0], y: parts[1], width: parts[2], height: parts[3], title })
        } else {
          resolve(null)
        }
      }
    )
  })
}

// Retorna bounds do virtual desktop em pixels fisicos
function getVirtualDesktopPhysical() {
  const all = screen.getAllDisplays()
  let minX = 0, minY = 0, maxX = 0, maxY = 0
  for (const d of all) {
    const sf = d.scaleFactor || 1
    const l = Math.round(d.bounds.x * sf)
    const t = Math.round(d.bounds.y * sf)
    const r = Math.round((d.bounds.x + d.bounds.width)  * sf)
    const b = Math.round((d.bounds.y + d.bounds.height) * sf)
    if (l < minX) minX = l
    if (t < minY) minY = t
    if (r > maxX) maxX = r
    if (b > maxY) maxY = b
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// Clipa physicalBounds para nao ultrapassar os limites do virtual desktop
function clampToDesktop(pb) {
  const vd = getVirtualDesktopPhysical()
  const x = Math.max(pb.x, vd.x)
  const y = Math.max(pb.y, vd.y)
  const r = Math.min(pb.x + pb.width,  vd.x + vd.width)
  const b = Math.min(pb.y + pb.height, vd.y + vd.height)
  return { x, y, width: Math.max(2, r - x), height: Math.max(2, b - y) }
}

// Retorna bounds em pixels fisicos prontos para passar ao gdigrab
function getPrimaryBoundsPhysical() {
  const d = screen.getPrimaryDisplay()
  const sf = d.scaleFactor || 1
  return { x: 0, y: 0, width: Math.round(d.bounds.width * sf), height: Math.round(d.bounds.height * sf) }
}

async function handleStart(fromAutoRestart = false) {
  if (fromAutoRestart) segmentCount++
  else segmentCount = 1

  const s = loadSettings()
  const outputPath = getOutputPath(s.outputFolder)
  const splitInterval = parseInt(s.splitInterval) || 0
  startSplitTimer(splitInterval)

  // Modo WGC: delega ao renderer (MediaRecorder + WGC do Chromium)
  if (s.captureMode === 'wgc') {
    const src = s.source || {}
    const sourceId = src.id || ''
    if (!sourceId) {
      stopSplitTimer()
      mainWindow && mainWindow.webContents.send('recording-error', {
        message: 'WGC requer uma janela ou tela selecionada no seletor de fontes.'
      })
      return
    }
    const tempPath = outputPath.replace('.mp4', '_wgc.webm')
    const hasMic = !!(s.micDevice && s.micDevice !== '')
    wgcState = { active: true, writeStream: null, tempPath, outputPath, hasAudio: hasMic }
    mainWindow && mainWindow.webContents.send('wgc-start', {
      sourceId, outputPath, tempPath, bitrate: s.bitrate || 20,
      micDevice: s.micDevice || null,
      cameras:   (s.cameras || []).filter(c => c.enabled),
      segment:   segmentCount,
    })
    return
  }

  const encoder = s.encoder === 'auto' ? detectedEncoder : s.encoder
  let source = s.source || { type: 'desktop', name: 'Tela inteira' }

  if (!source.type || source.type === 'desktop') {
    // Desktop sem especificacao: usa apenas o monitor principal
    source = { type: 'screen', name: 'Monitor principal', physicalBounds: getPrimaryBoundsPhysical() }
  } else if (source.type === 'screen') {
    // Monitor selecionado no picker: bounds do Electron sao em DIPs → converte para pixels fisicos
    if (source.bounds) {
      const sf = source.scaleFactor || 1
      source = {
        ...source,
        physicalBounds: {
          x:      Math.round(source.bounds.x      * sf),
          y:      Math.round(source.bounds.y      * sf),
          width:  Math.round(source.bounds.width  * sf),
          height: Math.round(source.bounds.height * sf),
        },
      }
    } else {
      source = { type: 'screen', name: 'Monitor principal', physicalBounds: getPrimaryBoundsPhysical() }
    }
  } else if (source.type === 'window') {
    // Janela: busca posicao real via HWND (source.id) ou titulo parcial
    console.log('[Garo] Buscando bounds da janela:', source.name, '| ID:', source.id || 'sem ID')
    const rawBounds = await getWindowBoundsAsync(source.id, source.name)
    if (rawBounds && rawBounds.width > 0) {
      console.log('[Garo] Bounds encontrados:', rawBounds)
      const clamped = clampToDesktop(rawBounds)
      console.log('[Garo] Bounds ajustados:', clamped)
      source = { ...source, physicalBounds: clamped, gdigrabTitle: rawBounds.title || null }
    } else {
      console.log('[Garo] Janela nao encontrada, usando monitor principal')
      source = { type: 'screen', name: 'Monitor principal', physicalBounds: getPrimaryBoundsPhysical() }
    }
  }

  recorder.start({
    outputPath,
    fps:             s.fps,
    bitrate:         s.bitrate,
    encoder,
    fallbackEncoder: detectedEncoder,
    micDevice:       s.micDevice      || null,
    sysAudioDevice:  s.sysAudioDevice || null,
    cameras:         s.cameras        || [],
    source,
  })
}

function handleStop(autoRestart = false) {
  stopSplitTimer()
  pendingAutoRestart = autoRestart
  if (wgcState.active) {
    mainWindow && mainWindow.webContents.send('wgc-stop')
    return
  }
  recorder.stop()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    resizable: false,
    backgroundColor: '#0f0f1a',
    title: 'Garo Producoes',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  })

  // Auto-aprova permissoes de midia (microfone/camera) para pagina local
  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => {
    callback(['media', 'mediaKeySystem'].includes(permission))
  })

  mainWindow.loadFile('src/ui/index.html')
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide() }
  })

  // Aguarda deteccao terminar antes de enviar init
  mainWindow.webContents.on('did-finish-load', async () => {
    const enc = await encoderDetectionPromise
    const monitorHz = screen.getPrimaryDisplay().displayFrequency || 60
    mainWindow.webContents.send('init', {
      settings: loadSettings(),
      detectedEncoder: enc,
      monitorHz,
    })
  })
}

app.whenReady().then(() => {
  createWindow()

  tray = new Tray(makeTrayIcon(false))
  tray.on('click', () => mainWindow && (mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show()))
  updateTray()

  globalShortcut.register('F9',  () => { if (!isAnyRecording()) handleStart() })
  globalShortcut.register('F10', () => { if (isAnyRecording())  handleStop()  })

  recorder.on('started',  ({ outputPath }) => {
    updateTray()
    mainWindow && mainWindow.webContents.send('recording-started', { outputPath, segment: segmentCount })
  })
  recorder.on('stopped',  ({ outputPath, code }) => {
    updateTray()
    const restart = pendingAutoRestart
    pendingAutoRestart = false
    mainWindow && mainWindow.webContents.send('recording-stopped', { outputPath, code, autoRestart: restart })
    if (restart && !app.isQuitting) setTimeout(() => handleStart(true), 300)
  })
  recorder.on('progress', (data) => {
    mainWindow && mainWindow.webContents.send('recording-progress', data)
  })
  recorder.on('error',    (err) => {
    stopSplitTimer()
    pendingAutoRestart = false
    updateTray()
    mainWindow && mainWindow.webContents.send('recording-error', { message: err.message })
  })
  recorder.on('warn',     (msg) => {
    mainWindow && mainWindow.webContents.send('recording-warn', { message: msg })
  })
  recorder.on('encoder-fallback', (enc) => {
    mainWindow && mainWindow.webContents.send('recording-warn', {
      message: `Encoder alterado para ${enc} (hardware indisponivel)`
    })
  })
})

app.on('before-quit', () => { app.isQuitting = true })
app.on('will-quit',   () => globalShortcut.unregisterAll())

// IPC
ipcMain.handle('get-settings',    () => loadSettings())
ipcMain.handle('save-settings',   (_, s) => { saveSettings(s); return true })
ipcMain.handle('start-recording', () => handleStart())
ipcMain.handle('stop-recording',  () => handleStop())
ipcMain.handle('detect-encoder',  () => encoderDetectionPromise)
ipcMain.handle('get-init-data',   async () => ({
  settings: loadSettings(),
  detectedEncoder: await encoderDetectionPromise,
  monitorHz: screen.getPrimaryDisplay().displayFrequency || 60,
}))

ipcMain.handle('select-folder', async () => {
  try {
    if (mainWindow) { mainWindow.setAlwaysOnTop(true); mainWindow.focus() }
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecionar pasta de saida',
      properties: ['openDirectory'],
      defaultPath: os.homedir()
    })
    if (mainWindow) mainWindow.setAlwaysOnTop(false)
    return r.canceled ? null : r.filePaths[0]
  } catch (e) {
    if (mainWindow) mainWindow.setAlwaysOnTop(false)
    return null
  }
})

ipcMain.handle('open-file',   (_, p) => shell.openPath(p))
ipcMain.handle('open-folder', (_, p) => shell.openPath(p))

ipcMain.handle('get-sources', async () => {
  let sources = []
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    })
  } catch (e) {
    console.error('[Garo] getSources falhou:', e.message)
  }
  const result = sources.map(s => ({
    id:         s.id,
    name:       s.name,
    type:       s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail:  s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
    display_id: s.display_id,
  }))
  console.log('[Garo] Fontes encontradas:', result.length,
    '|', result.map(s => `${s.type}:${s.name}`).join(', '))
  return result
})

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map(d => ({
    id:          String(d.id),
    bounds:      d.bounds,
    scaleFactor: d.scaleFactor,
    label:       d.label || `Monitor ${d.id}`,
  }))
})

// ── Handlers WGC (MediaRecorder no renderer → arquivo MP4 via FFmpeg) ──────────
ipcMain.handle('wgc-start-write', async (_, tempPath) => {
  try {
    wgcState.writeStream = fs.createWriteStream(tempPath)
    updateTray()
    mainWindow && mainWindow.webContents.send('recording-started', { outputPath: wgcState.outputPath, segment: segmentCount })
    console.log('[WGC] Escrita iniciada:', tempPath)
  } catch (e) {
    console.error('[WGC] Erro ao abrir arquivo:', e.message)
  }
})

ipcMain.handle('wgc-chunk', async (_, chunk) => {
  if (wgcState.writeStream && chunk && chunk.length > 0) {
    wgcState.writeStream.write(Buffer.from(chunk))
  }
})

ipcMain.handle('wgc-finalize', async (_, outputPath) => {
  console.log('[WGC] Finalizando...')
  if (wgcState.writeStream) {
    await new Promise(r => wgcState.writeStream.end(r))
    wgcState.writeStream = null
  }
  try {
    mainWindow && mainWindow.webContents.send('recording-warn', { message: 'Convertendo para MP4...' })
    await convertWebmToMp4(wgcState.tempPath, outputPath, wgcState.hasAudio)
    try { fs.unlinkSync(wgcState.tempPath) } catch {}
    console.log('[WGC] Convertido com sucesso:', outputPath)
  } catch (e) {
    console.error('[WGC→MP4] Erro:', e.message)
    mainWindow && mainWindow.webContents.send('recording-error', { message: 'Conversão WGC falhou: ' + e.message })
    wgcState = { active: false, writeStream: null, tempPath: null, outputPath: null }
    updateTray()
    return
  }
  wgcState = { active: false, writeStream: null, tempPath: null, outputPath: null }
  updateTray()
  const restart = pendingAutoRestart
  pendingAutoRestart = false
  mainWindow && mainWindow.webContents.send('recording-stopped', { outputPath, code: 0, autoRestart: restart })
  if (restart && !app.isQuitting) setTimeout(() => handleStart(true), 300)
})

ipcMain.handle('wgc-error', async (_, msg) => {
  console.error('[WGC] Erro:', msg)
  stopSplitTimer()
  pendingAutoRestart = false
  if (wgcState.writeStream) { try { wgcState.writeStream.end() } catch {} }
  if (wgcState.tempPath) { try { fs.unlinkSync(wgcState.tempPath) } catch {} }
  wgcState = { active: false, writeStream: null, tempPath: null, outputPath: null }
  updateTray()
  mainWindow && mainWindow.webContents.send('recording-error', { message: 'WGC: ' + msg })
})

ipcMain.handle('get-dshow-devices', () => {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', () => {
      const audio = [], video = []
      let section = ''
      for (const line of stderr.split('\n')) {
        if (/DirectShow video devices/i.test(line)) { section = 'video'; continue }
        if (/DirectShow audio devices/i.test(line)) { section = 'audio'; continue }
        const m = line.match(/\[dshow[^\]]*\]\s+"([^"]+)"/)
        if (!m) continue
        if (section === 'audio') audio.push(m[1])
        if (section === 'video') video.push(m[1])
      }
      console.log('[DShow] Audio:', audio, '| Video:', video)
      resolve({ audio, video })
    })
    proc.on('error', () => resolve({ audio: [], video: [] }))
  })
})

ipcMain.handle('get-recent', () => {
  const s = loadSettings()
  try {
    return fs.readdirSync(s.outputFolder)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const full = path.join(s.outputFolder, f)
        const stat = fs.statSync(full)
        return { name: f, path: full, size: stat.size, mtime: stat.mtime.getTime() }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10)
  } catch { return [] }
})
