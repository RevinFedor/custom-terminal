import React, { useContext, useLayoutEffect, useMemo } from 'react';

type AnyDemand = { id: string; kind: 'entry' | 'call'; values(): Iterable<string> };
type Demand = { entry?: string; call?: string; any?: AnyDemand };
type Membership = { status: 'pending' | 'ready' | 'error';
  entries: readonly { value: string; found: boolean | null }[];
  calls: readonly { value: string; found: boolean | null }[];
  any: readonly { id: string; found: boolean | null }[] };
type MembershipOwner = { requestMembership(input: { entries: readonly string[]; calls: readonly string[];
  any: readonly AnyDemand[] }): void };

/** Only mounted consumers register here. A collapsed group's existing
 * geometry array is streamed by its iterator; no copy of all group UUIDs or
 * cache of historical misses is constructed. Unmount releases the iterator. */
export function createHistoryAgentCatalogMembershipDemand(owner: MembershipOwner) {
  const mounted = new Map<string, Demand>();
  let sequence = 0, queued = false, closed = false;
  const schedule = () => {
    if (closed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (closed) return;
      const entries = new Set<string>(), calls = new Set<string>(), any: AnyDemand[] = [];
      for (const demand of mounted.values()) {
        if (demand.entry !== undefined) entries.add(demand.entry);
        if (demand.call !== undefined) calls.add(demand.call);
        if (demand.any) any.push(demand.any);
      }
      owner.requestMembership({ entries: [...entries], calls: [...calls], any });
    });
  };
  return Object.freeze({
    key() { return 'mounted-agent-membership:' + ++sequence; },
    register(key: string, demand: Demand) {
      if (closed) return () => {};
      mounted.set(key, demand); schedule();
      return () => { if (mounted.get(key) === demand) { mounted.delete(key); schedule(); } };
    },
    close() { closed = true; mounted.clear(); },
  });
}

export const HistoryAgentCatalogLivenessContext = React.createContext<{
  demand: ReturnType<typeof createHistoryAgentCatalogMembershipDemand>;
  membership: Membership | null;
} | null>(null);

export function useHistoryAgentCatalogMember(kind: 'entry' | 'call', value: unknown, fallback: boolean) {
  const context = useContext(HistoryAgentCatalogLivenessContext);
  const registration = useMemo(() => context && typeof value === 'string'
    ? { key: context.demand.key(), value: { [kind]: value } as Demand } : null,
  [context?.demand, kind, value]);
  useLayoutEffect(() => registration && context
    ? context.demand.register(registration.key, registration.value) : undefined,
  [context?.demand, registration]);
  if (!context || typeof value !== 'string' || context.membership?.status !== 'ready') return fallback;
  const result = (kind === 'entry' ? context.membership.entries : context.membership.calls)
    .find(item => item.value === value);
  return typeof result?.found === 'boolean' ? result.found : fallback;
}

export function useHistoryAgentCatalogGroupLive(entries: readonly { uuid?: unknown }[],
  fallback: () => boolean, enabled = true, nativeFallback: () => boolean = () => false) {
  const context = useContext(HistoryAgentCatalogLivenessContext);
  const registration = useMemo(() => {
    if (!context || !enabled) return null;
    const key = context.demand.key();
    return { key, value: { any: { id: key, kind: 'entry' as const,
      *values() { for (const entry of entries) { const uuid = entry.uuid; if (typeof uuid === 'string') yield uuid; } },
    } } };
  }, [context?.demand, entries, enabled]);
  useLayoutEffect(() => registration && context
    ? context.demand.register(registration.key, registration.value) : undefined,
  [context?.demand, registration]);
  if (!enabled) return false;
  const result = context?.membership?.status === 'ready' && registration
    ? context.membership.any.find(item => item.id === registration.key) : null;
  return typeof result?.found === 'boolean' ? result.found || nativeFallback() : fallback();
}
