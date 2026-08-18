import React from 'react';
import { CircleHelp } from 'lucide-react';
import ControlHint from './ControlHint';

interface HelpButtonProps {
  onOpenHelp: () => void;
}

// Справка живёт в левом нижнем углу, в нижней строке состояния (2026-08-18).
// Раньше она стояла первой в шапке — на самом видном месте приложения, рядом с
// проектами, между которыми переключаются постоянно. Читают её редко и один
// раз, поэтому она уехала туда, где стоят такие же редкие переключатели.
//
// Форма — как у соседей по нижней строке: значок плюс подпись, высота 18,
// поэтому кнопка перестала быть квадратом со значком. Подпись здесь важнее, чем
// была наверху: в нижней строке всё подписано словами, и один значок среди них
// читался бы как непонятная лишняя точка.
export default function HelpButton({ onOpenHelp }: HelpButtonProps) {
  return (
    <ControlHint label="Открыть справку по приложению" side="top">
      <button
        type="button"
        data-testid="help-button"
        aria-label="Открыть справку"
        onClick={onOpenHelp}
        className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1 rounded hover:bg-white/5"
        style={{ padding: '1px 6px', height: 18, color: '#888' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ddd'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#888'; }}
      >
        <CircleHelp size={12} />
        <span>справка</span>
      </button>
    </ControlHint>
  );
}
