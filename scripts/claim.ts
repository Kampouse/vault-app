import { connect, keyStores, KeyPair } from 'near-api-js';

async function main() {
  const ACCOUNT = 'kampy.testnet';
  const CONTRACT = 'vault.kampy.testnet';

  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', ACCOUNT, KeyPair.fromString('ed25519:2x4vPMCM5bTtXYQVBpCi2GUzskEg9qCNA8FHDDFEJFqNJmL1nkRNNKupvLdRs1dzmepSPtZRWLKfcK4mN3B68i3x'));
  const near = await connect({ networkId: 'testnet', nodeUrl: 'https://rpc.testnet.near.org', keyStore: ks });
  const account = await near.account(ACCOUNT);

  const result = await account.functionCall({
    contractId: CONTRACT,
    methodName: 'claim',
    args: { owner: ACCOUNT },
    gas: '300000000000000',
  });

  console.log(`CLAIMED`);
  console.log(`tx: ${result.transaction.hash}`);
  console.log(`explorer: https://testnet.near.rocks/tx/${result.transaction.hash}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
