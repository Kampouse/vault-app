import { useWallet } from '@/contexts/WalletContext';
import { useState, useEffect } from 'react';
import type { NetworkType } from '@/contexts/WalletContext';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface WalletConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function WalletConnectionModal({ isOpen, onClose }: WalletConnectionModalProps) {
  const {
    network,
    switchNetwork,
    connect,
    isConnected,
    isWalletReady,
  } = useWallet();
  const [pendingNetwork, setPendingNetwork] = useState<NetworkType>(network);

  useEffect(() => {
    if (isOpen) {
      setPendingNetwork(network);
    }
  }, [isOpen, network]);

  useEffect(() => {
    if (isConnected && isOpen) {
      onClose();
    }
  }, [isConnected, isOpen, onClose]);

  const handleNetworkChange = async (newNetwork: NetworkType) => {
    if (newNetwork === network) {
      setPendingNetwork(newNetwork);
      return;
    }
    setPendingNetwork(newNetwork);
    switchNetwork(newNetwork);
  };

  const handleConnect = () => {
    if (!isWalletReady) return;
    onClose(); // close modal first so wallet selector popup isn't blocked
    connect();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white">
            {isConnected ? 'Wallet Connected' : 'Connect Wallet'}
          </DialogTitle>
          <DialogDescription>
            {isConnected
              ? 'Your wallet is connected.'
              : 'Select a network and connect your NEAR wallet'}
          </DialogDescription>
        </DialogHeader>

        {!isConnected ? (
          <div className="space-y-6">
            {/* Network Selector */}
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-2">
                Network
              </label>
              <div className="flex items-center bg-zinc-800/50 rounded-lg p-1">
                <button
                  onClick={() => handleNetworkChange('testnet')}
                  className={`flex-1 px-4 py-2.5 rounded-md text-sm font-medium transition-colors ${
                    pendingNetwork === 'testnet'
                      ? 'bg-zinc-700 text-white shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  Testnet
                </button>
                <button
                  onClick={() => handleNetworkChange('mainnet')}
                  className={`flex-1 px-4 py-2.5 rounded-md text-sm font-medium transition-colors ${
                    pendingNetwork === 'mainnet'
                      ? 'bg-zinc-700 text-white shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  Mainnet
                </button>
              </div>
            </div>

            {/* Connect Button */}
            <Button
              onClick={handleConnect}
              disabled={!isWalletReady || pendingNetwork !== network}
              className="w-full h-12 text-base font-semibold"
            >
              {!isWalletReady || pendingNetwork !== network
                ? 'Switching network...'
                : `Connect to ${pendingNetwork === 'testnet' ? 'Testnet' : 'Mainnet'}`}
            </Button>

            {(!isWalletReady || pendingNetwork !== network) && (
              <p className="text-xs text-zinc-500 text-center">
                Please wait while we switch to {pendingNetwork}...
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-zinc-400 text-sm">
              Your wallet is already connected.
            </p>
            <Button variant="outline" onClick={onClose} className="w-full">
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
