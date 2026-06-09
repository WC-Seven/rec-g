const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, dialog, nativeImage, shell, screen, desktopCapturer } = require('electron')
const path = require('path')
const os   = require('os')
const fs   = require('fs')
const { execFile } = require('child_process')
const { Recorder } = require('./src/recorder')

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

function updateTray() {
  if (!tray) return
  tray.setImage(makeTrayIcon(recorder.isRecording))
  tray.setToolTip(recorder.isRecording ? 'Garo — Gravando...' : 'Garo Producoes')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: recorder.isRecording ? 'Parar gravacao  (F10)' : 'Iniciar gravacao  (F9)',
      click: () => recorder.isRecording ? handleStop() : handleStart()
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

// Obtem bounds reais de uma janela via HWND (preferido) ou titulo parcial
function getWindowBoundsAsync(sourceId, windowTitle) {
  const hwnd = hwndFromSourceId(sourceId)

  let script
  if (hwnd) {
    // Metodo confiavel: usa o HWND do source ID diretamente
    // GetAncestor(GA_ROOT=2) garante que pegamos a janela de nivel superior
    // mesmo que o HWND seja de um child window (como Chrome_RenderWidgetHostHWND)
    script = `
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class GWR {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
    public struct RECT { public int L, T, R, B; }
}
'@ -Language CSharp -ErrorAction SilentlyContinue
  $h = [System.IntPtr][long]${hwnd}
  if ([GWR]::IsWindow($h)) {
    $root = [GWR]::GetAncestor($h, 2)
    if ($root -ne [IntPtr]::Zero) { $h = $root }
    $r = New-Object GWR+RECT
    [GWR]::GetWindowRect($h, [ref]$r) | Out-Null
    Write-Output "$($r.L),$($r.T),$($r.R-$r.L),$($r.B-$r.T)"
  } else {
    Write-Output "0,0,0,0"
  }
} catch {
  Write-Output "0,0,0,0"
}`
  } else {
    // Fallback: busca janela visivel com titulo contendo o texto
    const safeName = (windowTitle || '').replace(/'/g, "''")
    script = `
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class GWE {
    public delegate bool EWP(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EWP p, IntPtr l);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    public struct RECT { public int L, T, R, B; }
}
'@ -Language CSharp -ErrorAction SilentlyContinue
  $search = '${safeName}'
  $found = [IntPtr]::Zero
  [GWE]::EnumWindows({
    param($h, $l)
    if (-not [GWE]::IsWindowVisible($h)) { return $true }
    $sb = New-Object System.Text.StringBuilder(512)
    [GWE]::GetWindowText($h, $sb, 512) | Out-Null
    if ($sb.ToString().Contains($search)) { $script:found = $h; return $false }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  if ($found -eq [IntPtr]::Zero) {
    Write-Output "0,0,0,0"
  } else {
    $r = New-Object GWE+RECT
    [GWE]::GetWindowRect($found, [ref]$r) | Out-Null
    Write-Output "$($r.L),$($r.T),$($r.R-$r.L),$($r.B-$r.T)"
  }
} catch {
  Write-Output "0,0,0,0"
}`
  }

  return new Promise((resolve) => {
    const encoded = encodePsCommand(script)
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 6000 },
      (err, stdout, stderr) => {
        const raw = stdout.trim()
        console.log('[Garo] PS bounds:', raw || '(vazio)', err ? `| err: ${err.code}` : '')
        if (err && !raw) { resolve(null); return }
        const parts = raw.split(',').map(n => parseInt(n, 10))
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          resolve({ x: parts[0], y: parts[1], width: parts[2], height: parts[3] })
        } else {
          resolve(null)
        }
      }
    )
  })
}

// Retorna bounds em pixels fisicos prontos para passar ao gdigrab
function getPrimaryBoundsPhysical() {
  const d = screen.getPrimaryDisplay()
  const sf = d.scaleFactor || 1
  return { x: 0, y: 0, width: Math.round(d.bounds.width * sf), height: Math.round(d.bounds.height * sf) }
}

async function handleStart() {
  const s = loadSettings()
  const encoder = s.encoder === 'auto' ? detectedEncoder : s.encoder
  const outputPath = getOutputPath(s.outputFolder)

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
      source = { ...source, physicalBounds: rawBounds }
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
    captureAudio:    false,
    source,
  })
}

function handleStop() {
  recorder.stop()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 580,
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

  globalShortcut.register('F9',  () => { if (!recorder.isRecording) handleStart() })
  globalShortcut.register('F10', () => { if (recorder.isRecording)  handleStop()  })

  recorder.on('started',  ({ outputPath }) => {
    updateTray()
    mainWindow && mainWindow.webContents.send('recording-started', { outputPath })
  })
  recorder.on('stopped',  ({ outputPath, code }) => {
    updateTray()
    mainWindow && mainWindow.webContents.send('recording-stopped', { outputPath, code })
  })
  recorder.on('progress', (data) => {
    mainWindow && mainWindow.webContents.send('recording-progress', data)
  })
  recorder.on('error',    (err) => {
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
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  })
  return sources.map(s => ({
    id:         s.id,
    name:       s.name,
    type:       s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail:  s.thumbnail.toDataURL(),
    display_id: s.display_id,
  }))
})

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map(d => ({
    id:          String(d.id),
    bounds:      d.bounds,
    scaleFactor: d.scaleFactor,
    label:       d.label || `Monitor ${d.id}`,
  }))
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
