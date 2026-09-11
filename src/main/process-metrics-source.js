'use strict';

/**
 * Точный сбор памяти/CPU по всем процессам системы.
 *
 * Читает то же значение, что показывает Activity Monitor в колонке «Память»
 * (phys_footprint), напрямую из ядра через proc_pid_rusage. Один проход по
 * всем ~900 процессам стоит ~4 мс, поэтому цена не зависит от числа вкладок:
 * мы делаем один снимок системы и потом раскладываем его по владельцам.
 *
 * Почему не ps: `ps rss` — это «страницы, физически лежащие в RAM прямо
 * сейчас». Он не видит сжатую память (её у системы обычно гигабайты) и заново
 * считает библиотеки, общие между процессами Electron. На нашем главном
 * процессе расхождение доходит до двух раз (832 МБ против реальных 1485 МБ),
 * поэтому ps годится только как аварийный запасной путь.
 *
 * CPU здесь — накопленное процессорное время, а НЕ мгновенная нагрузка.
 * Мгновенную считает вызывающий, сравнивая два снимка (см. computeCpuPercent).
 */

const path = require('path');

// Смещения полей внутри rusage_info_v4. Получены из <sys/resource.h> через
// offsetof на этой машине; структура — часть стабильного ABI ядра, поэтому
// значения не плавают между версиями macOS. Проверяются в тестах.
const RUSAGE_INFO_V4 = 4;
const OFFSET_USER_TIME_NS = 16;
const OFFSET_SYSTEM_TIME_NS = 24;
const OFFSET_PHYS_FOOTPRINT = 72;
const OFFSET_PROC_START_ABSTIME = 80;
const RUSAGE_BUFFER_BYTES = 512; // sizeof(rusage_info_v4) = 296, берём с запасом

const PROC_ALL_PIDS = 1;
const PROC_PIDPATHINFO_MAXSIZE = 4096;
const MAX_TRACKED_PIDS = 16384;

let nativeState = null;

/**
 * Готовит доступ к системным функциям. Вызывается лениво: если koffi почему-то
 * не загрузился (битая установка, чужая платформа), мы не роняем main, а
 * сообщаем причину и позволяем вызывающему уйти на запасной путь.
 */
function loadNative() {
  if (nativeState) return nativeState;

  if (process.platform !== 'darwin') {
    nativeState = { ok: false, reason: 'platform-not-darwin' };
    return nativeState;
  }

  try {
    const koffi = require('koffi');
    const lib = koffi.load('/usr/lib/libSystem.B.dylib');

    nativeState = {
      ok: true,
      reason: null,
      listPids: lib.func('int proc_listpids(uint32_t type, uint32_t typeinfo, _Out_ uint8_t *buf, int bufsize)'),
      pidRusage: lib.func('int proc_pid_rusage(int pid, int flavor, _Out_ uint8_t *buf)'),
      pidPath: lib.func('int proc_pidpath(int pid, _Out_ uint8_t *buf, uint32_t buffersize)'),
      // proc_bsdshortinfo: нужен ppid, чтобы строить дерево «вкладка → её
      // инструменты» без отдельного вызова ps.
      pidShortInfo: lib.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ uint8_t *buf, int buffersize)'),
      // Путь к исполняемому файлу почти всегда `node` — по нему нельзя понять,
      // какой инструмент запущен. Настоящее имя лежит в аргументах запуска,
      // а их отдаёт только sysctl.
      sysctl: lib.func('int sysctl(_In_ int *name, uint32_t namelen, _Out_ uint8_t *oldp, _Inout_ size_t *oldlenp, void *newp, size_t newlen)'),
    };
    return nativeState;
  } catch (error) {
    nativeState = { ok: false, reason: 'koffi-load-failed: ' + (error && error.message) };
    console.warn('[ProcessMetrics] native source unavailable — ' + nativeState.reason);
    return nativeState;
  }
}

// proc_bsdshortinfo, sizeof = 64. Смещения взяты из <sys/proc_info.h> через
// offsetof, а не на глаз: угаданные значения читаются без ошибки, но возвращают
// мусор, и снимок молча выходит пустым.
const PROC_PIDT_SHORTBSDINFO = 13;
const SHORTINFO_BUFFER_BYTES = 64;
const OFFSET_SHORT_PPID = 4;
const OFFSET_SHORT_PGID = 8;
const OFFSET_SHORT_UID = 36;
const OFFSET_SHORT_COMM = 16;
const SHORT_COMM_MAXLEN = 17; // MAXCOMLEN(16) + завершающий ноль

function readCString(buffer, offset, maxLength) {
  let end = offset;
  const limit = Math.min(offset + maxLength, buffer.length);
  while (end < limit && buffer[end] !== 0) end += 1;
  return buffer.toString('utf8', offset, end);
}

