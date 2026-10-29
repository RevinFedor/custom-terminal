import { useLayoutEffect, useRef } from 'react';
import { activateCanonicalPromptRecoveryOwner, type CanonicalPromptRecoveryOwner } from './canonicalPromptRecovery.mjs';

export function useCanonicalPromptRecoveryOwner(key: string) {
  const ownerRef = useRef<CanonicalPromptRecoveryOwner | null>(null);
  useLayoutEffect(() => activateCanonicalPromptRecoveryOwner(ownerRef, key), [key]);
  return ownerRef;
}
