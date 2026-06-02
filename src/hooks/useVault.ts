import { useWallet } from '@/contexts/WalletContext';
import { useCallback } from 'react';
import { VAULT_CONTRACT_ID } from '@/lib/near-rpc';

const TST_CONTRACT = 'wt6.kampy.testnet';

export interface VaultPosition {
  id: string;
  type: 'native' | 'ft';
  token: string;
  tokenContract?: string;
  amount: string; // yoctoNEAR as string
  lockedAtNs: bigint;
  unlockAtNs: bigint;
  expired: boolean;
}

interface StorageEntry {
  key: string;
  valueBytes: Uint8Array;
}

async function queryStorage(rpcUrl: string, prefix: string): Promise<StorageEntry[]> {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'view_state',
        finality: 'final',
        account_id: VAULT_CONTRACT_ID,
        prefix_base64: btoa(prefix),
      },
    }),
  });
  const data = await resp.json();
  if (data.error) return [];
  const values = data.result?.values ?? [];
  return values.map((v) => {
    const keyBytes = Uint8Array.from(atob(v.key as string), c => c.charCodeAt(0));
    const valBytes = Uint8Array.from(atob(v.value as string), c => c.charCodeAt(0));
    const keyStr = new TextDecoder().decode(keyBytes);
    return { key: keyStr, valueBytes: valBytes };
  });
}

/** Untag borsh i64: stored as (val << 3) | tag, untag = val >> 3 */
function untagI64(bytes: Uint8Array): bigint {
  if (bytes.length < 8) return 0n;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(0, true) >> 3n;
}

/** Read raw u128 LE from 16 bytes */
function readU128(bytes: Uint8Array): bigint {
  if (bytes.length < 16) return 0n;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lo = view.getBigUint64(0, true);
  const hi = view.getBigUint64(8, true);
  return (hi << 64n) | lo;
}

/** Decode UTF-8 string from storage bytes */
function decodeString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function parseNativePositions(entries: StorageEntry[], connectedOwner: string | null): VaultPosition[] {
  // v6 keys: lock:<owner>:<lock_id>:amt|time  or lock:<owner>:next_id
  // v5 keys: lock:<owner>:amt|time  (no lock_id)
  const lockMap = new Map<string, { amt: Uint8Array | null; time: Uint8Array | null; dur: Uint8Array | null }>();

  for (const e of entries) {
    if (!e.key.startsWith('lock:')) continue;
    const rest = e.key.slice(5); // strip "lock:"
    // First colon separates owner from the rest
    const colonIdx = rest.indexOf(':');
    if (colonIdx < 0) continue;
    const owner = rest.slice(0, colonIdx);
    const tail = rest.slice(colonIdx + 1); // "<lock_id>:amt" or "amt" or "next_id"
    const lastColon = tail.lastIndexOf(':');
    const suffix = lastColon >= 0 ? tail.slice(lastColon + 1) : tail;
    if (suffix !== 'amt' && suffix !== 'time' && suffix !== 'dur') continue;
    const lockId = lastColon >= 0 ? tail.slice(0, lastColon) : '0';
    const mapKey = `${owner}:${lockId}`;
    if (!lockMap.has(mapKey)) lockMap.set(mapKey, { amt: null, time: null, dur: null });
    const entry = lockMap.get(mapKey)!;
    if (suffix === 'amt') entry.amt = e.valueBytes;
    if (suffix === 'time') entry.time = e.valueBytes;
    if (suffix === 'dur') entry.dur = e.valueBytes;
  }

  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const positions: VaultPosition[] = [];

  const yoctoPerNear = 10n ** 24n;
  for (const [mapKey, { amt, time, dur }] of lockMap) {
    if (!amt || !time) continue;
    const colonIdx = mapKey.indexOf(':');
    const owner = mapKey.slice(0, colonIdx);
    const lockId = mapKey.slice(colonIdx + 1);
    if (connectedOwner && owner !== connectedOwner) continue;

    const amount = readU128(amt);
    if (amount === 0n) continue;

    const unlockAtNs = untagI64(time);
    const durNs = dur ? untagI64(dur) : 0n;
    const lockedAtNs = durNs > 0n ? unlockAtNs - durNs : 0n;
    positions.push({
      id: `native:${owner}:${lockId}`,
      type: 'native',
      token: 'NEAR',
      amount: amount.toString(),
      lockedAtNs,
      unlockAtNs,
      expired: nowNs >= unlockAtNs,
    });
  }

  return positions;
}

