'use strict'
// Wire v1. This file is byte-identical in SC and Noted. No Electron dependency.
// The journal proves only the enrolled cohort, never absence of pre-enrolment grants.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const ROOT = path.join(os.homedir(), 'Library/Application Support/sc-desktop')
const INGRESS = path.join(ROOT, 'research-maintenance-ingress.json')
const HOSTS = path.join(ROOT, 'research-hosts')
const fail = (code, detail) => { throw Object.assign(Error(code), { code, statusCode: 409,
  ...(detail ? { detail } : {}), replayPermission: false }) }
const id = v => typeof v === 'string' && /^[a-zA-Z0-9:_.-]{1,160}$/.test(v)
const migrationId = v => typeof v === 'string' && /^[a-zA-Z0-9:_.-]{1,200}$/.test(v)
const canonical = v => JSON.stringify(sort(v))
function sort(v) {
  if (v === null || ['string', 'boolean'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v)) return v
  if (Array.isArray(v)) return v.map(sort)
  if (v && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]))
  fail('research_host_data_invalid')
}
const digest = v => createHash('sha256').update(canonical(v)).digest('hex')
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function directory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const s = fs.lstatSync(dir)
  if (!s.isDirectory() || s.isSymbolicLink() || s.mode & 0o077 || s.uid !== process.getuid?.()) fail('research_host_storage_invalid')
}
function read(file, optional = false) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const a = fs.fstatSync(fd, { bigint: true })
    if (!a.isFile() || a.size > 16n * 1024n * 1024n || a.mode & 0o077n || a.uid !== BigInt(process.getuid())) fail('research_host_storage_invalid')
    const bytes = fs.readFileSync(fd), b = fs.fstatSync(fd, { bigint: true }), c = fs.lstatSync(file, { bigint: true })
    if (![b, c].every(s => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => s[k] === a[k]))) fail('research_host_storage_changed')
    try { return JSON.parse(bytes) } catch { fail('research_host_storage_invalid') }
  } catch (e) { if (optional && fd === undefined && e.code === 'ENOENT') return null; throw e }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