/**
 * Путь к исполняемому файлу за время жизни процесса не меняется, а его чтение
 * стоит дороже всей остальной выборки вместе взятой (10.6 мс против 4 мс на
 * полный проход). Поэтому читаем один раз и запоминаем.
 *
 * Номера процессов система переиспользует, поэтому запись считается валидной
 * только пока совпадает родитель: другой родитель у того же номера означает,
 * что это уже другой процесс и путь надо перечитать.
 */
const execPathCache = new Map();
const processStartCache = new Map();

function getExecPath(native, pid, ppid, pathBuffer) {
  const cached = execPathCache.get(pid);
  if (cached && cached.ppid === ppid) return cached.execPath;

  let execPath = '';
  if (native.pidPath(pid, pathBuffer, PROC_PIDPATHINFO_MAXSIZE) > 0) {
    execPath = readCString(pathBuffer, 0, PROC_PIDPATHINFO_MAXSIZE);
  }
  execPathCache.set(pid, { ppid, execPath });
  return execPath;
}

function pruneExecPathCache(livePids) {
  if (execPathCache.size <= livePids.size) return;
  for (const pid of execPathCache.keys()) {
    if (!livePids.has(pid)) execPathCache.delete(pid);
  }
}

/**
 * Командная строка процесса.
 *
 * Нужна, потому что по исполняемому файлу инструмент не опознать: у почти всех
 * MCP это просто `node`, а различает их путь к скрипту в аргументах.
 *
 * Аргументы за время жизни процесса не меняются, поэтому читаем один раз.
 * Как и с путём, запись валидна только пока совпадает родитель — номера
 * процессов система переиспользует.
 */
const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;
const PROCARGS_BUFFER_BYTES = 4096;

const commandLineCache = new Map();

function readCommandLine(native, pid, ppid, argsBuffer, mibBuffer, lengthBuffer) {
  const cached = commandLineCache.get(pid);
  if (cached && cached.ppid === ppid) return cached.commandLine;

  let commandLine = '';
  try {
    mibBuffer.writeInt32LE(CTL_KERN, 0);
    mibBuffer.writeInt32LE(KERN_PROCARGS2, 4);
    mibBuffer.writeInt32LE(pid, 8);
    lengthBuffer.writeBigUInt64LE(BigInt(PROCARGS_BUFFER_BYTES), 0);

    if (native.sysctl(mibBuffer, 3, argsBuffer, lengthBuffer, null, 0) === 0) {
      const size = Number(lengthBuffer.readBigUInt64LE(0));
      if (size >= 8) {
        const argc = argsBuffer.readInt32LE(0);
        let position = 4;
        // Раскладка блока: argc, путь к исполняемому файлу, выравнивание нулями,
        // затем argc аргументов подряд через нулевой байт.
        while (position < size && argsBuffer[position] !== 0) position += 1;
        while (position < size && argsBuffer[position] === 0) position += 1;

        const parts = [];
        for (let index = 0; index < argc && position < size; index += 1) {
          const start = position;
          while (position < size && argsBuffer[position] !== 0) position += 1;
          parts.push(argsBuffer.toString('utf8', start, position));
          position += 1;
        }
        commandLine = parts.join(' ').trim();
      }
    }
  } catch {
    // Процесс мог завершиться между перечислением и чтением аргументов.
    // Это не ошибка сбора: у строки просто не будет подписи.
    commandLine = '';
  }

  commandLineCache.set(pid, { ppid, commandLine });
  return commandLine;
}

function pruneCommandLineCache(livePids) {
  if (commandLineCache.size <= livePids.size) return;
  for (const pid of commandLineCache.keys()) {
    if (!livePids.has(pid)) commandLineCache.delete(pid);
  }
}

/**
 * Один снимок всех процессов, доступных текущему пользователю.
 *
 * Возвращает { ok, processes: [{pid, ppid, pgid, name, execPath, footprintBytes,
 * cpuNs}], scannedAt, durationMs, skipped }. Процессы чужих пользователей
 * (system daemons) молча пропускаются — читать их всё равно нельзя без root,
 * и к потреблению приложения они не относятся.
 */
