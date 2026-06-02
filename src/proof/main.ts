// vault-proof page — live on-chain verification
import { decodeUnsignedLEB128 } from './leb128';
import * as Proof from './engine';

// ── Globals ──
let walletAccount = '';
let accountId = '';

// ── Expose to inline handlers ──
(window as any).runInspect = runInspect;
(window as any).runProof = runProof;

// ── Try wallet connection ──
async function initWallet() {
  try {
    if (typeof (window as any).near !== 'undefined' && (window as any).near?.account?.accountId) {
      accountId = (window as any).near.account.accountId;
      walletAccount = accountId;
      const sel = document.getElementById('accountSel')!;
      sel.innerHTML = `<option value="${accountId}">${accountId} (connected)</option>`;
      (sel as HTMLSelectElement).disabled = true;
      (document.getElementById('proveBtn')! as HTMLButtonElement).disabled = false;
    }
  } catch {}
}

async function runInspect() {
  const account = ((document.getElementById('customAccount')! as HTMLInputElement).value || walletAccount).trim().toLowerCase();
  if (!account) { alert('Enter an account name or connect wallet'); return; }
  await run(account, false);
}

async function runProof() {
  const account = ((document.getElementById('customAccount')! as HTMLInputElement).value || walletAccount).trim().toLowerCase();
  if (!account) { alert('Enter an account name or connect wallet'); return; }
  await run(account, true);
}

