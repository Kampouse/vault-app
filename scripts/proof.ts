/**
 * vault-proof.ts — Headless on-chain proof
 *
 * Proves the vault contract (compiled from Lisp → WASM via lisp-rlm)
 * correctly stores and returns NEAR deposits.
 *
 * Usage:  npx tsx proof.ts
 *
 * Steps:
 *   1. Lock 0.5 NEAR into vault.kampy.testnet
 *   2. Read raw storage bytes for lock:kampy.testnet:amt
 *   3. Decode u128 LE → prove it equals the deposit
 *   4. Claim the locked NEAR back
 *   5. Read storage → prove keys are deleted
 *
 * Every step prints human-readable output. No UI. No browser.
 * Just RPC calls + borsh + ed25519 signing.
 */

import { connect, utils, keyStores, KeyPair } from 'near-api-js';
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── Config ───
const ACCOUNT_ID = process.env.VAULT_ACCOUNT || 'kampy.testnet';
const CONTRACT_ID = 'vault.kampy.testnet';
const RPC_URL = 'https://rpc.testnet.near.org';
const LOCK_AMOUNT_NEAR = process.env.VAULT_AMOUNT || '0.01';
const LOCK_DURATION_NS = 60_000_000_000; // 60 seconds
const CREDENTIALS_DIR = join(process.env.HOME!, '.near-credentials/testnet');

