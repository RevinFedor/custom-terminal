import React, { useState, useRef, useEffect, useCallback } from 'react'

const VIEWPORT = 280
const OUTPUT = 64

function IconCropper({ imageSrc, onCrop, onCancel }) {
  const canvasRef = useRef(null)
  const prev32Ref = useRef(null)
  const prev16Ref = useRef(null)
  const imgRef = useRef(null)
  const dragRef = useRef({ active: false, x: 0, y: 0, ox: 0, oy: 0 })
  const replaceInputRef = useRef(null)

  const [currentSrc, setCurrentSrc] = useState(imageSrc)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [ready, setReady] = useState(false)

  // Load image (reacts to currentSrc changes)
  useEffect(() => {
    if (!currentSrc) return
    setReady(false)
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      const fit = VIEWPORT / Math.max(img.width, img.height)
      setZoom(fit)
      setOffset({
        x: (VIEWPORT - img.width * fit) / 2,
        y: (VIEWPORT - img.height * fit) / 2
      })
      setReady(true)
    }
    img.src = currentSrc
  }, [currentSrc])

  const handleReplaceFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setCurrentSrc(reader.result)
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
  }, [])

  const handleCrop = () => {
    const img = imgRef.current
    if (!img) return
    const out = document.createElement('canvas')
    out.width = OUTPUT
    out.height = OUTPUT
    const ctx = out.getContext('2d')
    const srcX = -offset.x / zoom
    const srcY = -offset.y / zoom
    const srcSize = VIEWPORT / zoom
    ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, OUTPUT, OUTPUT)
    onCrop(out.toDataURL('image/png'))
  }

  return (
    <div className="icon-cropper-overlay" onClick={onCancel}>
      <div className="icon-cropper-modal" onClick={e => e.stopPropagation()}>
        <h3 className="icon-cropper-title">Crop Icon</h3>

        <div className="icon-cropper-viewport">
          <canvas
            ref={canvasRef}
            width={VIEWPORT}
            height={VIEWPORT}
            onMouseDown={onMouseDown}
          />
        </div>

        <div className="icon-cropper-zoom">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.4">
            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
          </svg>
          <input
            type="range"
            min={0.02}
            max={8}
            step={0.01}
            value={zoom}
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
          <span className="icon-cropper-preview-label">Preview</span>
          <canvas ref={prev32Ref} width={32} height={32} className="icon-cropper-preview-canvas" />
          <canvas ref={prev16Ref} width={16} height={16} className="icon-cropper-preview-canvas" />
        </div>

        <div className="icon-cropper-actions">
          <button onClick={() => replaceInputRef.current?.click()} className="icon-cropper-btn replace">Replace</button>
          <input ref={replaceInputRef} type="file" accept="image/*" hidden onChange={handleReplaceFile} />
          <div style={{ flex: 1 }} />
          <button onClick={onCancel} className="icon-cropper-btn cancel">Cancel</button>
          <button onClick={handleCrop} className="icon-cropper-btn apply">Apply</button>
        </div>
      </div>
    </div>
  )
}

export default IconCropper