function atomic(file, value) {
  directory(path.dirname(file)); read(file, true)
  const temp = file + '.pending-' + randomUUID(), fd = fs.openSync(temp, 'wx', 0o600)
  try {
    try { fs.writeFileSync(fd, canonical(value)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temp, file)
    const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  } finally { try { fs.unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e } }
}
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('research_host_process_invalid')
  try {
    if (process.platform === 'linux') {
      // Some containers expose host procfs while getpid uses an inner namespace.
      // Resolve only this exact PID in this exact namespace; never choose by argv.
      let procPid = pid
      const selfStatus = fs.readFileSync('/proc/self/status', 'utf8')
      const nsIds = text => text.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number) || []
      if (nsIds(selfStatus).length > 1) {
        const ownNs = fs.readlinkSync('/proc/self/ns/pid')
        procPid = null
        for (const entry of fs.readdirSync('/proc').filter(s => /^\d+$/.test(s))) {
          try {
            if (fs.readlinkSync('/proc/' + entry + '/ns/pid') !== ownNs) continue
            if (nsIds(fs.readFileSync('/proc/' + entry + '/status', 'utf8')).at(-1) === pid) { procPid = Number(entry); break }
          } catch (error) { if (!['ENOENT', 'EACCES', 'ESRCH'].includes(error.code)) throw error }
        }
        if (procPid === null) return null
      }
      const s = fs.readFileSync('/proc/' + procPid + '/stat', 'utf8'), a = s.slice(s.lastIndexOf(')') + 2).split(' ')
      if (a[0] === 'Z') return null
      return { pid, birth: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + a[19],
        parentPid: nsIds(fs.readFileSync('/proc/' + a[1] + '/status', 'utf8')).at(-1) || Number(a[1]),
        executable: fs.readlinkSync('/proc/' + procPid + '/exe') }
    }
    if (process.platform !== 'darwin') fail('research_host_process_platform_unsupported')
    const s = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'ppid=', '-o', 'state=', '-o', 'comm='],
      { encoding: 'utf8', timeout: 3000 }).trim()
    if (!s) return null
    const m = s.match(/^(.{24})\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!m) fail('research_host_process_unknown')
    // Darwin retains a dead child as Z/<defunct> until its owner reaps it.
    // Like the Linux Z branch, it has no remaining userspace execution authority;
    // it is not a new executable occupying the original PID.
    if (m[3].startsWith('Z')) return null
    // P_WEXIT can remove argv before ps observes a zombie/absence. Its fallback
    // command (for example "(node)") is neither a new executable nor proof gone.
    if (m[3].includes('E')) fail('research_host_process_exiting', { pid, birth: m[1] })
    return { pid, birth: m[1], parentPid: Number(m[2]), executable: m[4] }
  } catch (e) {
    if (process.platform === 'linux' && (e.code === 'ENOENT' || e.code === 'ESRCH')) return null
    // ps exit1 with no row/diagnostic confirms absence. Missing inspection tools,
    // permission errors and partial/error output must remain unknown/held.
    if (process.platform === 'darwin' && !e.code && e.status === 1 && !e.signal
      && !String(e.stdout || '').trim() && !String(e.stderr || '').trim()) return null
    throw e
  }
}
const sameProcess = (a, b) => !!a && !!b && ['pid', 'birth', 'executable'].every(k => a[k] === b[k])
// No PID supplied by an HTTP caller reaches here; pins are persisted at spawn.
function signalExact(pin, signal = 'SIGTERM') {
  const current = processIdentity(pin.pid)
  if (!current) return false
  if (!sameProcess(current, pin)) fail('research_host_process_replaced')
  process.kill(pin.pid, signal); return true
}
async function retire(pin, assertCurrent, timeoutMs = 3000) {
  assertCurrent()
  const ownExit = error => error.code === 'research_host_process_exiting'
    && error.detail?.pid === pin.pid && error.detail?.birth === pin.birth
  try { if (!signalExact(pin)) return } catch (error) { if (!ownExit(error)) throw error }
  const start = Date.now()
  while (true) {
    assertCurrent()
    let current, exiting = false
    try { current = processIdentity(pin.pid) }
    catch (error) { if (!ownExit(error)) throw error; exiting = true }
    if (!exiting) {
      if (!current) break
      if (!sameProcess(current, pin)) fail('research_host_process_replaced')
    }
    if (Date.now() - start > timeoutMs) fail('research_host_retirement_pending')
    // Bounded absence inspection after a signal, not a lease expiry or permission.
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assertCurrent()
}
function readIngress(file = INGRESS, expectedEpoch = null) {
  const value = read(file, true), marker = read(file + '.initialized', true)
  if (!value && !marker && !expectedEpoch) return { version: 1, storeEpoch: null, fences: [] }
  if (!value || !marker) fail('research_ingress_storage_missing')
  if (value.version !== 1 || marker.version !== 1 || !id(value.storeEpoch) || marker.storeEpoch !== value.storeEpoch
    || expectedEpoch && expectedEpoch !== value.storeEpoch || !Array.isArray(value.fences)) fail('research_ingress_storage_invalid')
  for (const f of value.fences) {
    if (!f || !id(f.barrierId) || !id(f.fenceId) || !Number.isSafeInteger(f.revision) || f.revision < 1
      || !['held', 'released'].includes(f.state) || !Array.isArray(f.scope) || !f.scope.length || f.scope.some(v => !id(v))
      || new Set(f.scope).size !== f.scope.length || typeof f.expectedMainRelease !== 'string' || !f.expectedMainRelease
      || typeof f.expectedExtensionRelease !== 'string' || !f.expectedExtensionRelease
      || f.digest !== digest({ version: 1, fenceId: f.fenceId, barrierId: f.barrierId, revision: f.revision,
        scope: f.scope, expectedMainRelease: f.expectedMainRelease, expectedExtensionRelease: f.expectedExtensionRelease,
        ...(f.coldIntentDigest ? { coldIntentDigest: f.coldIntentDigest } : {}) })
      || f.state === 'released' && (f.releasedRevision !== f.revision + 1 || !/^[a-f0-9]{64}$/.test(f.releaseDigest || ''))) fail('research_ingress_storage_invalid')
    if (!!f.coldIntentDigest !== !!f.coldIntent || f.coldIntentDigest && f.coldIntentDigest !== digest(f.coldIntent)) fail('research_ingress_storage_invalid')
  }
  if (new Set(value.fences.map(f => f.barrierId)).size !== value.fences.length) fail('research_ingress_storage_invalid')
  return value
}
// Enrollment binds a parent-selected location even before Main's first write.
// The directory pin survives atomic file replacement, but not root substitution.
// HOME, SC_DESKTOP_DIR and a child's caller-supplied path are not authority.
function ingressLocation(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('research_host_ingress_authority_invalid')
  let parent, stat
  try { parent = fs.realpathSync(path.dirname(file)); stat = fs.lstatSync(parent, { bigint: true }) }
  catch { fail('research_host_ingress_authority_unavailable') }
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid()) || stat.mode & 0o022n) fail('research_host_ingress_authority_invalid')
  return { file: path.join(parent, path.basename(file)), directory: { dev: String(stat.dev), ino: String(stat.ino) } }
}
function createIngressAuthority(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  return { version: 1, authorityId: randomUUID(), ...ingressLocation(file) }
}
function validateIngressAuthority(authority, expectedFile) {
  if (!authority) fail('research_host_ingress_authority_required')
  if (authority.version !== 1 || !id(authority.authorityId) || typeof authority.file !== 'string'
    || !authority.directory || !['dev', 'ino'].every(k => /^\d+$/.test(authority.directory[k]))
    || Object.keys(authority).some(k => !['version', 'authorityId', 'file', 'directory'].includes(k))) fail('research_host_ingress_authority_invalid')
  const location = ingressLocation(authority.file)
  if (location.file !== authority.file || digest(location.directory) !== digest(authority.directory)) fail('research_host_ingress_authority_changed')
  if (expectedFile !== undefined && ingressLocation(expectedFile).file !== authority.file) fail('research_host_ingress_authority_changed')
  return digest(authority)
}
function ingressBasis(state) {
  return state.fences.map(f => ({ barrierId: f.barrierId, fenceId: f.fenceId, digest: f.digest,
    revision: f.revision, state: f.state, ...(f.state === 'released' ? { releasedRevision: f.releasedRevision, releaseDigest: f.releaseDigest } : {}) }))
}
function assertIngressBasis(basis, state) {
  if (!Array.isArray(basis)) fail('research_host_ingress_basis_required')
  for (const pin of basis) {
    const f = state.fences.find(f => f.barrierId === pin?.barrierId)
    if (!pin || !['held', 'released'].includes(pin.state) || !f
      || ['fenceId', 'digest', 'revision'].some(k => pin[k] !== f[k])
      || pin.state === 'released' && (f.state !== 'released' || pin.releaseDigest !== f.releaseDigest
        || pin.releasedRevision !== f.releasedRevision)) fail('research_host_ingress_basis_changed')
  }
  return state
}
function readBoundIngress(authority, expectedEpoch, basis) {
  validateIngressAuthority(authority)
  // Null means an explicitly enrolled pre-initialization observation, not a
  // missing field in an old record. Persist the first epoch BEFORE held throws.
  if (expectedEpoch !== null && !id(expectedEpoch)) fail('research_host_ingress_epoch_required')
  return assertIngressBasis(basis, readIngress(authority.file, expectedEpoch))
}
function assertIngressOpen(state, scope = null, target = null) {
  const held = state.fences.find(f => f.state === 'held' && (!scope || f.scope.some(id => scope.includes(id))))
  if (held) fail('RESEARCH_MAINTENANCE_HELD', { barrierId: held.barrierId, fenceId: held.fenceId })
  // Process startup may stay profile-neutral; effects always carry their
  // exact receiver tuple. A deferred/reconnected profile is not globally
  // opened just because another browser completed cold activation.
  const coldFence = target && [...state.fences].reverse().find(f => f.coldIntent && f.scope.includes(target.instanceId))
  if (coldFence) { const f = coldFence
    if (!f.coldActivation || f.coldActivation.releaseDigest !== f.releaseDigest
      || !Array.isArray(f.coldOpenProfiles) || !f.coldOpenProfiles.some(t =>
        ['instanceId', 'runtimeId', 'connectionId', 'family'].every(k => t[k] === target[k]))) fail('RESEARCH_COLD_PROFILE_HELD')
  }
  return state
}
function assertOpen(file = INGRESS, scope = null, expectedEpoch = null) {
  return assertIngressOpen(readIngress(file, expectedEpoch), scope)
}
function held(file, barrierId, expectedEpoch) {
  const f = readIngress(file, expectedEpoch).fences.find(f => f.barrierId === barrierId)
  if (f?.state !== 'held') fail('research_host_fence_not_held')
  return f
}
function openJournal(file, initial) {
  directory(path.dirname(file))
  const marker = read(file + '.initialized', true), previous = read(file, true)
  if (!!marker !== !!previous || marker && marker.storeEpoch !== previous?.storeEpoch) fail('research_host_journal_missing')
  const lockFile = file + '.lock', own = processIdentity(process.pid)
  let fd
  try { fd = fs.openSync(lockFile, 'wx', 0o600) } catch (e) {
    if (e.code !== 'EEXIST') throw e
    const old = read(lockFile), st = fs.lstatSync(lockFile)
    if (!old?.process || sameProcess(processIdentity(old.process.pid), old.process)) fail('research_host_writer_busy')
    const fresh = fs.lstatSync(lockFile)
    if (fresh.ino !== st.ino || fresh.dev !== st.dev) fail('research_host_writer_changed')
    fs.unlinkSync(lockFile); fd = fs.openSync(lockFile, 'wx', 0o600)
  }
  const writerId = randomUUID(); fs.writeFileSync(fd, canonical({ writerId, process: own })); fs.fsyncSync(fd); fs.closeSync(fd)
  let closed = false
  const assertWriter = () => { if (closed || read(lockFile)?.writerId !== writerId) fail('research_host_writer_changed') }
  const validate = v => {
    if (!v || v.version !== 1 || !id(v.storeEpoch) || !v.data || v.digest !== digest(v.data)) fail('research_host_journal_invalid')
    return v
  }
  let value = previous ? validate(previous) : { version: 1, storeEpoch: randomUUID(), data: initial }
  if (!previous) { value.digest = digest(value.data); atomic(file + '.initialized', { version: 1, storeEpoch: value.storeEpoch }); atomic(file, value) }
  function load() {
    assertWriter()
    const next = validate(read(file)), pin = read(file + '.initialized')
    if (next.storeEpoch !== value.storeEpoch || pin?.storeEpoch !== value.storeEpoch) fail('research_host_journal_replaced')
    value = next; return structuredClone(value.data)
  }
  return { load, assertWriter, save(data) { load(); atomic(file, { ...value, data, digest: digest(data) }); return data },
    close() { if (closed) return; assertWriter(); fs.unlinkSync(lockFile); closed = true }, file }
}
function readJournal(file) {
  const v = read(file), marker = read(file + '.initialized')
  if (v?.version !== 1 || marker?.storeEpoch !== v.storeEpoch || v.digest !== digest(v.data)) fail('research_host_journal_invalid')
  return v.data
}
function binding(name, def, kind = 'sc-browser') {
  const entry = def?.args?.[0]
  const candidate = name === 'browser' || typeof entry === 'string' && /[/\\]mcp[/\\]browser[/\\]index\.js$/.test(entry)
  if (!entry || !path.isAbsolute(entry) || !/^node(?:js)?(?:\.exe)?$/i.test(path.basename(def.command))) return candidate ? { kind: 'unsupported' } : null
  const contractFile = path.join(path.dirname(entry), kind === 'noted-mcp-hub' ? 'hub-host-contract.json' : 'host-contract.json')
  if (!fs.existsSync(contractFile)) return candidate ? { kind: 'unsupported' } : null
  let contract
  try { contract = JSON.parse(fs.readFileSync(contractFile, 'utf8')) } catch { fail('research_host_binding_invalid') }
  if (contract.kind !== kind || contract.version !== 1 || contract.entry !== path.basename(entry)
    || !contract.files || !Object.hasOwn(contract.files, contract.entry)) fail('research_host_binding_invalid')
  for (const [rel, hash] of Object.entries(contract.files)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || path.isAbsolute(rel)) fail('research_host_binding_invalid')
    const file = path.resolve(path.dirname(entry), rel)
    if (fs.realpathSync(file) !== file || hashFile(file) !== hash) fail('research_host_binding_changed')
  }
  return { kind: 'cooperative', entry, contractDigest: digest(contract), bindingDigest: digest(def) }
}
function hostHeld(host, ingressFile) {
  return host.holds.some(hold => {
    if (hold.state !== 'release_ready') return true
    const plans = readJournal(path.join(path.dirname(ingressFile), 'research-host-plans.json'))
    const plan = plans.plans.find(v => v.barrierId === hold.barrierId && v.migrationId === hold.migrationId)
    const permit = plan?.activationPermit
    return permit?.committed !== true || permit.releaseDigest !== hold.release?.releaseDigest
      || !plan.hosts.some(h => h.hostId === host.hostId && h.generation === host.generation
        && h.configurationDigest === host.configurationDigest && h.ingressAuthorityDigest === validateIngressAuthority(host.ingressAuthority, ingressFile))
  })
}
function authorized(req, token) {
  if (req.headers.origin || req.headers['sec-fetch-site'] || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false
  const actual = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from('Bearer ' + token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
module.exports = { ROOT, INGRESS, HOSTS, id, migrationId, fail, canonical, digest, hashFile, directory, read, atomic,
  processIdentity, sameProcess, signalExact, retire, readIngress, assertOpen, held, openJournal, readJournal, binding, hostHeld, authorized,
  createIngressAuthority, validateIngressAuthority, readBoundIngress, assertIngressOpen, ingressBasis, assertIngressBasis }
