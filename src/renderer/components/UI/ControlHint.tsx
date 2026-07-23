import React from 'react';
import { useControlHelpStore } from '../../store/useControlHelpStore';
import Tooltip from './Tooltip';

type HintSide = 'top' | 'bottom' | 'left' | 'right' | 'auto';

interface ControlHintProps {
  label: React.ReactNode;
  children: React.ReactElement<any>;
  side?: HintSide;
  shortcut?: string;
  modifiedAction?: string;
  disabled?: boolean;
}

export default function ControlHint({
  label,
  children,
  side = 'top',
  shortcut,
  modifiedAction,
  disabled = false,
}: ControlHintProps) {
  const enabled = useControlHelpStore((state) => state.enabled);
  const child = enabled && children.props.title
    ? React.cloneElement(children, { title: undefined } as any)
    : children;

  const content = (
    <div style={{ display: 'grid', gap: shortcut || modifiedAction ? 4 : 0 }}>
      <div style={{ color: '#f1f3f5', fontWeight: 600 }}>{label}</div>
      {shortcut && <div style={{ color: '#8f98a3' }}>{shortcut}</div>}
      {modifiedAction && <div style={{ color: '#fab387' }}>{modifiedAction}</div>}
    </div>
  );

  return (
    <Tooltip
      content={content}
      side={side}
      interactive={false}
      disabled={disabled || !enabled}
    >
      {child}
    </Tooltip>
  );
}
