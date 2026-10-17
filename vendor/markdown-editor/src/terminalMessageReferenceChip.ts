import { terminalMessageLabel } from './terminalMessageReference.mjs'

type Snapshot = { referenceId: string; source: any; detailsText: string }
type ChipOptions = {
  openDetails: (snapshot: Snapshot) => void
  navigate: (snapshot: Snapshot) => void | Promise<unknown>
  error?: (reason: string) => void
  allowDetails?: () => boolean
}
// One modifier listener per document; only its currently hovered/focused chip
// receives feedback. No React state, layout sampling, background RPC or timer.
const controllers = new WeakMap<Document, { active: HTMLElement | null; meta: boolean; refs: number; dispose: () => void }>()
function controller(document: Document) {
  let current = controllers.get(document)
  if (current) return current
  const window = document.defaultView!
  const paint = (meta: boolean) => { if (current) { current.meta = meta; current.active?.classList.toggle('cm-terminal-message--navigate', meta) } }
  const key = (event: KeyboardEvent) => paint(event.metaKey || event.ctrlKey)
  const blur = () => { paint(false); if (current) current.active = null }
  document.addEventListener('keydown', key, true)
  document.addEventListener('keyup', key, true)
  window.addEventListener('blur', blur)
  current = { active: null, meta: false, refs: 0, dispose: () => {
    document.removeEventListener('keydown', key, true)
    document.removeEventListener('keyup', key, true)
    window.removeEventListener('blur', blur)
    controllers.delete(document)
  } }
  controllers.set(document, current)
  return current
}
export function attachTerminalMessageChip(chip: HTMLElement, snapshot: Snapshot, options: ChipOptions) {
  const control = controller(chip.ownerDocument)
  control.refs++
  chip.dataset.terminalMessageReference = snapshot.referenceId
  chip.setAttribute('role', 'button')
  chip.tabIndex = 0
  chip.title = `${terminalMessageLabel(snapshot)}\nКлик — Details · ⌘+клик — открыть сообщение в Noted Terminal`
  const activate = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault(); event.stopPropagation()
    if (event.metaKey || event.ctrlKey) {
      Promise.resolve().then(() => options.navigate(snapshot)).catch(error => options.error?.(String(error?.message || error)))
    } else if ('key' in event || options.allowDetails?.() !== false) options.openDetails(snapshot)
  }
  const click = (event: MouseEvent) => { if (event.button === 0 && event.detail <= 1) activate(event) }
  const key = (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') activate(event) }
  const enter = (event: MouseEvent) => {
    if (control.active && control.active !== chip) control.active.classList.remove('cm-terminal-message--navigate')
    control.active = chip
    control.meta = event.metaKey || event.ctrlKey
    chip.classList.toggle('cm-terminal-message--navigate', event.metaKey || event.ctrlKey)
  }
  const leave = () => { chip.classList.remove('cm-terminal-message--navigate'); if (control.active === chip) control.active = null }
  const focus = () => {
    if (control.active && control.active !== chip) control.active.classList.remove('cm-terminal-message--navigate')
    control.active = chip; chip.classList.toggle('cm-terminal-message--navigate', control.meta)
  }
  const down = (event: MouseEvent) => {
    // Cmd navigation must not move the editor's selection or disappear inside
    // CM before click. Ordinary selection/drag still belongs to the editor.
    if (event.button === 0 && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation() }
  }
  chip.addEventListener('click', click)
  chip.addEventListener('keydown', key)
  chip.addEventListener('mouseenter', enter)
  chip.addEventListener('mouseleave', leave)
  chip.addEventListener('focus', focus)
  chip.addEventListener('blur', leave)
  chip.addEventListener('mousedown', down)
  return () => {
    leave()
    chip.removeEventListener('click', click); chip.removeEventListener('keydown', key)
    chip.removeEventListener('mouseenter', enter); chip.removeEventListener('mouseleave', leave)
    chip.removeEventListener('focus', focus); chip.removeEventListener('blur', leave); chip.removeEventListener('mousedown', down)
    if (--control.refs === 0) control.dispose()
  }
}

// GT's full Markdown editor has no host-owned paste sidecar. The same snapshot
// is shown here only on explicit click; NT/Voice pass their existing viewer.
export function openTerminalMessageDetails(document: Document, snapshot: Snapshot, copy: (text: string) => unknown) {
  const window = document.defaultView!, panel = document.createElement('div')
  panel.className = 'cm-terminal-message-details'
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Details')
  Object.assign(panel.style, { position: 'fixed', inset: '12% 15%', zIndex: '10020', overflow: 'auto', background: '#171717',
    color: '#ddd', border: '1px solid #555', borderRadius: '8px', padding: '12px', boxShadow: '0 8px 30px #0008' })
  const controls = document.createElement('div'), copyButton = document.createElement('button'), closeButton = document.createElement('button')
  copyButton.textContent = 'Копировать'; closeButton.textContent = '×'
  const pre = document.createElement('pre'); pre.textContent = snapshot.detailsText; pre.style.whiteSpace = 'pre-wrap'
  const close = () => { panel.remove(); window.removeEventListener('keydown', escape) }
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
  copyButton.onclick = () => { Promise.resolve().then(() => copy(snapshot.detailsText)).catch(() => { copyButton.textContent = 'Ошибка копирования' }) }
  closeButton.onclick = close
  controls.append(copyButton, closeButton); panel.append(controls, pre); document.body.appendChild(panel)
  window.addEventListener('keydown', escape); closeButton.focus()
  return close
}
