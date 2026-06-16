const { spawn } = require('child_process')
const EventEmitter = require('events')

let ffmpegPath
try {
  ffmpegPath = require('ffmpeg-static')
} catch {
  ffmpegPath = 'ffmpeg'
}

class Recorder extends EventEmitter {
  constructor() {
    super()
    this.process = null
    this.isRecording = false
  }

  // Testa se um encoder realmente funciona (nao so se aparece na lista)
  _testEncoder(encoder) {
    return new Promise((resolve) => {
      const proc = spawn(ffmpegPath, [
        '-f', 'lavfi', '-i', 'color=s=320x240:r=1',
        '-frames:v', '1',
        '-c:v', encoder,
        '-f', 'null', '-'
      ], { windowsHide: true })
      let stderr = ''
      proc.stderr.on('data', d => { stderr += d.toString() })
      proc.on('close', (code) => {
        const ok = code === 0 &&
          !stderr.includes('DLL') &&
          !stderr.includes('Error while opening') &&
          !stderr.includes('Cannot load')
        console.log(`[encoder test] ${encoder}: ${ok ? 'OK' : 'FALHOU'} (code ${code})`)
        resolve(ok)
      })
      proc.on('error', () => resolve(false))
    })
  }

  async detectEncoder() {
    const candidates = [
      'hevc_amf', 'hevc_nvenc', 'hevc_qsv',
      'h264_amf', 'h264_nvenc', 'h264_qsv',
      'libx264',
    ]
    for (const enc of candidates) {
      if (await this._testEncoder(enc)) return enc
    }
    return 'libx264'
  }

  _buildVideoArgs(fps, source) {
    const src = source || {}

    // Sempre usa desktop + offset: captura a partir do compositor do Windows,
    // o que inclui conteúdo renderizado por GPU (Electron, Chrome, DX12, etc).
    // gdigrab title= usa BitBlt GDI e retorna preto para apps com GPU rendering.
    const pb = src.physicalBounds
    if (pb && pb.width > 0 && pb.height > 0) {
      const w = Math.max(2, Math.floor(pb.width  / 2) * 2)
      const h = Math.max(2, Math.floor(pb.height / 2) * 2)
      const x = Math.max(0, pb.x)
      const y = Math.max(0, pb.y)
      console.log(`[FFmpeg] Capturando area: offset=${x},${y} size=${w}x${h}${src.gdigrabTitle ? ` (janela: ${src.gdigrabTitle})` : ''}`)
      return [
        '-f', 'gdigrab', '-framerate', String(fps),
        '-offset_x', String(x),
        '-offset_y', String(y),
        '-video_size', `${w}x${h}`,
        '-i', 'desktop',
      ]
    }

    // Fallback: desktop inteiro
    return ['-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop']
  }

  _buildEncoderArgs(encoder, bitrate) {
    const args = ['-c:v', encoder]
    if (encoder === 'hevc_amf' || encoder === 'h264_amf') {
      args.push('-b:v', `${bitrate}M`)
    } else if (encoder === 'hevc_nvenc' || encoder === 'h264_nvenc') {
      args.push('-preset', 'p4', '-b:v', `${bitrate}M`)
    } else if (encoder === 'hevc_qsv' || encoder === 'h264_qsv') {
      args.push('-b:v', `${bitrate}M`)
    } else {
      args.push('-preset', 'fast', '-crf', '23')
    }
    return args
  }

  _buildArgs(settings, encoder) {
    const { outputPath, fps, bitrate, source, micDevice, sysAudioDevice } = settings
    const hasMic = !!(micDevice && micDevice !== '')
    const hasSys = !!(sysAudioDevice && sysAudioDevice !== '')
    const VF = 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p'

    const videoIn = this._buildVideoArgs(fps, source)
    const encArgs = this._buildEncoderArgs(encoder, bitrate)

    if (hasMic && hasSys) {
      return [
        ...videoIn,
        '-f', 'dshow', '-i', `audio=${micDevice}`,
        '-f', 'dshow', '-i', `audio=${sysAudioDevice}`,
        '-filter_complex', `[0:v]${VF}[vout];[1:a][2:a]amix=inputs=2:duration=first[aout]`,
        '-map', '[vout]', '-map', '[aout]',
        ...encArgs,
        '-c:a', 'aac', '-b:a', '192k',
        '-y', outputPath,
      ]
    } else if (hasMic || hasSys) {
      const audioName = hasMic ? micDevice : sysAudioDevice
      return [
        ...videoIn,
        '-f', 'dshow', '-i', `audio=${audioName}`,
        '-vf', VF,
        ...encArgs,
        '-c:a', 'aac', '-b:a', '192k',
        '-y', outputPath,
      ]
    } else {
      return [
        ...videoIn,
        '-vf', VF,
        ...encArgs,
        '-an',
        '-y', outputPath,
      ]
    }
  }

