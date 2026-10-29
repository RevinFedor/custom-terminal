// One Timeline owner, one live store connection. Only mounted consumers are
// indexed, by UUID; entries remain the owner's existing array, never a second
// historical payload registry. A scroll walks the old/new viewport, not rows.
export function createTimelineViewportSource({ entries, read, subscribe, active = true }) {
  let current;
  let snapshot = new Set();
  let visible = new Set();
  let disconnect;
  let connecting = false;
  let size = 0;
  const byUuid = new Map();
  const matches = (keys, values = visible) => {
    // A plain row has one key, while a History group may report thousands of
    // visible assistant UUIDs. Conversely a collapsed Timeline group can have
    // many keys and a small viewport. Always visit the smaller side.
    if (keys.size <= values.size) {
      for (const key of keys) if (values.has(key)) return true;
    } else {
      for (const key of values) if (keys.has(key)) return true;
    }
    return false;
  };

  function readSnapshot() {
    const next = read();
    if (next !== current) {
      current = next;
      snapshot = new Set(next || []);
    }
    return snapshot;
  }

  function refresh() {
    if (!active) return;
    const next = readSnapshot();
    if (next === visible) return;
    const previous = visible;
    visible = next;
    const affected = new Set();
    for (const key of previous) {
      if (!visible.has(key)) for (const binding of byUuid.get(key) || []) affected.add(binding);
    }
    for (const key of visible) {
      if (!previous.has(key)) for (const binding of byUuid.get(key) || []) affected.add(binding);
    }
    // Commit every snapshot before notifying React (which can flushSync).
    const changed = [];
    for (const binding of affected) {
      const active = matches(binding.keys);
      if (active !== binding.active) {
        binding.active = active;
        changed.push(binding);
      }
    }
    for (const binding of changed) if (binding.live) binding.notify();
  }

  function connect() {
    if (disconnect || connecting || !active || size === 0) return;
    connecting = true;
    let stop;
    try { stop = subscribe(refresh); }
    finally { connecting = false; }
    if (active && size > 0) disconnect = stop;
    else stop();
  }

  return {
    setActive(value) {
      active = value === true;
      if (!active) { disconnect?.(); disconnect = undefined; return; }
      connect();
      refresh();
    },
    bind(index, count = 1) {
      const keys = new Set();
      for (let i = index; i < Math.min(entries.length, index + count); i++) {
        const entry = entries[i];
        keys.add(entry.uuid);
        // A compact-summary marker also follows its immediately preceding
        // boundary. Do not propagate through an arbitrary summary chain.
        if (entry.isCompactSummary && i > 0) keys.add(entries[i - 1].uuid);
      }
      return {
        getSnapshot() {
          return matches(keys, readSnapshot());
        },
        subscribe(notify) {
          refresh();
          const binding = { keys, active: matches(keys), notify, live: true };
          for (const key of keys) {
            let listeners = byUuid.get(key);
            if (!listeners) byUuid.set(key, listeners = new Set());
            listeners.add(binding);
          }
          size++;
          connect();
          // Cover a store update between the initial snapshot and connection.
          refresh();
          return () => {
            if (!binding.live) return;
            binding.live = false;
            for (const key of keys) {
              const listeners = byUuid.get(key);
              listeners?.delete(binding);
              if (!listeners?.size) byUuid.delete(key);
            }
            if (--size === 0) {
              disconnect?.();
              disconnect = undefined;
            }
          };
        },
      };
    },
  };
}
