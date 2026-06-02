import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { NearConnector } from '@hot-labs/near-connect';
import type { SignAndSendTransactionParams } from '@hot-labs/near-connect';
import { Near, fromNearConnect } from 'near-kit';

export type NetworkType = 'testnet' | 'mainnet';

interface WalletContextType {
  accountId: string | null;
  isConnected: boolean;
  isWalletReady: boolean;
  network: NetworkType;
  connect: () => void;
  disconnect: () => void;
  switchNetwork: (network: NetworkType) => void;
  signAndSendTransaction: (params: SignAndSendTransactionParams) => Promise<any>;
  viewMethod: (params: { contractId: string; method: string; args?: Record<string, unknown> }) => Promise<any>;
  near: Near | null;
  loginModalOpen: boolean;
  requestLogin: () => void;
  closeLoginModal: () => void;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

const RPC_URLS: Record<NetworkType, string> = {
  testnet: 'https://rpc.testnet.fastnear.com',
  mainnet: 'https://rpc.mainnet.near.org',
};

// ── Dev wallet: fetch-based signer, zero Node.js deps ──
const DEV_ACCOUNT_ID = 'kampy.testnet';
const DEV_PRIVATE_KEY = 'ed25519:2x4vPMCM5bTtXYQVBpCi2GUzskEg9qCNA8FHDDFEJFqNJmL1nkRNNKupvLdRs1dzmepSPtZRWLKfcK4mN3B68i3x';

function isDevMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('dev');
}

/** Decode ed25519 key from 'ed25519:...' format */
function decodeEd25519Key(secretKey: string): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const raw = Uint8Array.from(atob(secretKey.replace('ed25519:', '')), c => c.charCodeAt(0));
  return { publicKey: raw.slice(0, 32), secretKey: raw };
}

/** Serialize u32 LE */
function u32le(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, true);
  return buf;
}

/** Serialize u64 LE */
function u64le(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, n, true);
  return buf;
}

/** SHA-256 using SubtleCrypto */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** Sign with ed25519 using SubtleCrypto (importKey from raw secret key) */
async function signEd25519(secretKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', secretKey, { name: 'EdDSA', namedCurve: 'Ed25519' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('EdDSA', key, message));
}

/** Serialize args as JSON borsh: len(u32) + utf8 bytes */
function borshArgs(args: Record<string, unknown>): Uint8Array {
  const json = JSON.stringify(args);
  const encoded = new TextEncoder().encode(json);
  const buf = new Uint8Array(4 + encoded.length);
  buf.set(u32le(encoded.length));
  buf.set(encoded, 4);
  return buf;
}

/** Call RPC with JSON body */
async function rpcCall(rpcUrl: string, method: string, params: any): Promise<any> {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

/** Sign & send a single function call transaction */
async function sendFunctionCall(opts: {
  rpcUrl: string;
  signerId: string;
  secretKey: Uint8Array;
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}): Promise<any> {
  const { rpcUrl, signerId, secretKey, contractId, methodName, args, gas, deposit } = opts;

  // Get access key and block info
  const [accessKey, block] = await Promise.all([
    rpcCall(rpcUrl, 'query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: signerId,
      public_key: 'ed25519:' + btoa(String.fromCharCode(...decodeEd25519Key(DEV_PRIVATE_KEY).publicKey)),
    }),
    rpcCall(rpcUrl, 'block', { finality: 'final' }),
  ]);

  const argsBs = borshArgs(args);
  const actionNum = 1;
  const gasVal = BigInt(gas);
  const depositVal = BigInt(deposit);

  // Serialize FunctionCall action (borsh): type(1) + method_name + args + gas + deposit
  const methodNameBytes = new TextEncoder().encode(methodName);
  const fnCallSize = 1 + 4 + methodNameBytes.length + 4 + argsBs.length + 8 + 32;
  const fnCall = new Uint8Array(fnCallSize);
  let off = 0;
  fnCall[off++] = 0; // enum variant 0 = FunctionCall
  fnCall.set(u32le(methodNameBytes.length), off); off += 4;
  fnCall.set(methodNameBytes, off); off += methodNameBytes.length;
  fnCall.set(u32le(argsBs.length), off); off += 4;
  fnCall.set(argsBs, off); off += argsBs.length;
  new DataView(fnCall.buffer).setBigUint64(off, gasVal, true); off += 8;
  new DataView(fnCall.buffer).setBigUint64(off, depositVal, true); off += 32;

  // Serialize actions: vec length + concatenated actions
  const actionsBs = new Uint8Array(4 + fnCall.length);
  actionsBs.set(u32le(actionNum));
  actionsBs.set(fnCall, 4);

  // Serialize transaction (borsh)
  const signerBytes = new TextEncoder().encode(signerId);
  const receiverBytes = new TextEncoder().encode(contractId);
  const txSize = 32 + 32 + 8 + signerBytes.length + 4 + receiverBytes.length + 4 + actionsBs.length;
  const txBuf = new Uint8Array(txSize);
  off = 0;
  txBuf.set(hexToBytes(block.header_hash), off); off += 32;
  txBuf.set(hexToBytes(accessKey.block_hash), off); off += 32;
  new DataView(txBuf.buffer).setBigUint64(off, BigInt(accessKey.nonce) + 1n, true); off += 8;
  txBuf.set(signerBytes, off); off += signerBytes.length;
  txBuf.set(u32le(receiverBytes.length), off); off += 4;
  txBuf.set(receiverBytes, off); off += receiverBytes.length;
  txBuf.set(u32le(fnCall.length), off); off += 4; // num actions
  txBuf.set(actionsBs, off); // actions already has length prefix

  // Sign: SHA256(tx) then ed25519
  const hash = await sha256(txBuf);
  const signature = await signEd25519(secretKey, hash);

  // Serialize signed transaction (borsh)
  const stxBuf = new Uint8Array(txBuf.length + 4 + signature.length);
  stxBuf.set(txBuf);
  stxBuf.set(u32le(1), txBuf.length); // 1 = Ed25519 enum variant
  stxBuf.set(signature, txBuf.length + 4);

  // Convert to base64 (strip padding — NEAR RPC rejects '=' chars)
  let binary = '';
  for (let i = 0; i < stxBuf.length; i++) binary += String.fromCharCode(stxBuf[i]);
  let txBase64 = btoa(binary).replace(/=+$/, '');

  // Send tx
  return rpcCall(rpcUrl, 'broadcast_tx_commit', [txBase64]);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/** View function via RPC */
async function viewFunction(rpcUrl: string, contractId: string, method: string, args: Record<string, unknown>): Promise<any> {
  const result = await rpcCall(rpcUrl, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  if (result.result && result.result.length > 0) {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(result.result[0]), c => c.charCodeAt(0))));
  }
  return null;
}

