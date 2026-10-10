import React, { useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import Tooltip from '../UI/Tooltip';

export type ApplicationMetrics = {
  available: boolean;
  reason?: string;
  hasCpu?: boolean;
  totalBytes?: number;
  totalCpu?: number | null;
  durationMs?: number;
  apps?: Array<{
    id: string; label: string; path: string | null; bytes: number; cpu: number | null; processCount: number;
    rows: Array<{ label: string; bytes: number; cpu: number | null; count: number }>;
  }>;
  memory?: { available: boolean; totalBytes?: number | null; compressedBytes?: number | null;
    swapUsedBytes?: number | null; pressureLevel?: number | null };
};

type Props = {
  data?: ApplicationMetrics;
  mode: 'memory' | 'cpu';
  expanded: Set<string>;
  onToggle: (id: string) => void;
  bytes: (value: number) => string;
  value: (bytes: number | null | undefined, cpu: number | null | undefined) => string;
};

const ResourceApplicationsView: React.FC<Props> = ({ data, mode, expanded, onToggle, bytes, value }) => {
  const apps = useMemo(() => [...(data?.apps || [])].sort((a,b) =>
    mode === 'memory' ? b.bytes - a.bytes : (b.cpu ?? -1) - (a.cpu ?? -1)), [data, mode]);
  if (!data) return <div style={{ padding: '10px', fontSize: 11, color: '#888' }}>Измеряю приложения…</div>;
  if (!data.available) return <div style={{ padding: '10px', fontSize: 11, color: '#fca5a5' }}>Не удалось измерить приложения</div>;
  const memory = data.memory;
  const pressure = memory?.pressureLevel;
  const pressureText = pressure === 1 ? 'обычное' : pressure === 2 ? 'повышенное' : pressure === 4 ? 'высокое' : 'неизвестно';
  const memoryValue = (n: number | null | undefined) => n == null ? '—' : bytes(n);
  return <div data-resource-applications>
    <Tooltip content={'Давление на память: ' + pressureText + '. ОЗУ — физическая память; сжато и swap — отдельные системные показатели.'}>
      <div data-resource-system-memory style={{ padding: '4px 10px 7px', fontSize: 10, fontVariantNumeric: 'tabular-nums', color: '#888' }}>
        <span style={{ color: pressure === 2 ? '#f59e0b' : pressure === 4 ? '#f87171' : '#aaa' }}>ОЗУ {memoryValue(memory?.totalBytes)}</span>
        {' / сжато '}{memoryValue(memory?.compressedBytes)}{' / swap '}{memoryValue(memory?.swapUsedBytes)}
      </div>
    </Tooltip>
    <Tooltip content="Доступные процессы текущего пользователя, включая дочерние. Память учитывает сжатые и выгруженные страницы; её сумма не равна физически занятой ОЗУ. ЦП: 100% — одно ядро.">
      <div style={{ padding: '2px 10px 4px', fontSize: 9, color: '#666', textTransform: 'uppercase', fontWeight: 700 }}>Приложения</div>
    </Tooltip>
    {apps.map(app => {
      const isOpen = expanded.has(app.id);
      const rows = [...app.rows].sort((a,b) => mode === 'memory' ? b.bytes - a.bytes : (b.cpu ?? -1) - (a.cpu ?? -1));
      return <div key={app.id}>
        <button data-resource-app-id={app.id} aria-expanded={isOpen} onClick={() => onToggle(app.id)}
          className="hover:bg-white/[0.03]"
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
          <span style={{ width: 12, display: 'flex', color: '#666' }}>{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.label}</span>
          <span style={{ fontSize: 11, color: '#aaa', fontVariantNumeric: 'tabular-nums' }}>{value(app.bytes, app.cpu)}</span>
        </button>
        {isOpen && <div style={{ marginLeft: 25, padding: '0 10px 4px 0' }}>
          {rows.map(row => <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 10.5, color: '#888' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}{row.count > 1 && <span style={{ color: '#666' }}> ×{row.count}</span>}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value(row.bytes, row.cpu)}</span>
          </div>)}
        </div>}
      </div>;
    })}
  </div>;
};

export default ResourceApplicationsView;
