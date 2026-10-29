export interface CanonicalPromptRecoveryOwner {
  key: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
}
export interface CanonicalPromptRecoveryOwnerRef { current: CanonicalPromptRecoveryOwner | null }
export function canonicalPromptRecoveryReadError(cause: unknown): Error & { cause?: unknown; code?: string };
export function isCanonicalPromptRecoveryReadError(error: unknown): boolean;
export function activateCanonicalPromptRecoveryOwner(ref: CanonicalPromptRecoveryOwnerRef, key: string): () => void;
export function captureCanonicalPromptRecoveryOwner(ref: CanonicalPromptRecoveryOwnerRef, key: string): CanonicalPromptRecoveryOwner;
export function canonicalPromptRecoveryIdentities(identity?: { auditEntryUuid?: unknown; sourceIdentity?: unknown }): string[];
export function readCanonicalPromptRecoveryProof(options: {
  root: any;
  header: any;
  identities: string[];
  signal?: AbortSignal;
  ownerSignal: AbortSignal;
  owns: () => boolean;
}): Promise<boolean>;
