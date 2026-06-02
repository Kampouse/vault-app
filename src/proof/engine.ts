// vault-proof engine — raw RPC calls, borsh decoding, transaction signing
// No wallet-selector, no near-kit. Fully self-contained for provability.

import { decodeUnsignedLEB128 } from './leb128';

// ── Types ──

export interface StorageEntry {
  key: string;
  valueBytes: Uint8Array;
}

export interface VaultPosition {
  owner: string;
  deposit: bigint;       // yoctoNEAR (0 if unparseable)
  depositHex: string;     // raw hex for proof
  unlockNs: bigint;
  unlockDate: string;
  expired: boolean;
  isZeroDeposit: boolean; // lock key exists but no NEAR was attached
}

// ── RPC Helpers ──

async function rpcCall(rpc: string, method: string, params: Record<string, unknown>): Promise<any> {
  const resp = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`RPC ${data.error.message || data.error.code}`);
  return data.result;
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

// ── Query ──

export async function queryVaultState(rpc: string, contractId: string): Promise<StorageEntry[]> {
  const prefixB64 = b64encode(new TextEncoder().encode(''));
  const result = await rpcCall(rpc, 'query', {
    request_type: 'view_state',
    finality: 'final',
    account_id: contractId,
    prefix_base64: prefixB64,
  });
  const values: Array<{ key: string; value: string }> = result.values ?? [];
  return values.map(v => ({
    key: new TextDecoder().decode(b64decode(v.key)),
    valueBytes: b64decode(v.value),
  }));
}

// ── Borsh Decoding ──

/** Read raw u64 little-endian from bytes */
export function readU64LE(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Number(view.getBigUint64(0, true));
}

/** Read low 8 bytes of u128 little-endian */
export function readU128Lo(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Number(view.getBigUint64(0, true));
}

/** Read high 8 bytes of u128 little-endian */
export function readU128Hi(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + 8, Math.min(bytes.byteLength, 8));
  return Number(view.getBigUint64(0, true));
}

/** Read full u128 from 16 bytes LE */
export function readU128(bytes: Uint8Array): bigint {
  if (bytes.length < 16) return 0n;
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  const lo = view.getBigUint64(0, true);
  const hi = view.getBigUint64(8, true);
  return (hi << 64n) | lo;
}

/** Untag borsh i64: stored as (val << 3) | tag */
export function untagI64(bytes: Uint8Array): bigint {
  if (bytes.length < 8) return 0n;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(0, true) >> 3n;
}

/** Convert yoctoNEAR to readable string */
export function yoctoToNear(yocto: bigint): string {
  const near = Number(yocto) / 1e24;
  if (near === 0) return '0';
  if (near >= 1) return near.toFixed(6);
  if (near >= 0.001) return near.toFixed(6);
  return near.toExponential(6);
}

// ── Position Parsing ──

export function parseNativePositions(entries: StorageEntry[], owner: string): VaultPosition[] {
  const ownerEntries = entries.filter(e => {
    if (!e.key.startsWith('lock:')) return false;
    const rest = e.key.slice(5);
    const colonIdx = rest.lastIndexOf(':');
    if (colonIdx < 0) return false;
    const suffix = rest.slice(colonIdx + 1);
    const entryOwner = rest.slice(0, colonIdx);
    return entryOwner === owner && (suffix === 'amt' || suffix === 'time');
  });

  let amtBytes: Uint8Array | null = null;
  let timeBytes: Uint8Array | null = null;
  for (const e of ownerEntries) {
    if (e.key.endsWith(':amt')) amtBytes = e.valueBytes;
    if (e.key.endsWith(':time')) timeBytes = e.valueBytes;
  }

  // Decode deposit
  let deposit = 0n;
  let isZeroDeposit = true;
  if (amtBytes) {
    if (amtBytes.length === 16) {
      deposit = readU128(amtBytes);
    } else if (amtBytes.length === 8) {
      // Might be a tagged value stored incorrectly
      deposit = untagI64(amtBytes);
    }
    isZeroDeposit = deposit === 0n;
  }

  // Decode unlock time
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  let unlockNs = 0n;
  if (timeBytes && timeBytes.length === 8) {
    unlockNs = untagI64(timeBytes);
  }

  const unlockDate = unlockNs > 0n ? new Date(Number(unlockNs) / 1_000_000).toLocaleString() : 'N/A';

  return [{
    owner,
    deposit,
    depositHex: amtBytes ? [...amtBytes].map(b => b.toString(16).padStart(2, '0')).join(' ') : 'N/A',
    unlockNs,
    unlockDate,
    expired: unlockNs > 0n && nowNs >= unlockNs,
    isZeroDeposit,
  }];
}

// ── Transaction Building & Signing ──

/**
 * Build and send a signed transaction using the injected wallet's signer.
 * Falls back to trying Meteor Wallet's InjectedWallet.signAndSendTransaction.
 */
async function sendTransaction(
  rpc: string,
  signerId: string,
  receiverId: string,
  methodName: string,
  args: Record<string, unknown>,
  gas: string,
  deposit: string,
): Promise<string> {
  // Use wallet-selector if available (from main app bundle)
  const walletSelector = (window as any).__walletSelector;
  if (walletSelector) {
    const wallet = await walletSelector.wallet();
    const result = await wallet.signAndSendTransaction({
      receiverId,
      actions: [{
        type: 'FunctionCall',
        methodName,
        args: JSON.stringify(args),
        gas,
        deposit,
      }],
    });
    // Find the tx hash from result
    if (typeof result === 'string') return result;
    if (result.transaction?.hash) return result.transaction.hash;
    if (Array.isArray(result)) return result[0]?.transaction?.hash || '';
  }

  // Fallback: use near.call via near-kit if available
  const nearInst = (window as any).near;
  if (nearInst?.call) {
    const txResult = await nearInst.call(receiverId, methodName, args, { gas, deposit });
    if (txResult?.transaction_outcome?.id) return txResult.transaction_outcome.id;
  }

  throw new Error('No wallet available — connect via the main app or use the vault CLI');
}

/** Lock NEAR by calling vault.lock with deposit */
export async function lockNEAR(
  rpc: string,
  signerId: string,
  contractId: string,
  depositYocto: bigint,
  durationNs: bigint,
): Promise<string> {
  return sendTransaction(
    rpc,
    signerId,
    contractId,
    'lock',
    { owner: signerId, duration_ns: durationNs.toString() },
    '30000000000000',     // 30 Tgas
    depositYocto.toString(),
  );
}

/** Claim NEAR by calling vault.claim */
export async function claimNEAR(
  rpc: string,
  signerId: string,
  contractId: string,
): Promise<string> {
  return sendTransaction(
    rpc,
    signerId,
    contractId,
    'claim',
    { owner: signerId },
    '30000000000000',
    '0',
  );
}

/** Poll for transaction finality */
export async function awaitFinality(rpc: string, txHash: string, signerId: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const result = await rpcCall(rpc, 'tx', { tx_hash: txHash, sender_account_id: signerId });
      if (result?.final_execution_status) return;
    } catch {
      // not yet available
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Transaction not finalized within 30s');
}
