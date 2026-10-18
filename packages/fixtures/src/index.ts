import fundedAccount from "../json/accounts/funded.json";
import unfundedAccount from "../json/accounts/unfunded.json";
import multisigAccount from "../json/accounts/multisig.json";
import balances from "../json/balances.json";
import transactions from "../json/transactions.json";
import contractState from "../json/contract-state.json";

export interface AccountFixture {
  id: string;
  account_id: string;
  sequence: string;
  subentry_count: number;
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
  flags: { auth_required: boolean; auth_revocable: boolean; auth_immutable: boolean };
  balances: BalanceFixture[];
  signers: { weight: number; key: string; type: string }[];
}

export interface BalanceFixture {
  balance: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  limit?: string;
}

export interface TransactionFixture {
  id: string;
  hash: string;
  type: string;
  source_account: string;
  created_at: string;
  successful: boolean;
  operations: Record<string, unknown>[];
}

export interface ContractStateFixture {
  assets: { code: string; issuer: string; limit: string }[];
  limits: { daily: string; perTransaction: string };
  guardians: string[];
  recoveryProposal: { id: string; status: string; approvals: string[]; createdAt: string };
}

export const accounts = {
  funded: fundedAccount as AccountFixture,
  unfunded: unfundedAccount as AccountFixture,
  multisig: multisigAccount as AccountFixture,
};

export const balanceFixtures = balances as BalanceFixture[];
export const transactionFixtures = transactions as TransactionFixture[];
export const contractStateFixture = contractState as ContractStateFixture;

/**
 * Build an account fixture, deep-merging shallow overrides on top of the
 * funded account. Deterministic: no randomness, no network.
 */
export function makeAccount(overrides: Partial<AccountFixture> = {}): AccountFixture {
  return {
    ...accounts.funded,
    ...overrides,
    thresholds: { ...accounts.funded.thresholds, ...(overrides.thresholds ?? {}) },
    flags: { ...accounts.funded.flags, ...(overrides.flags ?? {}) },
    balances: overrides.balances ?? accounts.funded.balances,
    signers: overrides.signers ?? accounts.funded.signers,
  };
}

export { fundedAccount, unfundedAccount, multisigAccount, balances, transactions, contractState };
