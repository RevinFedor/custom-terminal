'use strict';
// Exact Source97 routing snippets for the deterministic pre-repair counter.
module.exports={
  "sourceSHA256": "c8141a905e80c552261e3f304b3cae08e828334da0165f98726ffd0924f46eb9",
  "routing": "  const leaseKey = rootController.installedCapabilityLane(method, payload);\n  const key = leaseKey || sourceKey;\n  const keys = leaseKey && (rootController.allocates(method, payload)\n    || Object.hasOwn(payload, 'sessionId') || Object.hasOwn(payload, 'cwd'))\n    ? [sourceKey, leaseKey] : [key];\n",
  "enqueue": "  const enqueue = executionControl => {\n    // Capture AND publish all edges synchronously, before any work/await.\n    // Allocators retain their old source/null predecessor as well as the\n    // lease edge. Explicitly scoped reads also retain both. Failed predecessors\n    // continue as before; an older tail may never erase a newer joined tail.\n    const predecessors = [...new Set(keys.map(key => chains.get(key)).filter(Boolean))];\n    const queued = Promise.all(predecessors.map(prior => prior.catch(() => {})))\n      .then(() => work(executionControl));\n    for (const key of keys) chains.set(key, queued);\n    queued.finally(() => {\n      for (const key of keys) if (chains.get(key) === queued) chains.delete(key);\n    }).catch(() => {});\n    return queued;\n  };\n"
};
