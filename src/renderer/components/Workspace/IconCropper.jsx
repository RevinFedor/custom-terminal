import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Loader2 } from 'lucide-react'

const VIEWPORT = 280
const OUTPUT = 64

function canvasToPngDataUrl(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas did not produce an image'))
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result)
        else reject(new Error('Failed to encode cropped image'))
      }
      reader.onerror = () => reject(reader.error || new Error('Failed to encode cropped image'))
      reader.readAsDataURL(blob)
    }, 'image/png')
  })
}

function IconCropper({ imageSrc, onCrop, onCancel, onReplaceRequest }) {
  const canvasRef = useRef(null)
  const prev32Ref = useRef(null)
  const prev16Ref = useRef(null)
  const imgRef = useRef(null)
  const dragRef = useRef({ active: false, x: 0, y: 0, ox: 0, oy: 0 })
  const replaceInputRef = useRef(null)
  const mouseDownOnOverlay = useRef(false)
  const mountedRef = useRef(true)

  const [currentSrc, setCurrentSrc] = useState(imageSrc)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [applyPhase, setApplyPhase] = useState('idle')
  const [applyError, setApplyError] = useState('')
  const isApplying = applyPhase !== 'idle'

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    setCurrentSrc(imageSrc)
  }, [imageSrc])

  // Load image (reacts to currentSrc changes)
  useEffect(() => {
    if (!currentSrc) return
    let cancelled = false
    setReady(false)
    setLoadError('')
    setApplyError('')
    imgRef.current = null
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      imgRef.current = img
      const fit = VIEWPORT / Math.max(img.width, img.height)
      setZoom(fit)
      setOffset({
        x: (VIEWPORT - img.width * fit) / 2,
        y: (VIEWPORT - img.height * fit) / 2
      })
      setReady(true)
    }
    img.onerror = () => {
      if (cancelled) return
      setLoadError('Не удалось открыть изображение.')
    }
    img.src = currentSrc
    return () => {
      cancelled = true
      img.onload = null
      img.onerror = null
    }
  }, [currentSrc])

  const handleReplaceFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setCurrentSrc(reader.result)
    }
    reader.onerror = () => setLoadError('Не удалось прочитать изображение.')
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  // Draw main + previews
  const draw = useCallback(() => {
    const img = imgRef.current
    if (!img) return

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Checkerboard bg
    const s = 10
    for (let y = 0; y < VIEWPORT; y += s) {
      for (let x = 0; x < VIEWPORT; x += s) {
        ctx.fillStyle = ((x / s + y / s) % 2) === 0 ? '#1e1e2e' : '#252538'
        ctx.fillRect(x, y, s, s)
      }
    }

    ctx.drawImage(img, offset.x, offset.y, img.width * zoom, img.height * zoom)

    // Previews
    for (const [ref, size] of [[prev32Ref, 32], [prev16Ref, 16]]) {
      const c = ref.current
      if (!c) continue
      const pctx = c.getContext('2d')
      if (!pctx) continue
      pctx.fillStyle = '#1e1e2e'
      pctx.fillRect(0, 0, size, size)
      const sc = size / VIEWPORT
      pctx.drawImage(img,
        offset.x * sc, offset.y * sc,
        img.width * zoom * sc, img.height * zoom * sc
      )
    }
  }, [zoom, offset])

  useEffect(() => { if (ready) draw() }, [draw, ready])

  // Drag
  const onMouseDown = (e) => {
    if (isApplying || !ready) return
    dragRef.current = { active: true, x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d.active) return
      setOffset({
        x: d.ox + (e.clientX - d.x),
        y: d.oy + (e.clientY - d.y)
      })
    }
    const onUp = () => { dragRef.current.active = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // Wheel zoom (non-passive for preventDefault)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (e) => {
      if (isApplying || !ready) return
      e.preventDefault()
      const factor = e.deltaY > 0 ? 0.92 : 1.08
      setZoom(prev => {
        const nz = prev * factor
        const rect = canvas.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        setOffset(off => ({
          x: mx - (mx - off.x) * factor,
          y: my - (my - off.y) * factor
        }))
        return nz
      })
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [isApplying, ready])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' || isApplying) return
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isApplying, onCancel])

  const handleCrop = async () => {
    const img = imgRef.current
    if (!img || !ready || isApplying) return
    dragRef.current.active = false
    setApplyError('')
    setApplyPhase('processing')
    try {
      const out = document.createElement('canvas')
      out.width = OUTPUT
      out.height = OUTPUT
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('Canvas is unavailable')
      const srcX = -offset.x / zoom
      const srcY = -offset.y / zoom
      const srcSize = VIEWPORT / zoom
      ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, OUTPUT, OUTPUT)
      const minimized = await canvasToPngDataUrl(out)
      if (mountedRef.current) setApplyPhase('saving')
      await Promise.resolve(onCrop(minimized))
    } catch (error) {
      console.error('[IconCropper] failed to apply crop:', error)
      if (mountedRef.current) setApplyError('Не удалось сохранить иконку. Попробуйте ещё раз.')
    } finally {
      if (mountedRef.current) setApplyPhase('idle')
    }
  }

  const handleReplaceClick = () => {
    if (isApplying) return
    setApplyError('')
    if (onReplaceRequest) onReplaceRequest()
    else replaceInputRef.current?.click()
  }

  return (
    <div
      className="icon-cropper-overlay"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget }}
      onClick={(e) => {
        const shouldCancel = e.target === e.currentTarget && mouseDownOnOverlay.current && !isApplying
        mouseDownOnOverlay.current = false
        if (shouldCancel) onCancel()
      }}
    >
      <div
        className="icon-cropper-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="icon-cropper-title"
        aria-busy={isApplying || undefined}
        onClick={e => e.stopPropagation()}
      >
        <h3 id="icon-cropper-title" className="icon-cropper-title">Обрезка иконки</h3>

        <div className="icon-cropper-viewport" style={{ position: 'relative' }}>
          <canvas
            ref={canvasRef}
            width={VIEWPORT}
            height={VIEWPORT}
            onMouseDown={onMouseDown}
            aria-label="Область обрезки; перетащите изображение мышью"
            style={{ opacity: ready ? 1 : 0.35, pointerEvents: isApplying ? 'none' : 'auto' }}
          />
          {!ready && (
            <div
              role={loadError ? 'alert' : 'status'}
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '7px',
                color: loadError ? '#f87171' : '#b0b0b5',
                fontSize: '12px',
                lineHeight: 1.3,
              }}
            >
              {!loadError && <Loader2 size={14} className="animate-spin" />}
              {loadError || 'Загрузка изображения…'}
            </div>
          )}
        </div>

        <div className="icon-cropper-zoom">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.4">
            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
          </svg>
          <input
            type="range"
            aria-label="Масштаб изображения"
            min={0.02}
            max={8}
            step={0.01}
            value={zoom}
            disabled={!ready || isApplying}
            onChange={e => {
              const nz = parseFloat(e.target.value)
              const cx = VIEWPORT / 2
              const cy = VIEWPORT / 2
              setOffset(prev => ({
                x: cx - (cx - prev.x) * (nz / zoom),
                y: cy - (cy - prev.y) * (nz / zoom)
              }))
              setZoom(nz)
            }}
            className="icon-cropper-slider"
          />
        </div>

        <div className="icon-cropper-preview">
          <span className="icon-cropper-preview-label">Предпросмотр</span>
          <canvas ref={prev32Ref} width={32} height={32} className="icon-cropper-preview-canvas" />
          <canvas ref={prev16Ref} width={16} height={16} className="icon-cropper-preview-canvas" />
        </div>

        {applyError && (
          <div role="alert" style={{ margin: '-8px 0 12px', color: '#f87171', fontSize: '11px', lineHeight: 1.35 }}>
            {applyError}
          </div>
        )}

        <div className="icon-cropper-actions">
          <button
            type="button"
            onClick={handleReplaceClick}
            className="icon-cropper-btn replace"
            disabled={isApplying}
            style={{ opacity: isApplying ? 0.45 : 1, cursor: isApplying ? 'not-allowed' : 'pointer' }}
          >
            Заменить
          </button>
          {!onReplaceRequest && (
            <input ref={replaceInputRef} type="file" accept="image/*,.svg" hidden onChange={handleReplaceFile} />
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onCancel}
            className="icon-cropper-btn cancel"
            disabled={isApplying}
            style={{ opacity: isApplying ? 0.45 : 1, cursor: isApplying ? 'not-allowed' : 'pointer' }}
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleCrop()}
            className="icon-cropper-btn apply"
            disabled={!ready || isApplying}
            aria-busy={isApplying || undefined}
            style={{
              minWidth: '112px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              opacity: !ready || isApplying ? 0.65 : 1,
              cursor: !ready || isApplying ? 'not-allowed' : 'pointer',
            }}
          >
            {isApplying && <Loader2 size={13} className="animate-spin" />}
            {applyPhase === 'processing'
              ? 'Обработка…'
              : applyPhase === 'saving'
                ? 'Сохранение…'
                : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default IconCropper
