import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../../config";
import { AppError } from "../../errors/appError";
import { SorobanService, ContractCallResult } from "../soroban";
import { SorobanNotConfiguredError, SorobanSimulationError, SorobanTransactionError } from "../sorobanErrors";
import { describeGlobeWalletError } from "./globeWalletErrors";
import type {
  AssetInfo,
  AllowedTokenInfo,
  RecoveryConfigView,
  RecoveryProposalView,
  RecoveryState,
  SpendAllowance,
} from "@stellar-global-wallet/types";

// Re-exported for backward compatibility — this used to be declared locally
// here. The canonical definition now lives in packages/types (issue #107)
// so it can be shared with future SDK/client packages.
export type { AssetInfo, AllowedTokenInfo, RecoveryConfigView, RecoveryProposalView, RecoveryState, SpendAllowance };

/** Average ledger close time used for ETA estimates (same figure as getPendingUpgrade). */
const SECONDS_PER_LEDGER = 5;

/** Raw `scValToNative` shape of the contract's `RecoveryConfig`. */
interface RawRecoveryConfig {
  threshold: number;
  delay_in_ledgers: number;
}

/** Raw `scValToNative` shape of the contract's `RecoveryProposal`. */
interface RawRecoveryProposal {
  new_admin: string;
  approvals: string[];
  ready_at?: number | null;
}

/** Raw `scValToNative` shape of the contract's `SpendAllowance` (#50). */
interface RawSpendAllowance {
  limit: bigint | number | string;
  spent: bigint | number | string;
  remaining: bigint | number | string;
  window_start: bigint | number | string;
  window_resets_at: bigint | number | string;
}

/** Simulation-only source for reads with no natural caller; never needs to exist on-chain. */
function readOnlySource(): string {
  return StellarSdk.Keypair.random().publicKey();
}

function unixSecondsToIso(value: bigint | number | string): string {
  return new Date(Number(value) * 1000).toISOString();
}

/**
 * Adds quorum and timelock fields to a raw proposal. `latestLedger` is null
 * when RPC couldn't report it; the ETA fields are then null too, but the
 * on-chain facts (approvals, readyAtLedger) are still returned.
 */
export function deriveRecoveryProposal(
  raw: RawRecoveryProposal,
  config: RecoveryConfigView | null,
  latestLedger: number | null,
  now: number = Date.now()
): RecoveryProposalView {
  const approvals = raw.approvals ?? [];
  const threshold = config?.threshold ?? null;
  const readyAtLedger = raw.ready_at ?? null;
  const ledgersRemaining =
    readyAtLedger !== null && latestLedger !== null ? Math.max(0, readyAtLedger - latestLedger) : null;
  return {
    newAdmin: raw.new_admin,
    approvals,
    approvalsCount: approvals.length,
    threshold,
    approvalsRemaining: threshold !== null ? Math.max(0, threshold - approvals.length) : null,
    quorumReached: threshold !== null && approvals.length >= threshold,
    readyAtLedger,
    latestLedger,
    ledgersRemaining,
    executableAt:
      ledgersRemaining !== null ? new Date(now + ledgersRemaining * SECONDS_PER_LEDGER * 1000).toISOString() : null,
    executable: readyAtLedger !== null && latestLedger !== null && latestLedger >= readyAtLedger,
  };
}

/** Converts the contract's i128/u64 view into the API's string-amount shape. */
export function toSpendAllowance(assetCode: string, raw: RawSpendAllowance): SpendAllowance {
  const limit = BigInt(raw.limit);
  const unlimited = limit === 0n;
  return {
    assetCode,
    unlimited,
    limit: limit.toString(),
    spent: BigInt(raw.spent).toString(),
    remaining: unlimited ? null : BigInt(raw.remaining).toString(),
    windowStartsAt: unixSecondsToIso(raw.window_start),
    windowResetsAt: unixSecondsToIso(raw.window_resets_at),
  };
}

function requireContractId(): string {
  if (!config.GLOBE_WALLET_CONTRACT_ID) {
    throw new SorobanNotConfiguredError();
  }
  return config.GLOBE_WALLET_CONTRACT_ID;
}

/** Re-throws Soroban errors with contract-specific error codes translated to readable names. */
function withWalletErrorTranslation<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    if (err instanceof SorobanSimulationError) {
      throw new SorobanSimulationError(describeGlobeWalletError(err.raw ?? err.message), err.raw);
    }
    if (err instanceof SorobanTransactionError) {
      throw new SorobanTransactionError(describeGlobeWalletError(err.message), err.hash);
    }
    throw err;
  });
}