function DevWalletProvider({ children }: { children: ReactNode }) {
  const [network] = useState<NetworkType>('testnet');
  const [accountId] = useState<string | null>(DEV_ACCOUNT_ID);
  const [isWalletReady, setIsWalletReady] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [near, setNear] = useState<Near | null>(null);
  const keyRef = useRef(decodeEd25519Key(DEV_PRIVATE_KEY));
  const rpcRef = useRef(RPC_URLS.testnet);

  const isConnected = !!accountId;

  useEffect(() => {
    setIsWalletReady(true);

    // Create a minimal Near instance with fetch-based wallet
    const nearInst = new Near({
      network: { rpcUrl: RPC_URLS.testnet, networkId: 'testnet' },
      wallet: {
        signAndSendTransaction: async (params: any) => {
          const action = params.actions?.[0] as any;
          if (action?.type === 'FunctionCall') {
            const result = await sendFunctionCall({
              rpcUrl: rpcRef.current,
              signerId: DEV_ACCOUNT_ID,
              secretKey: keyRef.current.secretKey,
              contractId: params.receiverId,
              methodName: action.methodName,
              args: action.args || {},
              gas: action.gas || '300000000000000',
              deposit: action.deposit || '0',
            });
            return { transaction: { hash: result.transaction_hash } };
          }
          throw new Error('Unsupported transaction type');
        },
        view: async (contractId: string, method: string, args: any) => {
          return await viewFunction(rpcRef.current, contractId, method, args);
        },
        getAccountId: () => DEV_ACCOUNT_ID,
        signOut: async () => {},
      } as any,
    });
    setNear(nearInst);
  }, []);

  const connect = useCallback(() => {}, []);
  const disconnect = useCallback(async () => {}, []);
  const switchNetwork = useCallback((_n: NetworkType) => {}, []);

  const signAndSendTransaction = useCallback(async (params: SignAndSendTransactionParams) => {
    const action = params.actions?.[0] as any;
    if (action?.type === 'FunctionCall') {
      const result = await sendFunctionCall({
        rpcUrl: rpcRef.current,
        signerId: DEV_ACCOUNT_ID,
        secretKey: keyRef.current.secretKey,
        contractId: params.receiverId,
        methodName: action.methodName,
        args: action.args || {},
        gas: action.gas || '300000000000000',
        deposit: action.deposit || '0',
      });
      return { transaction: { hash: result.transaction_hash } };
    }
    throw new Error('Unsupported transaction type');
  }, []);

  const viewMethod = useCallback(async (params: { contractId: string; method: string; args?: Record<string, unknown> }) => {
    return await viewFunction(rpcRef.current, params.contractId, params.method, params.args || {});
  }, []);

  const requestLogin = useCallback(() => {}, []);
  const closeLoginModal = useCallback(() => setLoginModalOpen(false), []);

  return (
    <WalletContext.Provider value={{
      accountId, isConnected, isWalletReady, network, near,
      connect, disconnect, switchNetwork,
      signAndSendTransaction, viewMethod,
      loginModalOpen, requestLogin, closeLoginModal,
    }}>
      {children}
    </WalletContext.Provider>
  );
}