function parseFtPositions(entries: StorageEntry[], connectedOwner: string | null): VaultPosition[] {
  const tokenMap = new Map<string, { amt: Uint8Array | null; time: Uint8Array | null; dur: Uint8Array | null }>();

  for (const e of entries) {
    if (!e.key.startsWith('ft:')) continue;
    const rest = e.key.slice(3);
    if (!rest.endsWith(':amt') && !rest.endsWith(':time') && !rest.endsWith(':dur')) continue;
    const suffix = rest.endsWith(':amt') ? 'amt' : rest.endsWith(':time') ? 'time' : 'dur';
    const prefix = rest.slice(0, -(suffix.length + 1));

    const colonIdx = prefix.indexOf(':');
    if (colonIdx < 0) continue;
    const owner = prefix.slice(0, colonIdx);
    const tokenContract = prefix.slice(colonIdx + 1);
    if (!owner || !tokenContract) continue;

    if (!tokenMap.has(prefix)) tokenMap.set(prefix, { amt: null, time: null, dur: null });
    const entry = tokenMap.get(prefix)!;
    if (suffix === 'amt') entry.amt = e.valueBytes;
    if (suffix === 'time') entry.time = e.valueBytes;
    if (suffix === 'dur') entry.dur = e.valueBytes;
  }

  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const positions: VaultPosition[] = [];

  for (const [prefix, { amt, time, dur }] of tokenMap) {
    if (!amt || !time) continue;
    const colonIdx = prefix.indexOf(':');
    const owner = prefix.slice(0, colonIdx);
    const tokenContract = prefix.slice(colonIdx + 1);
    if (connectedOwner && owner !== connectedOwner) continue;

    const amountStr = decodeString(amt);
    const amount = BigInt(amountStr) || 0n;
    if (amount === 0n) continue;
    const unlockAt = untagI64(time);
    const durNs = dur ? untagI64(dur) : 0n;
    const lockedAt = durNs > 0n ? unlockAt - durNs : 0n;

    positions.push({
      id: `ft:${owner}:${tokenContract}`,
      type: 'ft',
      token: tokenContract === TST_CONTRACT ? 'TST' : tokenContract.split('.')[0].toUpperCase(),
      tokenContract,
      amount: amount.toString(),
      lockedAtNs: lockedAt,
      unlockAtNs: unlockAt,
      expired: nowNs >= unlockAt,
    });
  }

  return positions;
}

export function useVault() {
  const { accountId, network, signAndSendTransaction } = useWallet();

  const rpcUrl = network === 'testnet'
    ? 'https://rpc.testnet.fastnear.com'
    : 'https://rpc.mainnet.near.org';

  const fetchPositions = useCallback(async (): Promise<VaultPosition[]> => {
    if (!accountId) return [];
    const entries = await queryStorage(rpcUrl, '');
    if (!entries || entries.length === 0) return [];

    const positions: VaultPosition[] = [];
    positions.push(...parseNativePositions(entries, accountId));
    positions.push(...parseFtPositions(entries, accountId));
    return positions;
  }, [rpcUrl, accountId]);

  const functionCall = (methodName: string, args: Record<string, unknown>, gas = '30000000000000', deposit = '0') => ({
    type: 'FunctionCall' as const,
    methodName,
    args,
    gas,
    deposit,
  });

  const claim = useCallback(async (pos: VaultPosition) => {
    if (!accountId) return;
    if (pos.type === 'ft') {
      await signAndSendTransaction({
        receiverId: VAULT_CONTRACT_ID,
        actions: [functionCall('claim_ft', { sender_id: accountId, token: pos.tokenContract })],
      });
    } else {
      // Extract lock_id from position id ("native:<owner>:<lock_id>")
      const parts = pos.id.split(':');
      const lockId = parts.length > 2 ? parts[2] : '0';
      await signAndSendTransaction({
        receiverId: VAULT_CONTRACT_ID,
        actions: [functionCall('claim', { owner: accountId, lock_id: lockId })],
      });
    }
  }, [accountId, signAndSendTransaction]);

  const lock = useCallback(async (amountNear: string, durationNs: string) => {
    if (!accountId) return;
    const amount = parseFloat(amountNear);
    if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');
    const depositYocto = (BigInt(Math.round(amount * 1e6)) * 10n ** 18n).toString();
    await signAndSendTransaction({
      receiverId: VAULT_CONTRACT_ID,
      actions: [functionCall('lock', { owner: accountId, duration_ns: durationNs }, '30000000000000', depositYocto)],
    });
  }, [accountId, signAndSendTransaction]);

  const lockFt = useCallback(async (tokenContract: string, amount: string, durationNs: string) => {
    if (!accountId) return;
    // Step 1: call lock_ft on vault to record the lock
    await signAndSendTransaction({
      receiverId: VAULT_CONTRACT_ID,
      actions: [functionCall('lock_ft', { receiver_id: accountId, token: tokenContract, amount, duration_ns: durationNs })],
    });
  }, [accountId, signAndSendTransaction]);

  const claimFt = useCallback(async (tokenContract: string) => {
    if (!accountId) return;
    // Step 1: call claim_ft on vault to remove lock records
    await signAndSendTransaction({
      receiverId: VAULT_CONTRACT_ID,
      actions: [functionCall('claim_ft', { sender_id: accountId, token: tokenContract })],
    });
    // Step 2: caller should then call ft_transfer on the token contract to move tokens back
    // This is done separately since the vault doesn't hold FT tokens directly
  }, [accountId, signAndSendTransaction]);

  return { fetchPositions, claim, lock, lockFt, claimFt };
}