/**
 * Re-throws a simulation failure caused by a known `WalletError` as a
 * {@link SorobanContractError} carrying the stable API code (e.g.
 * SPEND_LIMIT_EXCEEDED), so clients can branch on `error.code`. Anything else
 * passes through untouched.
 */
function withContractErrorCodes<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    if (err instanceof SorobanSimulationError) {
      const raw = err.raw ?? err.message;
      const contractErrorCode = extractContractErrorCode(raw);
      const apiCode = getGlobeWalletApiCode(raw);
      if (contractErrorCode !== null && apiCode) {
        throw new SorobanContractError(describeGlobeWalletError(raw), apiCode, contractErrorCode, err.raw);
      }
    }
    throw err;
  });
}

/**
 * Typed access to the deployed `globe-wallet` Soroban contract
 * (Orbit-Wal/contract, contracts/globe-wallet). Encodes/decodes ScVal
 * arguments for the specific functions this backend calls; generic
 * simulate/invoke/poll mechanics live in {@link SorobanService}.
 */
export class GlobeWalletContract {
  constructor(private readonly soroban: SorobanService) {}

  /** Builds unsigned XDR for registering a wallet asset (#8). */
  async buildAddAssetTx(params: {
    user: string;
    asset: AssetInfo;
  }): Promise<string> {
    const contractId = requireContractId();
    const { user, asset } = params;
    const currentAssets = await this.getAssets(user);
    if (currentAssets.some((current) => current.code.toLowerCase() === asset.code.toLowerCase())) {
      throw new AppError("This asset has already been added to the wallet", {
        code: "ASSET_ALREADY_ADDED",
        status: 409,
      });
    }
    const assetInfo = StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol("code"),
        val: StellarSdk.nativeToScVal(asset.code, { type: "string" }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol("issuer"),
        val:
          asset.issuer === null
            ? StellarSdk.xdr.ScVal.scvVoid()
            : StellarSdk.nativeToScVal(asset.issuer, { type: "address" }),
      }),
    ]);
    return this.soroban.buildUnsignedTransaction({
      contractId,
      method: "add_asset",
      sourcePublicKey: user,
      args: [
        StellarSdk.nativeToScVal(user, { type: "address" }),
        assetInfo,
      ],
    });
  }

  /** Builds unsigned XDR for removing a wallet asset (#8). */
  async buildRemoveAssetTx(params: {
    user: string;
    assetCode: string;
  }): Promise<string> {
    const contractId = requireContractId();
    const { user, assetCode } = params;
    const allowance = await this.getSpendAllowance(user, assetCode);
    if (!allowance.unlimited) {
      throw new AppError("Remove the asset's spend limit before removing it", {
        code: "ASSET_HAS_ACTIVE_SPEND_LIMIT",
        status: 409,
      });
    }
    return this.soroban.buildUnsignedTransaction({
      contractId,
      method: "remove_asset",
      sourcePublicKey: user,
      args: [
        StellarSdk.nativeToScVal(user, { type: "address" }),
        StellarSdk.nativeToScVal(assetCode, { type: "string" }),
      ],
    });
  }

  /** Read-only: the caller's whitelisted assets. Free — simulated, never submitted. */
  async getAssets(userPublicKey: string): Promise<AssetInfo[]> {
    const contractId = requireContractId();
    return withWalletErrorTranslation(
      this.soroban.simulate<AssetInfo[]>({
        contractId,
        method: "get_assets",
        sourcePublicKey: userPublicKey,
        args: [StellarSdk.nativeToScVal(userPublicKey, { type: "address" })],
      })
    );
  }

  /** Read-only: the current guardian set (#51). Empty array when none are registered. */
  async getGuardians(): Promise<string[]> {
    const contractId = requireContractId();
    const guardians = await withWalletErrorTranslation(
      this.soroban.simulate<string[] | null>({
        contractId,
        method: "guardians",
        sourcePublicKey: readOnlySource(),
        args: [],
      })
    );
    return guardians ?? [];
  }

  /** Read-only: recovery threshold and timelock (#51). Null when recovery isn't configured. */
  async getRecoveryConfig(): Promise<RecoveryConfigView | null> {
    const contractId = requireContractId();
    const raw = await withWalletErrorTranslation(
      this.soroban.simulate<RawRecoveryConfig | null | undefined>({
        contractId,
        method: "recovery_config",
        sourcePublicKey: readOnlySource(),
        args: [],
      })
    );
    if (!raw) return null;
    return { threshold: Number(raw.threshold), delayInLedgers: Number(raw.delay_in_ledgers) };
  }

  /**
   * Read-only: the active recovery proposal with approvals-vs-threshold and
   * timelock ETA (#51). Null when no recovery is in progress.
   */
  async getRecoveryProposal(config?: RecoveryConfigView | null): Promise<RecoveryProposalView | null> {
    const contractId = requireContractId();
    const [raw, resolvedConfig] = await Promise.all([
      withWalletErrorTranslation(
        this.soroban.simulate<RawRecoveryProposal | null | undefined>({
          contractId,
          method: "recovery_proposal",
          sourcePublicKey: readOnlySource(),
          args: [],
        })
      ),
      config !== undefined ? Promise.resolve(config) : this.getRecoveryConfig(),
    ]);
    if (!raw) return null;

    let latestLedger: number | null = null;
    try {
      latestLedger = await this.soroban.getLatestLedger();
    } catch {
      latestLedger = null;
    }
    return deriveRecoveryProposal(
      { ...raw, ready_at: raw.ready_at === undefined || raw.ready_at === null ? null : Number(raw.ready_at) },
      resolvedConfig,
      latestLedger
    );
  }

  /** Guardians, config and proposal in one call for the recovery screen (#51). */
  async getRecoveryState(): Promise<RecoveryState> {
    const [guardians, config] = await Promise.all([this.getGuardians(), this.getRecoveryConfig()]);
    const proposal = await this.getRecoveryProposal(config);
    return {
      guardians,
      guardianCount: guardians.length,
      config,
      configured: config !== null,
      proposal,
    };
  }

  /**
   * Read-only: daily limit, spent-today and remaining for one asset (#50).
   * Window bounds come from the contract's own ledger-time calculation.
   */
  async getSpendAllowance(userPublicKey: string, assetCode: string): Promise<SpendAllowance> {
    const contractId = requireContractId();
    const raw = await withWalletErrorTranslation(
      this.soroban.simulate<RawSpendAllowance>({
        contractId,
        method: "get_spend_allowance",
        sourcePublicKey: userPublicKey,
        args: [
          StellarSdk.nativeToScVal(userPublicKey, { type: "address" }),
          StellarSdk.nativeToScVal(assetCode, { type: "string" }),
        ],
      })
    );
    return toSpendAllowance(assetCode, raw);
  }

  /** {@link getSpendAllowance} for every asset on the user's whitelist (#50). */
  async getSpendAllowances(userPublicKey: string): Promise<SpendAllowance[]> {
    const assets = await this.getAssets(userPublicKey);
    return Promise.all(assets.map((asset) => this.getSpendAllowance(userPublicKey, asset.code)));
  }

  /**
   * Records a spend against the caller's daily limit for `assetCode`,
   * rejecting (via simulation, before any fee is paid) if it would exceed
   * that limit. `userSecretKey` both signs and authorizes — `record_spend`
   * calls `user.require_auth()` for this exact account.
   */
  async recordSpend(params: {
    userSecretKey: string;
    assetCode: string;
    /** Amount in the asset's smallest unit (stroops), as a decimal string. */
    amount: string;
  }): Promise<ContractCallResult<null>> {
    const contractId = requireContractId();
    const { userSecretKey, assetCode, amount } = params;
    const userPublicKey = StellarSdk.Keypair.fromSecret(userSecretKey).publicKey();
    return withWalletErrorTranslation(
      this.soroban.invoke<null>({
        contractId,
        method: "record_spend",
        sourceSecretKey: userSecretKey,
        args: [
          StellarSdk.nativeToScVal(userPublicKey, { type: "address" }),
          StellarSdk.nativeToScVal(assetCode, { type: "string" }),
          StellarSdk.nativeToScVal(BigInt(amount), { type: "i128" }),
        ],
      })
    );
  }

  /**
   * Non-custodial {@link recordSpend}: simulates `record_spend` and returns
   * the assembled transaction unsigned for `userPublicKey` to sign (the
   * contract calls `user.require_auth()` for this exact account). A spend that
   * would break the daily limit fails here, in simulation, with the mapped
   * contract error code — before anyone signs.
   */
  async buildRecordSpend(params: {
    userPublicKey: string;
    assetCode: string;
    /** Amount in the asset's smallest unit (stroops), as an integer string. */
    amount: string;
  }): Promise<PreparedInvocation> {
    const contractId = requireContractId();
    const { userPublicKey, assetCode, amount } = params;
    return withWalletErrorTranslation(
      withContractErrorCodes(
        this.soroban.prepareInvocation({
          contractId,
          method: "record_spend",
          sourcePublicKey: userPublicKey,
          args: [
            StellarSdk.nativeToScVal(userPublicKey, { type: "address" }),
            StellarSdk.nativeToScVal(assetCode, { type: "string" }),
            // BigInt, not Number: amounts past 2^53 stroops must survive exactly.
            StellarSdk.nativeToScVal(BigInt(amount), { type: "i128" }),
          ],
        })
      )
    );
  }

  /** Submits a transaction signed by the user (from {@link buildRecordSpend} or any other build) and waits for the result. */
  async submitSigned(signedXdr: string): Promise<SubmitSignedResult | SubmitSignedPending> {
    return withWalletErrorTranslation(this.soroban.submitSigned({ signedXdr }));
  }

  /**
   * Read current admin and pending admin candidate (if any) for settings screen (#80).
   * Pending state is null-safe.
   */
  async getAdminState(callerPublicKey?: string): Promise<{ admin: string; pendingAdmin: string | null }> {
    const contractId = requireContractId();
    const sourcePublicKey = callerPublicKey || StellarSdk.Keypair.random().publicKey();

    const admin = await withWalletErrorTranslation(
      this.soroban.simulate<string>({
        contractId,
        method: "admin",
        sourcePublicKey,
        args: [],
      })
    );

    let pendingAdmin: string | null = null;
    try {
      const res = await withWalletErrorTranslation(
        this.soroban.simulate<string | null>({
          contractId,
          method: "pending_admin",
          sourcePublicKey,
          args: [],
        })
      );
      pendingAdmin = res ?? null;
    } catch {
      pendingAdmin = null;
    }

    return { admin, pendingAdmin };
  }

  /**
   * Read pending contract upgrade proposal and execution ETA (#81).
   * Returns null if no upgrade is queued.
   */
  async getPendingUpgrade(callerPublicKey?: string): Promise<{
    wasmHash: string;
    proposedBy: string;
    readyAtLedger: number;
    executableAt: string | null;
  } | null> {
    const contractId = requireContractId();
    const sourcePublicKey = callerPublicKey || StellarSdk.Keypair.random().publicKey();

    try {
      const proposal = await withWalletErrorTranslation(
        this.soroban.simulate<{
          wasm_hash: Buffer | Uint8Array | string;
          proposed_by: string;
          ready_at: number;
        } | null>({
          contractId,
          method: "pending_upgrade",
          sourcePublicKey,
          args: [],
        })
      );

      if (!proposal) return null;

      let wasmHash = "";
      if (typeof proposal.wasm_hash === "string") {
        wasmHash = proposal.wasm_hash;
      } else if (proposal.wasm_hash && (proposal.wasm_hash instanceof Uint8Array || Buffer.isBuffer(proposal.wasm_hash))) {
        wasmHash = Buffer.from(proposal.wasm_hash).toString("hex");
      }

      const readyAtLedger = proposal.ready_at;
      let executableAt: string | null = null;

      try {
        const latest = await this.soroban.getLatestLedger();
        if (typeof latest === "number") {
          const ledgersRemaining = Math.max(0, readyAtLedger - latest);
          const secondsRemaining = ledgersRemaining * 5; // ~5 seconds per ledger on Stellar
          executableAt = new Date(Date.now() + secondsRemaining * 1000).toISOString();
        }
      } catch {
        executableAt = null;
      }

      return {
        wasmHash,
        proposedBy: proposal.proposed_by,
        readyAtLedger,
        executableAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * Builds unsigned XDR to propose a new admin candidate (#80).
   */
  async buildProposeAdminTx(params: {
    currentAdmin: string;
    candidate: string;
  }): Promise<string> {
    const contractId = requireContractId();
    const { currentAdmin, candidate } = params;
    return this.soroban.buildUnsignedTransaction({
      contractId,
      method: "propose_admin",
      sourcePublicKey: currentAdmin,
      args: [
        StellarSdk.nativeToScVal(currentAdmin, { type: "address" }),
        StellarSdk.nativeToScVal(candidate, { type: "address" }),
      ],
    });
  }

  /**
   * Builds unsigned XDR to accept a pending admin transfer (#80).
   */
  async buildAcceptAdminTx(params: {
    candidate: string;
  }): Promise<string> {
    const contractId = requireContractId();
    const { candidate } = params;
    return this.soroban.buildUnsignedTransaction({
      contractId,
      method: "accept_admin",
      sourcePublicKey: candidate,
      args: [StellarSdk.nativeToScVal(candidate, { type: "address" })],
    });
  }

  /**
   * Builds unsigned XDR to cancel a pending admin transfer (#80).
   */
  async buildCancelAdminTransferTx(params: {
    currentAdmin: string;
  }): Promise<string> {
    const contractId = requireContractId();
    const { currentAdmin } = params;
    return this.soroban.buildUnsignedTransaction({
      contractId,
      method: "cancel_admin_transfer",
      sourcePublicKey: currentAdmin,
      args: [StellarSdk.nativeToScVal(currentAdmin, { type: "address" })],
    });
  }
}