// ─── Helpers ───
function header(step: number, title: string) {
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  STEP ${step}: ${title}`);
  console.log('='.repeat(64));
}

function row(label: string, value: string) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

function ok(msg: string) {
  console.log(`  [OK]  ${msg}`);
}

function fail(msg: string) {
  console.log(`  [FAIL]  ${msg}`);
}

function hexDump(buf: Buffer | Uint8Array): string {
  return Array.from(buf)
    .map((b: number) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function decodeU128LE(buf: Buffer | Uint8Array): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lo = view.getBigUint64(0, true);
  const hi = view.getBigUint64(8, true);
  return (hi << 64n) | lo;
}

function yoctoToNEAR(yocto: bigint): string {
  const whole = yocto / 10n ** 24n;
  const frac = yocto % 10n ** 24n;
  const fracStr = frac.toString().padStart(24, '0').slice(0, 6).replace(/0+$/, '');
  return `${whole}${fracStr ? '.' + fracStr : ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Raw RPC helper ───
async function rpcCall(method: string, params: Record<string, unknown>) {
  const resp = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function readStorageRaw(key: string, accountId: string = CONTRACT_ID): Promise<Buffer | null> {
  const result = await rpcCall('query', {
    request_type: 'view_state',
    finality: 'final',
    account_id: accountId,
    prefix_base64: Buffer.from(key).toString('base64'),
  });
  if (!result.values || result.values.length === 0) return null;
  const entry = result.values.find(
    (v: { key: string }) => Buffer.from(v.key, 'base64').toString() === key
  );
  if (!entry) return null;
  return Buffer.from(entry.value, 'base64');
}

async function listAllStorageKeys(accountId: string = CONTRACT_ID): Promise<{ key: string; value: Buffer }[]> {
  const result = await rpcCall('query', {
    request_type: 'view_state',
    finality: 'final',
    account_id: accountId,
    prefix_base64: '',
    include_proof: false,
  });
  if (!result.values) return [];
  return result.values.map((v: { key: string; value: string }) => ({
    key: Buffer.from(v.key, 'base64').toString(),
    value: Buffer.from(v.value, 'base64'),
  }));
}

// ─── Main ───
async function main() {
  console.log('='.repeat(64));
  console.log('  VAULT PROOF - Headless on-chain verification');
  console.log('  Contract: vault.kampy.testnet');
  console.log('  Compiled: Lisp -> WASM via lisp-rlm');
  console.log('  Network: NEAR Testnet');
  console.log('='.repeat(64));

  // Load keypair from credentials
  const keyFile = join(CREDENTIALS_DIR, `${ACCOUNT_ID}.json`);
  const keyData = JSON.parse(readFileSync(keyFile, 'utf-8'));
  const keyPair = KeyPair.fromString(keyData.private_key);

  // Connect to NEAR with explicit keypair
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', ACCOUNT_ID, keyPair);

  const near = await connect({
    networkId: 'testnet',
    nodeUrl: RPC_URL,
    keyStore,
  });
  const account = await near.account(ACCOUNT_ID);

  const balance = await account.getAccountBalance();
  row('Account', ACCOUNT_ID);
  row('Balance', yoctoToNEAR(BigInt(balance.available)) + ' NEAR');
  row('Lock amount', LOCK_AMOUNT_NEAR + ' NEAR');
  row('Lock duration', `${LOCK_DURATION_NS / 1_000_000_000}s`);
  row('Contract', CONTRACT_ID);
  row('RPC', RPC_URL);

  const depositYocto = BigInt(utils.format.parseNearAmount(LOCK_AMOUNT_NEAR));
  row('Deposit (yocto)', depositYocto.toString());

  // ═══════════════════════════════════════════════════
  // STEP 1: SHOW PRE-LOCK STATE
  // ═══════════════════════════════════════════════════
  header(1, 'Pre-lock storage state');

  const preLockAmt = await readStorageRaw(`lock:${ACCOUNT_ID}:amt`);
  if (preLockAmt) {
    row('Existing :amt', hexDump(preLockAmt) + ` (${preLockAmt.length} bytes)`);
    if (preLockAmt.length === 16) {
      const existing = decodeU128LE(preLockAmt);
      row('Existing u128', `${existing} yocto = ${yoctoToNEAR(existing)} NEAR`);
    }
  } else {
    row('Existing :amt', '(none - clean state)');
  }

  // ═══════════════════════════════════════════════════
  // STEP 2: LOCK NEAR
  // ═══════════════════════════════════════════════════
  header(2, `Lock ${LOCK_AMOUNT_NEAR} NEAR into vault`);

  const lockArgs = {
    owner: ACCOUNT_ID,
    duration_ns: String(LOCK_DURATION_NS),
  };

  row('Function', 'lock');
  row('Args', JSON.stringify(lockArgs));
  row('Deposit', depositYocto.toString() + ' yoctoNEAR');

  console.log('  ... Sending lock transaction...');
  const lockResult = await account.functionCall({
    contractId: CONTRACT_ID,
    methodName: 'lock',
    args: lockArgs,
    gas: '300000000000000',
    attachedDeposit: depositYocto.toString(),
  });

  const txHash = lockResult.transaction.hash;
  row('Tx hash', txHash);
  row('Explorer', `https://testnet.near.rocks/tx/${txHash}`);

  // Check status
  const status = lockResult.status as any;
  if (status.SuccessValue !== undefined) {
    const returnBuf = Buffer.from(status.SuccessValue, 'base64');
    row('Status', 'Success');
    row('Return (hex)', returnBuf.toString('hex'));
    if (returnBuf.length === 8) {
      const tagged = returnBuf.readBigUInt64LE(0);
      const tag = Number(tagged >> 3n);
      row('Return tag', `${tag} (${tag === 5 ? 'string' : tag === 3 ? 'number' : 'unknown'})`);
    }
    ok('Lock confirmed on-chain');
  } else {
    fail(`Lock failed: ${JSON.stringify(status)}`);
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════
  // STEP 3: VERIFY DEPOSIT IN STORAGE
  // ═══════════════════════════════════════════════════
  header(3, 'Verify deposit stored in contract storage');

  console.log('  ... Waiting 2s for finality...');
  await sleep(2000);

  const postLockAmt = await readStorageRaw(`lock:${ACCOUNT_ID}:amt`);
  const postLockTime = await readStorageRaw(`lock:${ACCOUNT_ID}:time`);

  if (!postLockAmt) {
    fail('No :amt key found after lock - deposit was NOT stored');
    process.exit(1);
  }

  row('Key', `lock:${ACCOUNT_ID}:amt`);
  row('Byte length', `${postLockAmt.length} bytes`);
  row('Raw hex', hexDump(postLockAmt));

  if (postLockAmt.length !== 16) {
    fail(`Expected 16 bytes (u128 LE), got ${postLockAmt.length}`);
    row('ASCII decode', postLockAmt.toString('utf8'));
    process.exit(1);
  }

  const storedU128 = decodeU128LE(postLockAmt);
  row('Stored u128', storedU128.toString() + ' yoctoNEAR');
  row('Stored (human)', yoctoToNEAR(storedU128) + ' NEAR');
  row('Expected u128', depositYocto.toString() + ' yoctoNEAR');
  row('Expected (human)', yoctoToNEAR(depositYocto) + ' NEAR');

  if (storedU128 === depositYocto) {
    ok(`DEPOSIT VERIFIED - on-chain bytes match exactly`);
    ok(`${yoctoToNEAR(storedU128)} NEAR stored as 16-byte u128 LE at lock:${ACCOUNT_ID}:amt`);
  } else {
    fail(`MISMATCH - stored ${storedU128}, expected ${depositYocto}`);
    process.exit(1);
  }

  if (postLockTime) {
    row('Time key', `lock:${ACCOUNT_ID}:time`);
    row('Time hex', hexDump(postLockTime));
    const taggedTime = postLockTime.readBigUInt64LE(0);
    const unlockNs = taggedTime >> 3n;
    const unlockDate = new Date(Number(unlockNs) / 1_000_000);
    row('Unlock at', unlockDate.toISOString());
  }

  // Dump all lock keys
  const allKeys = await listAllStorageKeys();
  const lockKeys = allKeys.filter((e) => e.key.startsWith(`lock:${ACCOUNT_ID}`));
  row('All lock keys', `${lockKeys.length}`);
  for (const k of lockKeys) {
    console.log(`    ${k.key}: [${k.value.length}b] ${hexDump(k.value)}`);
  }

  // ═══════════════════════════════════════════════════
  // STEP 4: WAIT FOR EXPIRY
  // ═══════════════════════════════════════════════════
  header(4, `Wait for lock expiry (${LOCK_DURATION_NS / 1_000_000_000}s)`);

  if (postLockTime) {
    const taggedTime = postLockTime.readBigUInt64LE(0);
    const unlockNs = taggedTime >> 3n;
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const waitMs = Number(unlockNs - nowNs);
    if (waitMs > 0) {
      row('Must wait', `${Math.ceil(waitMs / 1000)}s`);
      console.log('  ... Waiting...');
      await sleep(waitMs + 2000);
      ok('Lock expired');
    } else {
      ok('Lock already expired');
    }
  } else {
    ok('No time key found - assuming expired');
  }

  // ═══════════════════════════════════════════════════
  // STEP 5: CLAIM NEAR
  // ═══════════════════════════════════════════════════
  header(5, 'Claim locked NEAR back');

  const claimArgs = { owner: ACCOUNT_ID };
  row('Function', 'claim');
  row('Args', JSON.stringify(claimArgs));

  console.log('  ... Sending claim transaction...');
  const claimResult = await account.functionCall({
    contractId: CONTRACT_ID,
    methodName: 'claim',
    args: claimArgs,
    gas: '300000000000000',
  });

  const claimHash = claimResult.transaction.hash;
  row('Tx hash', claimHash);
  row('Explorer', `https://testnet.near.rocks/tx/${claimHash}`);

  const claimStatus = claimResult.status as any;
  if (claimStatus.SuccessValue !== undefined) {
    const claimReturn = Buffer.from(claimStatus.SuccessValue, 'base64');
    row('Status', 'Success');
    row('Return (hex)', claimReturn.toString('hex'));
    ok('Claim confirmed on-chain');
  } else {
    fail(`Claim failed: ${JSON.stringify(claimStatus)}`);
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════
  // STEP 6: VERIFY KEYS DELETED
  // ═══════════════════════════════════════════════════
  header(6, 'Verify lock keys deleted after claim');

  console.log('  ... Waiting 2s for finality...');
  await sleep(2000);

  const postClaimAmt = await readStorageRaw(`lock:${ACCOUNT_ID}:amt`);
  const postClaimTime = await readStorageRaw(`lock:${ACCOUNT_ID}:time`);

  row(':amt exists', postClaimAmt ? `YES (${postClaimAmt.length}b) - FAIL` : 'NO - PASS');
  row(':time exists', postClaimTime ? `YES (${postClaimTime.length}b) - FAIL` : 'NO - PASS');

  if (postClaimAmt || postClaimTime) {
    fail('Keys still exist after claim');
    process.exit(1);
  }

  ok('ALL LOCK KEYS DELETED');

  // ═══════════════════════════════════════════════════
  // STEP 7: FINAL BALANCE CHECK
  // ═══════════════════════════════════════════════════
  header(7, 'Verify account balance');

  const postBalance = await account.getAccountBalance();
  row('Available', yoctoToNEAR(BigInt(postBalance.available)) + ' NEAR');
  row('Total', yoctoToNEAR(BigInt(postBalance.total)) + ' NEAR');

  const vaultResult = await rpcCall('query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: CONTRACT_ID,
  });
  row('Vault balance', yoctoToNEAR(BigInt(vaultResult.amount)) + ' NEAR');

  // ═══════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════
  console.log(`\n${'='.repeat(64)}`);
  console.log('  FULL PROOF COMPLETE');
  console.log('='.repeat(64));
  ok(`Locked ${LOCK_AMOUNT_NEAR} NEAR into ${CONTRACT_ID}`);
  ok(`Storage verified: ${hexDump(postLockAmt!)} = ${storedU128} yoctoNEAR`);
  ok(`Claimed ${LOCK_AMOUNT_NEAR} NEAR back to ${ACCOUNT_ID}`);
  ok(`Storage verified: lock keys deleted`);
  ok(`Account balance: ${yoctoToNEAR(BigInt(postBalance.available))} NEAR`);
  console.log(`\n  Contract compiled from Lisp -> WASM via lisp-rlm`);
  console.log(`  Zero JavaScript in the contract. Pure Lisp.\n`);
}

main().catch((e) => {
  console.error(`\n[FATAL] ${e.message || e}`);
  process.exit(1);
});
