# NEAR Vault App

Token timelock vault deployed on NEAR testnet at `vault.kampy.testnet`.

## Smart Contract (Lisp)

The vault contract is written in Lisp-RLM and compiled to WASM via `near-compile`.

**Contract source**: [`vault.lisp`](./vault.lisp)

### Deploy

```bash
cd lisp-rlm
near-compile deploy examples/vault.lisp --account vault.kampy.testnet
```

### Features
- Lock NEAR and FT tokens with expiry timestamps
- Claim unlocked tokens after expiry
- Multi-lock per owner (v6)

## Frontend (React + TypeScript)

Vite + React + Tailwind CSS + shadcn/ui.

### Install

```bash
npm install
```

### Dev

```bash
npm run dev
```

### Build & Deploy

```bash
npm run build
npx wrangler pages deploy dist --project-name vault-app
```

**Live**: [vault-app-69p.pages.dev](https://vault-app-69p.pages.dev)

## Contract ID
- Testnet: `vault.kampy.testnet`
