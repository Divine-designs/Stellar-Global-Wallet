<div align="center">

# 🌍 Stellar Global Wallet

**A multi-asset wallet on Stellar with daily spend limits, guardian-based social recovery, and Soroban smart contracts.**

![Network](https://img.shields.io/badge/network-testnet-orange?style=flat-square&logo=stellar)
![Rust](https://img.shields.io/badge/Rust-Soroban-000000?style=flat-square&logo=rust)
![TypeScript](https://img.shields.io/badge/TypeScript-Node.js-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Contributions](https://img.shields.io/badge/contributions-welcome-brightgreen?style=flat-square)

[🎨 Design](https://claude.ai/artifact/HAEA9kUpEhSMCyjDwCBL6t#page-dcb81aee8d83) · [📖 Project overview](HACKMD.md) · [🤝 Contribute](#-how-you-can-help)

</div>

---

## ✨ What it does

| | Feature | |
|:-:|---|---|
| 💸 | **Send and receive** | XLM and any Stellar asset, with path payments and fee bumps |
| 🪙 | **Multi-asset** | Users choose which assets their wallet tracks |
| 🛑 | **Daily spend limits** | Per-asset caps enforced on-chain |
| 🛡️ | **Social recovery** | Trusted guardians can restore access after a timelock |
| 👥 | **Multisig** | Partial signing and threshold management |
| ⬆️ | **Safe upgrades** | Contract upgrades and admin changes go through a timelock |

## 🏗️ Architecture

```mermaid
flowchart LR
    WEB["🖥️ Web app"] --> API
    MOB["📱 Mobile app"] --> API
    API["⚙️ Backend API"] --> HZ["🌐 Horizon"]
    API --> RPC["🛰️ Soroban RPC"]
    RPC --> GW["📜 globe-wallet"] --> TW["📜 token-wrapper"]
```

| Part | Path | Stack | Status |
|---|---|---|:-:|
| 🖥️ Web app | `frontend/` *(planned)* | Next.js · Tailwind | ⚪ Not started |
| 📱 Mobile app | `mobile/` *(planned)* | React Native · Expo | ⚪ Not started |
| ⚙️ Backend API | [`backend/`](backend/) | Node.js · Express · TypeScript · PostgreSQL · Redis | 🟡 Testnet |
| 📜 Smart contracts | [`contract/`](contract/) | Rust · Soroban | 🟡 Testnet |
| 📦 SDK | [`packages/sdk`](packages/sdk/) | TypeScript, published as `@globe-wallet/sdk` | 🟡 Testnet |

The UI is designed in the [Figma file template](https://claude.ai/artifact/HAEA9kUpEhSMCyjDwCBL6t#page-dcb81aee8d83). For a deep dive into structure, testnet status and the roadmap, see **[HACKMD.md](HACKMD.md)**. For which API URL, contract ID, or feature flags apply to local vs. testnet vs. mainnet, see **[backend/docs/environments.md](backend/docs/environments.md)**. Product analytics events and their privacy rules are defined in **[docs/specs/analytics.md](docs/specs/analytics.md)**. For how clients build, sign and submit transactions (Freighter, xBull, WalletConnect, local keystore), see **[backend/docs/client-signing.md](backend/docs/client-signing.md)**.

Frontend behaviour specs live in [`docs/specs/`](docs/specs/): [spend limits](docs/specs/spend-limits.md).

## 🚀 Quick start

```bash
git clone https://github.com/Genghis-codes/Stellar-Global-Wallet.git
cd Stellar-Global-Wallet
```

This repo is an npm workspace root (`backend`, `packages/*`) — run `npm install` once at the repo root, not inside `backend/`, so the shared `packages/types` package resolves.

| Part | Setup |
|---|---|
| ⚙️ Backend (manual) | `npm install && cp backend/.env.example backend/.env && npm run dev --workspace backend` |
| 🐳 Backend (Docker) | `cp .env.example .env && docker compose up --build` → API on `http://localhost:4000` (Postgres + Redis included) |
| 🛰️ Local Stellar network | `docker compose --profile local up -d stellar` then `contract/scripts/deploy-local.sh` — avoids testnet resets/Friendbot limits, see [`contract/README.md`](contract/README.md) |
| 📜 Contracts | `cd contract && cargo test --workspace` |
| 📦 SDK / packages | `npm install && npm run build --workspaces` (from the repo root) |
| 🔗 Contract bindings | `contract/scripts/bindings.sh` — regenerates `packages/bindings/globe-wallet` and `packages/bindings/token-wrapper` |
| 🧪 Seeded Demo Wallet | `npm run seed:demo --workspace backend` — provisions 5 testnet accounts, assets, limits, and recovery state |
| 🖥️ / 📱 Apps | Not built yet. This is a great place to start contributing! |

Each package's README has full details.

## 🤝 How you can help

We welcome contributors of every level. Here's what we need most:

| | Area | What we need |
|:-:|---|---|
| 🐛 | **Bug fixes** | Reproduce and fix issues in the API or contracts, tighten input validation, improve error messages |
| ✨ | **New features** | Build the web and mobile apps from the Figma design, client-side signing with wallets like Freighter and xBull, a real price oracle, an event indexer, and more contract features exposed through the API |
| 📚 | **Documentation** | OpenAPI/Swagger spec, setup guides, architecture diagrams, contract usage examples, user-facing docs |
| 🧪 | **Testing** | More unit and integration tests, end-to-end tests on testnet, contract fuzzing and edge cases, frontend tests once the apps exist |

### Contribution flow

```mermaid
flowchart LR
    A["🔍 Pick an issue"] --> B["🍴 Fork & branch"] --> C["💻 Code + tests"] --> D["✅ CI passes"] --> E["📬 Open a PR"] --> F["🎉 Merged"]
```

1. Browse the [open issues](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues), or open one with the issue templates.
2. Read the package's `CONTRIBUTING.md` ([backend](backend/CONTRIBUTING.md) · [contract](contract/CONTRIBUTING.md) · [frontend/mobile](CONTRIBUTING.md)).
3. Keep each PR focused on one change, and include tests where it makes sense.

## ⚙️ CI

| Workflow | Runs when | Checks |
|---|---|---|
| `backend.yml` | `backend/` changes | Type-check, Jest tests |
| `contract.yml` | `contract/` changes | `cargo check`, `cargo test` |
| `packages.yml` | `packages/*` changes | Lint, type-check, test, build each package |
| `contract-bindings.yml` | `contract/contracts/globe-wallet/**` or `contract/contracts/token-wrapper/**` changes | Rebuilds the contract wasm, regenerates `packages/bindings/globe-wallet` and `packages/bindings/token-wrapper`, fails if stale, type-checks the SDK against them |
| `release.yml` | PRs and pushes to `main` | Dry-runs (PRs) or performs (`main`, via Changesets) the npm release of `packages/*` |

## ⚠️ Status

This project is in **active development on Stellar testnet**. It has not been audited, so do not use it with real funds.