  start(settings) {
    if (this.process) {
      try { this.process.kill('SIGKILL') } catch {}
      this.process = null
    }
    this.isRecording = false
    this._tryStart(settings, settings.encoder, false)
    return true
  }

  _tryStart(settings, encoder, isRetry) {
    const args = this._buildArgs(settings, encoder)
    let stderrLog = ''

    console.log('[FFmpeg] Iniciando com encoder:', encoder)
    console.log('[FFmpeg] Args:', args.join(' '))

    this.process = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (!isRetry) {
      this.isRecording = true
      this.emit('started', { outputPath: settings.outputPath })
    }

    this.process.stderr.on('data', (data) => {
      const str = data.toString()
      stderrLog += str
      process.stdout.write('[FFmpeg] ' + str)

      const m = str.match(/time=(\d+):(\d+):(\d+)/)
      if (m) {
        const elapsed = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
        this.emit('progress', { elapsed })
      }
    })

    this.process.on('close', (code) => {
      this.isRecording = false
      this.process = null
      console.log(`[FFmpeg] encerrou com codigo ${code} (encoder: ${encoder})`)

      if (code !== 0) {
        // gdigrab area error — not an encoder problem, never retry
        if (stderrLog.includes('Error opening input') || stderrLog.includes('extends outside window area')) {
          this.emit('error', new Error('Área de captura inválida. Reabra o app e selecione a fonte novamente.'))
          return
        }

        // Only treat as hardware error when the encoder context line appears: [hevc_qsv @ 0x...]
        // Avoids matching "--enable-nvenc" or "libvpl" in the FFmpeg config string printed to every stderr.
        const isHwError =
          stderrLog.includes('amfrt64') ||
          stderrLog.includes('DLL load failed') ||
          /\[(?:h264|hevc)_(?:amf|nvenc|qsv) @ /.test(stderrLog) ||
          stderrLog.includes('Error while opening encoder') ||
          stderrLog.includes('Conversion failed')

        if (isHwError) {
          // Tenta fallbackEncoder (detectado como funcional) antes de CPU puro
          const fallback = settings.fallbackEncoder || 'libx264'
          if (encoder !== fallback) {
            this.emit('warn', `${encoder} indisponivel em tempo de execucao — usando ${fallback}.`)
            this.emit('encoder-fallback', fallback)
            this._tryStart(settings, fallback, true)
            return
          }
          // Se o fallbackEncoder tambem falhou, usa libx264 como ultima opcao
          if (encoder !== 'libx264') {
            this.emit('warn', `${encoder} falhou — usando CPU (libx264).`)
            this.emit('encoder-fallback', 'libx264')
            this._tryStart(settings, 'libx264', true)
            return
          }
        }

        const errLine = stderrLog.split('\n')
          .filter(l => /error|failed|invalid|cannot/i.test(l))
          .pop() || 'FFmpeg encerrou inesperadamente.'
        this.emit('error', new Error(errLine.trim()))
        return
      }

      this.emit('stopped', { outputPath: settings.outputPath, code })
    })

    this.process.on('error', (err) => {
      this.isRecording = false
      this.process = null
      this.emit('error', err)
    })
  }

  stop() {
    if (!this.process) return false
    try {
      this.process.stdin.write('q')
    } catch {
      try { this.process.kill('SIGTERM') } catch {}
    }
    this.isRecording = false
    return true
  }
}

module.exports = { Recorder }