function captureNativeSnapshot({ includeCommandLine = true } = {}) {
  const native = loadNative();
  if (!native.ok) return { ok: false, reason: native.reason, processes: [] };

  const startedAt = process.hrtime.bigint();
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;

  const pidBuffer = Buffer.alloc(MAX_TRACKED_PIDS * 4);
  const bytesWritten = native.listPids(PROC_ALL_PIDS, 0, pidBuffer, pidBuffer.length);
  if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) {
    return { ok: false, reason: 'proc_listpids-failed', processes: [] };
  }

  const pidCount = Math.floor(bytesWritten / 4);
  const rusageBuffer = Buffer.alloc(RUSAGE_BUFFER_BYTES);
  const shortBuffer = Buffer.alloc(SHORTINFO_BUFFER_BYTES);
  const pathBuffer = Buffer.alloc(PROC_PIDPATHINFO_MAXSIZE);
  const argsBuffer = Buffer.alloc(PROCARGS_BUFFER_BYTES);
  const mibBuffer = Buffer.alloc(12);
  const lengthBuffer = Buffer.alloc(8);

  const processes = [];
  const livePids = new Set();
  let skipped = 0;

  for (let index = 0; index < pidCount; index += 1) {
    const pid = pidBuffer.readInt32LE(index * 4);
    if (pid <= 0) continue;

    // Сначала дешёвый short-info: он же отсекает чужих пользователей до
    // более дорогого rusage.
    const shortRc = native.pidShortInfo(pid, PROC_PIDT_SHORTBSDINFO, 0, shortBuffer, SHORTINFO_BUFFER_BYTES);
    if (shortRc <= 0) { skipped += 1; continue; }
    if (uid >= 0 && shortBuffer.readUInt32LE(OFFSET_SHORT_UID) !== uid) continue;

    if (native.pidRusage(pid, RUSAGE_INFO_V4, rusageBuffer) !== 0) { skipped += 1; continue; }

    const userNs = rusageBuffer.readBigUInt64LE(OFFSET_USER_TIME_NS);
    const systemNs = rusageBuffer.readBigUInt64LE(OFFSET_SYSTEM_TIME_NS);
    const ppid = shortBuffer.readUInt32LE(OFFSET_SHORT_PPID);
    const startedAtTicks = rusageBuffer.readBigUInt64LE(OFFSET_PROC_START_ABSTIME).toString();
    if (processStartCache.get(pid) !== startedAtTicks) {
      execPathCache.delete(pid);
      commandLineCache.delete(pid);
      processStartCache.set(pid, startedAtTicks);
    }

    livePids.add(pid);
    const execPath = getExecPath(native, pid, ppid, pathBuffer);
    const commandLine = includeCommandLine ? readCommandLine(native, pid, ppid, argsBuffer, mibBuffer, lengthBuffer) : '';

    processes.push({
      pid,
      ppid,
      pgid: shortBuffer.readUInt32LE(OFFSET_SHORT_PGID),
      commandLine,
      // pbsi_comm обрезан ядром до 16 символов — для показа берём basename
      // полного пути, а comm оставляем как запасной вариант.
      name: execPath ? path.basename(execPath) : readCString(shortBuffer, OFFSET_SHORT_COMM, SHORT_COMM_MAXLEN),
      execPath,
      footprintBytes: Number(rusageBuffer.readBigUInt64LE(OFFSET_PHYS_FOOTPRINT)),
      cpuNs: Number(userNs + systemNs),
      // PID alone is not an identity, even when a recycled counter is larger.
      startedAtTicks,
    });
  }

  pruneExecPathCache(livePids);
  pruneCommandLineCache(livePids);
  for (const pid of processStartCache.keys()) if (!livePids.has(pid)) processStartCache.delete(pid);

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return {
    ok: true,
    reason: null,
    processes,
    scannedAt: Date.now(),
    durationMs,
    skipped,
  };
}

/**
 * Мгновенная загрузка CPU из двух снимков.
 *
 * ps показывает среднее за всю жизнь процесса — для «что грузит прямо сейчас»
 * это бесполезно (наше окно за 21 час даёт 40%, хотя сию секунду может быть 5%).
 * Честное значение = прирост процессорного времени, делённый на реальный
 * прошедший интервал.
 *
 * Возвращает Map pid → процент (100% = одно ядро полностью). Процессы, которых
 * не было в прошлом снимке, пропускаются: для них прироста ещё не существует,
 * и показывать им 0 честнее, чем выдумывать.
 */
function computeCpuPercent(previousSnapshot, currentSnapshot) {
  const result = new Map();
  if (!previousSnapshot || !currentSnapshot) return result;

  const elapsedMs = currentSnapshot.scannedAt - previousSnapshot.scannedAt;
  if (!(elapsedMs > 0)) return result;
  const elapsedNs = elapsedMs * 1e6;

  const previousByPid = new Map();
  for (const item of previousSnapshot.processes || []) {
    previousByPid.set(item.pid, item);
  }

  for (const item of currentSnapshot.processes || []) {
    const before = previousByPid.get(item.pid);
    if (!before) continue;
    // Номер процесса может быть переиспользован системой: если счётчик
    // процессорного времени пошёл назад, это уже другой процесс под тем же
    // номером — считать разницу нельзя.
    if (item.cpuNs < before.cpuNs) continue;
    result.set(item.pid, ((item.cpuNs - before.cpuNs) / elapsedNs) * 100);
  }

  return result;
}

module.exports = {
  loadNative,
  captureNativeSnapshot,
  computeCpuPercent,
  // экспортируем для тестов, чтобы смещения не разъехались молча
  __offsets: {
    RUSAGE_INFO_V4,
    OFFSET_USER_TIME_NS,
    OFFSET_SYSTEM_TIME_NS,
    OFFSET_PHYS_FOOTPRINT,
    OFFSET_PROC_START_ABSTIME,
    OFFSET_SHORT_PPID,
    OFFSET_SHORT_PGID,
    OFFSET_SHORT_UID,
    OFFSET_SHORT_COMM,
  },
};
