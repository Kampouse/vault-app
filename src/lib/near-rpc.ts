export const RPC_URLS = {
  testnet: 'https://rpc.testnet.fastnear.com',
  mainnet: 'https://rpc.mainnet.near.org',
} as const;

export const VAULT_CONTRACT_ID = 'vault.kampy.testnet';

export function getRpcUrl(network: 'testnet' | 'mainnet'): string {
  return RPC_URLS[network];
}