// ── Normal wallet provider (Meteor / near-connect) ──

export function WalletProvider({ children }: { children: ReactNode }) {
  if (isDevMode()) {
    return <DevWalletProvider>{children}</DevWalletProvider>;
  }

  const getInitialNetwork = (): NetworkType => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('vault:network');
      if (stored === 'testnet' || stored === 'mainnet') return stored;
    }
    return 'testnet' as NetworkType;
  };

  const [network, setNetwork] = useState<NetworkType>(getInitialNetwork);
  const [accountId, setAccountId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('vault:cachedAccountId');
  });
  const [isWalletReady, setIsWalletReady] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [near, setNear] = useState<Near | null>(null);

  const connectorRef = useRef<NearConnector | null>(null);
  const prevNetworkRef = useRef(network);

  const isConnected = !!accountId;

  // Initialize near-connect
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      setIsWalletReady(false);

      const connector = new NearConnector({ network, autoConnect: true });
      if (cancelled) return;
      connectorRef.current = connector;

      // Listen for sign-in
      connector.on('wallet:signIn', async (data: any) => {
        if (cancelled) return;
        const id = data?.accountId || data?.account?.accountId;
        if (id) {
          setAccountId(id);
          localStorage.setItem('vault:cachedAccountId', id);
          setLoginModalOpen(false);
          setNear(new Near({
            network: { rpcUrl: RPC_URLS[network], networkId: network },
            wallet: fromNearConnect(connector),
          }));
        }
      });

      connector.on('wallet:signOut', () => {
        if (cancelled) return;
        setAccountId(null);
        localStorage.removeItem('vault:cachedAccountId');
        setNear(null);
      });

      // Restore session
      try {
        const wallet = await connector.wallet();
        if (wallet && !cancelled) {
          const accounts = await wallet.getAccounts();
          if (accounts && accounts.length > 0) {
            const id = accounts[0].accountId;
            setAccountId(id);
            localStorage.setItem('vault:cachedAccountId', id);
            setNear(new Near({
              network: { rpcUrl: RPC_URLS[network], networkId: network },
              wallet: fromNearConnect(connector),
            }));
          }
        }
      } catch (_) {}

      setIsWalletReady(true);
    };

    init();

    return () => { cancelled = true; };
  }, [network]);

  const connect = useCallback(() => {
    connectorRef.current?.connect().catch(() => {});
  }, []);

  const disconnect = useCallback(async () => {
    try { await connectorRef.current?.wallet().then(w => w.signOut()); } catch (_) {}
    setAccountId(null);
    localStorage.removeItem('vault:cachedAccountId');
    setNear(null);
  }, []);

  const switchNetwork = useCallback((n: NetworkType) => setNetwork(n), []);

  const signAndSendTransaction = useCallback(async (params: SignAndSendTransactionParams) => {
    const connector = connectorRef.current;
    if (!connector) throw new Error('Not connected');

    // Route all single FunctionCall actions through near.call() — it properly
    // converts the action format for near-connect wallets. The raw wallet
    // path (line 408) uses useVault's { type, methodName, args, gas, deposit }
    // format which wallets don't understand.
    const nearInst = near;
    if (
      nearInst &&
      params.receiverId &&
      params.actions?.length === 1
    ) {
      const action = params.actions[0] as any;
      if (action.type === 'FunctionCall') {
        return await nearInst.call(
          params.receiverId,
          action.methodName,
          action.args,
          {
            gas: action.gas,
            ...(action.deposit && action.deposit !== '0'
              ? { attachedDeposit: action.deposit + ' yocto' }
              : {}),
          },
        );
      }
    }

    const wallet = await connector.wallet();
    return await wallet.signAndSendTransaction(params);
  }, [near]);

  const viewMethod = useCallback(async (params: { contractId: string; method: string; args?: Record<string, unknown> }) => {
    const nearInst = near;
    if (!nearInst) throw new Error('Not connected');
    return nearInst.view(params.contractId, params.method, params.args || {});
  }, [near]);

  const requestLogin = useCallback(() => { if (!isConnected) setLoginModalOpen(true); }, [isConnected]);
  const closeLoginModal = useCallback(() => setLoginModalOpen(false), []);

  return (
    <WalletContext.Provider value={{
      accountId, isConnected, isWalletReady, network, near,
      connect, disconnect, switchNetwork,
      signAndSendTransaction, viewMethod,
      loginModalOpen, requestLogin, closeLoginModal,
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
