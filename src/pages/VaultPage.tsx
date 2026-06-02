import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@/contexts/WalletContext';
import { useVault, type VaultPosition } from '@/hooks/useVault';
import WalletConnectionModal from '@/components/WalletConnectionModal';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Lock,
  Unlock,
  LogOut,
  Wallet,
  RefreshCw,
  Zap,
  Clock,
  AlertCircle,
} from 'lucide-react';

function shortenAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

function timeUntilUnlock(unlockAtNs: bigint): string {
  const now = BigInt(Date.now()) * 1_000_000n;
  const remaining = unlockAtNs - now;
  if (remaining <= 0) return 'Ready';
  const ms = Number(remaining / 1_000_000n);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function fmtAmt(amount: string, token: string): string {
  const n = BigInt(amount);
  if (token === 'NEAR') {
    const whole = n / 10n ** 24n;
    const frac = n % 10n ** 24n;
    const fracStr = frac.toString().padStart(24, '0').slice(0, 4);
    return frac === 0n ? whole.toString() : `${whole}.${fracStr}`;
  }
  return n.toLocaleString();
}

function fmtDuration(nanos: bigint): string {
  const ms = Number(nanos / 1_000_000n);
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function pct(lockedAtNs: bigint, unlockAtNs: bigint): number {
  const now = BigInt(Date.now()) * 1_000_000n;
  const duration = unlockAtNs - lockedAtNs;
  if (duration <= 0n) return 100;
  const elapsed = now - lockedAtNs;
  if (elapsed >= duration) return 100;
  return Math.round(Number(elapsed * 100n / duration));
}

const TOKEN_COLORS: Record<string, string> = {
  NEAR: 'bg-lime-500/15 text-lime-500',
  TST: 'bg-orange-500/15 text-orange-400',
};

// Ring visualization
function PositionRing({ positions }: { positions: VaultPosition[] }) {
  const total = positions.length;
  const unlockable = positions.filter(p => p.expired).length;
  const locked = total - unlockable;

  if (total === 0) {
    return (
      <div className="relative w-48 h-48 mx-auto">
        <svg viewBox="0 0 200 200" className="w-full h-full -rotate-90">
          <circle cx="100" cy="100" r="80" fill="none" stroke="currentColor" strokeWidth="12" className="text-muted" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <Lock className="w-8 h-8 text-muted-foreground/50 mb-1" />
          <span className="text-muted-foreground text-sm">No positions</span>
        </div>
      </div>
    );
  }

  const circumference = 2 * Math.PI * 80;
  const unlockableLen = (unlockable / total) * circumference;
  const lockedLen = (locked / total) * circumference;

  return (
    <div className="relative w-48 h-48 mx-auto">
      <svg viewBox="0 0 200 200" className="w-full h-full -rotate-90">
        <circle cx="100" cy="100" r="80" fill="none" stroke="currentColor" strokeWidth="12" className="text-muted" />
        {locked > 0 && (
          <circle cx="100" cy="100" r="80" fill="none" stroke="#facc15" strokeWidth="12"
            strokeDasharray={`${lockedLen} ${circumference}`} strokeLinecap="round" className="transition-all duration-700" />
        )}
        {unlockable > 0 && (
          <circle cx="100" cy="100" r="80" fill="none" stroke="#00ec97" strokeWidth="12"
            strokeDasharray={`${unlockableLen} ${circumference}`} strokeDashoffset={`-${lockedLen}`}
            strokeLinecap="round" className="transition-all duration-700" />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold">{total}</span>
        <span className="text-muted-foreground text-xs">{total === 1 ? 'position' : 'positions'}</span>
        {unlockable > 0 && <span className="text-lime-400 text-xs mt-0.5 font-medium">{unlockable} ready</span>}
      </div>
    </div>
  );
}

// Lock bottom sheet
function LockSheet({ open, onClose, onLock, onLockFt, locking, ftPositions }: {
  open: boolean;
  onClose: () => void;
  onLock: (amount: string, durationNs: string) => void;
  onLockFt: (token: string, amount: string, durationNs: string) => void;
  locking: boolean;
  ftPositions: string[]; // token contract IDs
}) {
  const [asset, setAsset] = useState<'NEAR' | string>('NEAR');
  const [amount, setAmount] = useState('1');
  const [hours, setHours] = useState('24');

  const durationNs = (parseFloat(hours) || 0) * 3600_000_000_000;
  const TEST_FT_TOKENS = ['wt6.kampy.testnet'];
  const ftTokenList = [...new Set([...TEST_FT_TOKENS, ...ftPositions.filter(Boolean)])];
  const isFt = asset !== 'NEAR';

  const handleLock = () => {
    if (isFt) {
      onLockFt(asset, amount, durationNs.toString());
    } else {
      onLock(amount, durationNs.toString());
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="fixed bottom-0 left-0 right-0 top-auto translate-x-0 translate-y-0 rounded-t-2xl rounded-b-none sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl max-w-md">
        <DialogHeader>
          <DialogTitle className="text-foreground">Lock Token</DialogTitle>
          <DialogDescription>Lock tokens for a set period. Claim them back when the timer expires.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5 font-medium">Asset</label>
            <select
              value={asset}
              onChange={(e) => { setAsset(e.target.value); setAmount('1'); }}
              className="w-full h-12 bg-background border border-input rounded-xl px-4 text-lg font-bold outline-none focus:ring-2 focus:ring-lime-500/30 focus:border-lime-500 transition-colors appearance-none cursor-pointer"
            >
              <option value="NEAR">NEAR</option>
              {ftTokenList.map(t => (
                <option key={t} value={t}>{t.split('.')[0]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5 font-medium">Amount ({isFt ? 'tokens' : 'NEAR'})</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full h-12 bg-background border border-input rounded-xl px-4 text-xl font-bold outline-none focus:ring-2 focus:ring-lime-500/30 focus:border-lime-500 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5 font-medium">Duration (hours)</label>
            <input
              type="number"
              min="1"
              step="1"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="w-full h-12 bg-background border border-input rounded-xl px-4 text-xl font-bold outline-none focus:ring-2 focus:ring-lime-500/30 focus:border-lime-500 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5 font-medium">Unlock at</label>
            <div className="w-full h-12 bg-background border border-input rounded-xl px-4 flex items-center text-xl font-bold tabular-nums">
              {new Date(Date.now() + durationNs / 1_000_000).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
          <Button onClick={handleLock} disabled={locking || !amount || parseFloat(amount) <= 0 || durationNs <= 0}
            className="w-full h-12 text-base font-semibold">
            {locking ? (
              <><RefreshCw className="w-4 h-4 animate-spin mr-2" />Locking...</>
            ) : (
              <><Lock className="w-4 h-4 mr-2" />Lock {amount} {isFt ? asset.split('.')[0] : 'NEAR'}</>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function VaultPage() {
  const { accountId, isConnected, network, disconnect, requestLogin, loginModalOpen, closeLoginModal } = useWallet();
  const { fetchPositions, claim, lock, lockFt, claimFt } = useVault();

  const [positions, setPositions] = useState<VaultPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locking, setLocking] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [lockSheetOpen, setLockSheetOpen] = useState(false);

  const refresh = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    setError(null);
    try {
      const pos = await fetchPositions();
      setPositions(pos);
    } catch (e) {
      console.error('Failed to fetch positions:', e);
      setError(e instanceof Error ? e.message : 'Failed to fetch');
      setPositions([]);
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [fetchPositions]);

  // Initial fetch with loader
  useEffect(() => { refresh(true); }, [refresh]);

  // Tick every second to update timer text, progress bar, and expired state
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const hasActiveTimers = positions.some(p => nowNs < p.unlockAtNs);
    if (!hasActiveTimers) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [tick % 60, positions]);

  // Silent background refresh every 30s, only when connected with positions
  useEffect(() => {
    if (!isConnected || positions.length === 0) return;
    const interval = setInterval(() => refresh(false), 30_000);
    return () => clearInterval(interval);
  }, [isConnected, refresh, positions.length]);

  const handleLock = useCallback(async (amount: string, durationNs: string) => {
    setLocking(true);
    setError(null);
    try {
      await lock(amount, durationNs);
      setLockSheetOpen(false);
      // Poll until the new position appears on chain
      const preCount = positions.length;
      for (let i = 0; i < 10; i++) {
        await refresh();
        if (positions.length > preCount) break;
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lock failed');
    } finally {
      setLocking(false);
    }
  }, [lock, refresh, positions]);

  const handleLockFt = useCallback(async (token: string, amount: string, durationNs: string) => {
    setLocking(true);
    setError(null);
    try {
      await lockFt(token, amount, durationNs);
      setLockSheetOpen(false);
      const preCount = positions.length;
      for (let i = 0; i < 10; i++) {
        await refresh();
        if (positions.length > preCount) break;
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lock failed');
    } finally {
      setLocking(false);
    }
  }, [lockFt, refresh, positions]);

  const handleClaim = useCallback(async (pos: VaultPosition) => {
    setClaimingId(pos.id);
    setError(null);
    try {
      if (pos.type === 'native') {
        await claim(pos);
      } else {
        await claimFt(pos.tokenContract);
      }
      // Poll until the claimed position actually disappears from chain state
      for (let i = 0; i < 10; i++) {
        await refresh();
        if (!positions.some(p => p.id === pos.id)) break;
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      console.error('Claim failed:', e);
      setError(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setClaimingId(null);
    }
  }, [claim, claimFt, refresh, positions]);

  // Derive live expired state on every tick
  const livePositions = positions.map(p => ({
    ...p,
    expired: BigInt(Date.now()) * 1_000_000n >= p.unlockAtNs,
  }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  void tick;

  const totalLockedNear = livePositions
    .filter(p => p.type === 'native')
    .reduce((sum, p) => sum + BigInt(p.amount), 0n);
  const totalLockedDisplay = fmtAmt(totalLockedNear.toString(), 'NEAR');
  const unlockableCount = livePositions.filter(p => p.expired).length;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header — minimal transparent like outlayer-wallet */}
      <header className="sticky top-0 z-30 bg-background/80 backdrop-blur-md">
        <div className="flex items-center justify-between px-4 h-12">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-lime-400" />
            <span className="font-semibold">Vault</span>
          </div>
          {isConnected && accountId ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground font-mono">{shortenAddress(accountId)}</span>
              <button onClick={disconnect} className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-lg hover:bg-muted" title="Disconnect">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button onClick={requestLogin}
              className="flex items-center gap-1.5 bg-muted text-foreground px-3 py-1.5 rounded-full text-xs font-medium hover:bg-muted/80 transition-colors">
              <Wallet className="w-3.5 h-3.5" />
              Connect
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-6 space-y-6">
        {!isConnected && positions.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
              <Wallet className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Connect Your Wallet</h2>
              <p className="text-muted-foreground text-sm max-w-xs">
                Connect a NEAR wallet to lock tokens, view your positions, and claim unlocked funds.
              </p>
            </div>
            <Button onClick={requestLogin} size="lg" className="px-8 text-base">
              <Wallet className="w-5 h-5 mr-2" />
              Connect Wallet
            </Button>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
            <RefreshCw className="w-8 h-8 text-muted-foreground animate-spin" />
            <span className="text-muted-foreground text-sm">Loading positions…</span>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Ring + Stats */}
            <div className="space-y-4">
              <PositionRing positions={livePositions} />
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-card/50 border border-border/50 p-4 text-center">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Total Locked</p>
                  <p className="text-2xl font-bold text-foreground tabular-nums">{totalLockedDisplay}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">NEAR</p>
                </div>
                <div className="rounded-2xl bg-card/50 border border-border/50 p-4 text-center">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Unlockable</p>
                  <p className="text-2xl font-bold text-foreground tabular-nums">{unlockableCount}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{unlockableCount === 1 ? 'position' : 'positions'}</p>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex gap-3">
              <Button onClick={() => setLockSheetOpen(true)} className="flex-1 h-12 font-semibold">
                <Lock className="w-4 h-4 mr-2" />
                Lock NEAR
              </Button>
              <Button variant="outline" onClick={() => refresh(true)} className="h-12 px-4">
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 bg-destructive/10 text-destructive rounded-lg p-3 text-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            {/* Positions List */}
            {livePositions.length === 0 ? (
              <div className="text-center py-12 space-y-3">
                <Lock className="w-10 h-10 text-muted-foreground/30 mx-auto" />
                <p className="text-muted-foreground text-sm">No locked positions yet.</p>
                <p className="text-muted-foreground/60 text-xs">Lock NEAR to create your first position.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <span className="text-xs font-medium text-muted-foreground px-1">Locked Positions</span>
                <div className="rounded-2xl border border-border/50 bg-card/50 divide-y divide-border/30 px-3">
                  {livePositions.map((pos) => (
                    <div
                      key={pos.id}
                      className={`py-3 space-y-2 transition-colors ${
                        pos.expired
                          ? ''
                          : ''
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${TOKEN_COLORS[pos.token] ?? 'bg-muted text-muted-foreground'}`}>
                          {pos.token[0]}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{pos.token}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {pos.type === 'native'
                              ? `Native NEAR · ${fmtDuration(pos.unlockAtNs - pos.lockedAtNs)} lock`
                              : `${pos.tokenContract} · NEP-141`}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-medium tabular-nums">{fmtAmt(pos.amount, pos.token)}</div>
                          <div className={`text-[11px] font-medium tabular-nums ${pos.expired ? 'text-lime-500' : 'text-amber-400'}`}>
                            {pos.expired ? 'Ready' : timeUntilUnlock(pos.unlockAtNs)}
                          </div>
                        </div>
                      </div>
                      <div className="h-[3px] rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-1000 ${pos.expired ? 'bg-lime-500' : 'bg-amber-400'}`}
                          style={{ width: `${pct(pos.lockedAtNs, pos.unlockAtNs)}%` }}
                        />
                      </div>
                      {pos.expired && (
                        <button
                          onClick={() => handleClaim(pos)}
                          disabled={claimingId === pos.id}
                          className="mt-2 w-full h-10 rounded-xl bg-lime-500 text-background text-xs font-bold flex items-center justify-center gap-1.5 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50"
                        >
                          {claimingId === pos.id ? (
                            <><RefreshCw size={14} className="animate-spin" /> Unlocking…</>
                          ) : (
                            <><Unlock size={14} /> Claim</>
                          )}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="text-center py-4">
              <p className="text-xs text-muted-foreground/60">vault.kampy.testnet · Timelock Vault</p>
            </div>
          </div>
        )}
      </main>

      {/* Modals */}
      <WalletConnectionModal isOpen={loginModalOpen} onClose={closeLoginModal} />
      <LockSheet
        open={lockSheetOpen}
        onClose={() => setLockSheetOpen(false)}
        onLock={handleLock}
        onLockFt={handleLockFt}
        locking={locking}
        ftPositions={[...new Set(positions.filter(p => p.type === 'ft').map(p => p.tokenContract))]}
      />
    </div>
  );
}
