const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('garo', {
  getSettings:    ()  => ipcRenderer.invoke('get-settings'),
  getInitData:    ()  => ipcRenderer.invoke('get-init-data'),
  saveSettings:   (s) => ipcRenderer.invoke('save-settings', s),
  detectEncoder:  ()  => ipcRenderer.invoke('detect-encoder'),
  selectFolder:   ()  => ipcRenderer.invoke('select-folder'),
  startRecording: ()  => ipcRenderer.invoke('start-recording'),
  stopRecording:  ()  => ipcRenderer.invoke('stop-recording'),
  openFile:       (p) => ipcRenderer.invoke('open-file', p),
  openFolder:     (p) => ipcRenderer.invoke('open-folder', p),
  getRecent:      ()  => ipcRenderer.invoke('get-recent'),
  getSources:      ()  => ipcRenderer.invoke('get-sources'),
  getDisplays:     ()  => ipcRenderer.invoke('get-displays'),
  getDshowDevices: ()  => ipcRenderer.invoke('get-dshow-devices'),

  // WGC mode
  wgcStartWrite:  (t) => ipcRenderer.invoke('wgc-start-write', t),
  wgcChunk:       (c) => ipcRenderer.invoke('wgc-chunk', c),
  wgcFinalize:    (p) => ipcRenderer.invoke('wgc-finalize', p),
  wgcError:       (m) => ipcRenderer.invoke('wgc-error', m),

  onInit:              (cb) => ipcRenderer.on('init',              (_, d) => cb(d)),
  onRecordingStarted:  (cb) => ipcRenderer.on('recording-started', (_, d) => cb(d)),
  onRecordingStopped:  (cb) => ipcRenderer.on('recording-stopped', (_, d) => cb(d)),
  onRecordingProgress: (cb) => ipcRenderer.on('recording-progress',(_, d) => cb(d)),
  onRecordingError:    (cb) => ipcRenderer.on('recording-error',   (_, d) => cb(d)),
  onRecordingWarn:     (cb) => ipcRenderer.on('recording-warn',    (_, d) => cb(d)),
  onWgcStart:          (cb) => ipcRenderer.on('wgc-start',         (_, d) => cb(d)),
  onWgcStop:           (cb) => ipcRenderer.on('wgc-stop',          ()     => cb()),
})