// ── Main ──
async function run(account: string, fullCycle: boolean) {
  const out = document.getElementById('output')!;
  out.innerHTML = '';
  const RPC = 'https://rpc.testnet.near.org';
  const CONTRACT = 'vault.kampy.testnet';

  function card(title: string, step: number) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<h2><span class="step">${step}</span> ${title}</h2><div class="body"></div><div class="raw-wrap"></div>`;
    out.appendChild(el);
    return {
      body: el.querySelector('.body')! as HTMLDivElement,
      raw: el.querySelector('.raw-wrap')! as HTMLDivElement,
      row(label: string, value: string, cls = '') {
        const r = document.createElement('div');
        r.className = 'row';
        r.innerHTML = `<span class="label">${label}</span><span class="value ${cls}">${value}</span>`;
        this.body.appendChild(r);
      },
      ok(msg: string) { this.row('Status', `✅ ${msg}`, 'ok'); },
      fail(msg: string) { this.row('Status', `❌ ${msg}`, 'fail'); },
      warn(msg: string) { this.row('Status', `⚠️ ${msg}`, 'warn'); },
      dump(obj: unknown) {
        const pre = document.createElement('pre');
        pre.className = 'raw';
        pre.textContent = JSON.stringify(obj, (_key, val) =>
          typeof val === 'bigint' ? val.toString() + 'n' : val, 2);
        this.raw.appendChild(pre);
      },
    };
  }

  // ─── Step 1: Query State ───
  const s1 = card('Query Vault State', 1);
  s1.row('Contract', CONTRACT);
  s1.row('Network', 'testnet');
  s1.row('Account', account);

  let entries: any[];
  try {
    entries = await Proof.queryVaultState(RPC, CONTRACT);
    s1.row('Storage keys', `${entries.length} entries`);
    s1.ok('RPC responded');
  } catch (e: any) {
    s1.fail(e.message || String(e));
    return;
  }

  // Show raw entries
  const rawEntries = entries.slice(0, 20).map((e: any) => ({
    key: e.key,
    valueHex: [...e.valueBytes].map((b: number) => b.toString(16).padStart(2, '0')).join(''),
    valueBytes: e.valueBytes.length,
  }));
  s1.dump({ storageEntries: rawEntries, total: entries.length });

  // ─── Step 2: Decode Positions ───
  const s2 = card('Decode Positions', 2);
  const accountEntries = entries.filter((e: any) =>
    e.key.startsWith(`lock:${account}:`) || e.key.startsWith(`ft:${account}:`)
  );

  if (accountEntries.length === 0) {
    s2.warn(`No lock entries for ${account}`);
    if (!fullCycle) return;
  }

  s2.row('Matching keys', `${accountEntries.length}`);

  // Group native locks
  const native = Proof.parseNativePositions(accountEntries, account);
  s2.dump({
    parseInput: accountEntries.map((e: any) => ({
      key: e.key,
      hex: [...e.valueBytes].map((b: number) => b.toString(16).padStart(2, '0')).join(''),
    })),
    parsed: native.map((p: any) => ({
      ...p,
      amount: `${p.deposit} yocto`,
      near: `${Proof.yoctoToNear(p.deposit)} NEAR`,
    })),
  });

  // ─── Step 3: Verify Deposit Encoding ───
  const s3 = card('Verify Deposit Encoding', 3);
  for (const pos of native) {
    const amtEntry = accountEntries.find((e: any) => e.key.endsWith(':amt'));
    if (!amtEntry) continue;

    const bytes = amtEntry.valueBytes;
    s3.row('Key', amtEntry.key);
    s3.row('Raw hex', `<span class="hex">${[...bytes].map((b: number) => b.toString(16).padStart(2, '0')).join(' ')}</span>`);
    s3.row('Byte length', `${bytes.length} bytes`);

    if (bytes.length === 16) {
      const lo = Proof.readU128Lo(bytes);
      const hi = Proof.readU128Hi(bytes);
      const full = (BigInt(hi) << 64n) | BigInt(lo);
      s3.row('u128 LE', `${full} yoctoNEAR`);
      s3.row('NEAR', `${Proof.yoctoToNear(full)} NEAR`);

      if (full > 0n) {
        s3.ok(`Deposit verified: ${Proof.yoctoToNear(full)} NEAR`);
      } else {
        s3.warn('Deposit is zero — lock was created without attached NEAR');
      }
    } else if (bytes.length === 8) {
      const tagged = Proof.readU64LE(bytes);
      const untagged = Number(tagged) >> 3;
      s3.row('Tagged i64', `${tagged} → untag: ${untagged}`);
      s3.warn('8-byte tagged value — not a u128 deposit');
    } else {
      s3.fail(`Unexpected length: ${bytes.length} (expected 16 for u128 or 8 for tagged i64)`);
    }

    // Time decode
    const timeEntry = accountEntries.find((e: any) => e.key.endsWith(':time'));
    if (timeEntry) {
      const tBytes = timeEntry.valueBytes;
      s3.row('Time key', timeEntry.key);
      s3.row('Time hex', `<span class="hex">${[...tBytes].map((b: number) => b.toString(16).padStart(2, '0')).join(' ')}</span>`);
      const taggedTime = Proof.readU64LE(tBytes);
      const unlockNs = Number(taggedTime) >> 3;
      const unlockDate = new Date(unlockNs / 1_000_000);
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      const expired = BigInt(unlockNs) <= nowNs;
      s3.row('Unlock', `${unlockDate.toLocaleString()} ${expired ? '(expired)' : '(active)'}`);
    }
  }

  if (!fullCycle) return;

  // ─── Step 4: Lock (only if wallet connected) ───
  const s4 = card('Lock NEAR', 4);
  if (!walletAccount || walletAccount !== account) {
    s4.warn('Wallet not connected — skipping lock step');
    return;
  }

  const lockAmt = parseFloat((document.getElementById('lockAmt') as HTMLInputElement)?.value || '0.5');
  const depositYocto = BigInt(Math.floor(lockAmt * 1e24));
  const durationNs = 60_000_000_000n; // 60 seconds

  s4.row('Amount', `${lockAmt} NEAR`);
  s4.row('Deposit', `${depositYocto} yoctoNEAR`);
  s4.row('Duration', '60 seconds');

  try {
    s4.body.innerHTML += '<div class="spinner"></div> Signing transaction…';
    const txHash = await Proof.lockNEAR(RPC, account, CONTRACT, depositYocto, durationNs);
    s4.body.innerHTML = '';
    s4.row('Tx hash', `<a href="https://testnet.near.rocks/tx/${txHash}" target="_blank">${txHash.slice(0, 20)}…</a>`);
    s4.ok('Lock submitted — waiting for finality');

    await Proof.awaitFinality(RPC, txHash, account);
    s4.ok('Transaction finalized on-chain');
  } catch (e: any) {
    s4.body.innerHTML = '';
    s4.fail(`Lock failed: ${e.message || String(e)}`);
    return;
  }

  // ─── Step 5: Verify Deposit Stored ───
  const s5 = card('Verify Deposit Stored', 5);
  try {
    await new Promise(r => setTimeout(r, 2000));
    const afterLock = await Proof.queryVaultState(RPC, CONTRACT);
    const afterEntries = afterLock.filter((e: any) => e.key.startsWith(`lock:${account}:`));
    const amtAfter = afterEntries.find((e: any) => e.key.endsWith(':amt'));

    if (!amtAfter) {
      s5.fail('No :amt key found after lock');
    } else {
      const bytes = amtAfter.valueBytes;
      s5.row('Raw hex', `<span class="hex">${[...bytes].map((b: number) => b.toString(16).padStart(2, '0')).join(' ')}</span>`);
      s5.row('Byte length', `${bytes.length}`);

      if (bytes.length === 16) {
        const stored = (BigInt(Proof.readU128Hi(bytes)) << 64n) | BigInt(Proof.readU128Lo(bytes));
        s5.row('Stored u128', `${stored} yoctoNEAR`);
        s5.row('Stored NEAR', `${Proof.yoctoToNear(stored)} NEAR`);
        s5.row('Expected', `${Proof.yoctoToNear(depositYocto)} NEAR`);

        if (stored === depositYocto) {
          s5.ok(`DEPOSIT MATCHES — on-chain proof: ${Proof.yoctoToNear(stored)} NEAR stored at lock:${account}:amt`);
        } else {
          s5.fail(`MISMATCH — expected ${depositYocto}, got ${stored}`);
        }
      } else {
        s5.fail(`Wrong byte length: ${bytes.length} (expected 16)`);
      }
    }
    s5.dump({
      keysAfterLock: afterEntries.map((e: any) => ({
        key: e.key,
        hex: [...e.valueBytes].map((b: number) => b.toString(16).padStart(2, '0')).join(''),
      })),
    });
  } catch (e: any) {
    s5.fail(e.message || String(e));
  }

  // ─── Step 6: Claim ───
  const s6 = card('Claim (60s lock should be expired)', 6);
  try {
    s6.body.innerHTML += '<div class="spinner"></div> Signing claim transaction…';
    const txHash = await Proof.claimNEAR(RPC, account, CONTRACT);
    s6.body.innerHTML = '';
    s6.row('Tx hash', `<a href="https://testnet.near.rocks/tx/${txHash}" target="_blank">${txHash.slice(0, 20)}…</a>`);
    await Proof.awaitFinality(RPC, txHash, account);
    s6.ok('Claim finalized');
  } catch (e: any) {
    s6.body.innerHTML = '';
    s6.fail(`Claim failed: ${e.message || String(e)}`);
    return;
  }

  // ─── Step 7: Verify Keys Cleared ───
  const s7 = card('Verify Keys Cleared', 7);
  try {
    await new Promise(r => setTimeout(r, 2000));
    const afterClaim = await Proof.queryVaultState(RPC, CONTRACT);
    const remaining = afterClaim.filter((e: any) => e.key.startsWith(`lock:${account}:`));
    s7.row('Remaining keys', `${remaining.length}`);
    if (remaining.length === 0) {
      s7.ok('ALL LOCK KEYS CLEARED — full cycle proven');
    } else {
      s7.warn(`Keys remaining: ${remaining.map((e: any) => e.key).join(', ')}`);
    }
    s7.dump({
      remainingKeys: remaining.map((e: any) => ({
        key: e.key,
        hex: [...e.valueBytes].map((b: number) => b.toString(16).padStart(2, '0')).join(''),
      })),
    });
  } catch (e: any) {
    s7.fail(e.message || String(e));
  }
}

initWallet();

// ── Wire button handlers (module scope — onclick attributes don't work) ──
document.getElementById('inspectBtn')!.addEventListener('click', () => runInspect());
document.getElementById('proveBtn')!.addEventListener('click', () => runProof());
