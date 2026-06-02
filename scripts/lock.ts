import { connect, keyStores, KeyPair } from 'near-api-js';

async function main() {
  const ACCOUNT = 'kampy.testnet';
  const CONTRACT = 'vault.kampy.testnet';
  const DEPOSIT = '10000000000000000000000'; // 0.01 NEAR
  const DURATION_NS = '3600000000000'; // 1 hour

  const ks = new keyStores.InMemoryKeyStore();
  ks.setKey('testnet', ACCOUNT, KeyPair.fromString('ed25519:2x4vPMCM5bTtXYQVBpCi2GUzskEg9qCNA8FHDDFEJFqNJmL1nkRNNKupvLdRs1dzmepSPtZRWLKfcK4mN3B68i3x'));
  const near = await connect({ networkId: 'testnet', nodeUrl: 'https://rpc.testnet.fastnear.com', keyStore: ks });
  const account = await near.account(ACCOUNT);

  const result = await account.functionCall({
    contractId: CONTRACT,
    methodName: 'lock',
    args: { owner: ACCOUNT, duration_ns: DURATION_NS },
    gas: '30000000000000',
    attachedDeposit: DEPOSIT,
  });

  console.log(`LOCKED 0.01 NEAR for 1h`);
  console.log(`tx: ${result.transaction.hash}`);
  console.log(`explorer: https://testnet.near.rocks/tx/${result.transaction.hash}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
