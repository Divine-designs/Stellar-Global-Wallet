import type { Response } from "express";
import type { PaymentExportRecord, StellarService } from "./stellar";
import { fromStroops } from "../utils/stroops";
import { NotFoundError } from "../errors/appError";

/**
 * #62 — CSV statement export of an account's payment history.
 *
 * Rows are written to the response one Horizon page at a time (see
 * `StellarService.iteratePaymentsForExport`), honouring backpressure, so
 * memory use is bounded by one page regardless of how many rows the export
 * produces.
 */
export const CSV_COLUMNS = [
  "date",
  "type",
  "direction",
  "amount",
  "asset",
  "counterparty",
  "memo",
  "fee",
  "hash",
] as const;

/** Longest range a single export may cover. */
export const MAX_EXPORT_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export type CsvRow = Record<(typeof CSV_COLUMNS)[number], string>;

/**
 * Quote a cell per RFC 4180 and neutralise CSV/formula injection: a cell
 * starting with `=`, `+`, `-`, `@` (or tab / CR, which some spreadsheet apps
 * also treat as formula triggers) is prefixed with `'` so it's shown as text
 * instead of being evaluated when the statement is opened in Excel/Sheets.
 */
export function escapeCsvCell(value: string): string {
  let cell = value;
  if (/^[=+\-@\t\r]/.test(cell)) {
    cell = `'${cell}`;
  }
  if (/[",\r\n]/.test(cell)) {
    cell = `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function toCsvLine(row: CsvRow): string {
  return CSV_COLUMNS.map((col) => escapeCsvCell(row[col])).join(",") + "\r\n";
}

function assetLabel(op: Record<string, unknown>): string {
  if (op.asset_type === "native") return "XLM";
  if (typeof op.asset_code === "string") return `${op.asset_code}:${op.asset_issuer ?? ""}`;
  return "";
}

/** Map one Horizon payment-shaped operation onto a statement row. */
export function toCsvRow(account: string, record: PaymentExportRecord): CsvRow {
  const op = record.op as unknown as Record<string, unknown>;
  const tx = record.transaction;

  let from: string | undefined;
  let to: string | undefined;
  let amount = "";
  let asset = "";

  switch (op.type) {
    case "create_account":
      from = op.funder as string;
      to = op.account as string;
      amount = (op.starting_balance as string) ?? "";
      asset = "XLM";
      break;
    case "account_merge":
      from = op.account as string;
      to = op.into as string;
      asset = "XLM";
      break;
    default:
      from = op.from as string | undefined;
      to = op.to as string | undefined;
      amount = (op.amount as string | undefined) ?? "";
      asset = assetLabel(op);
  }

  let direction = "";
  let counterparty = "";
  if (from === account && to === account) {
    direction = "self";
    counterparty = account;
  } else if (from === account) {
    direction = "out";
    counterparty = to ?? "";
  } else if (to === account) {
    direction = "in";
    counterparty = from ?? "";
  }

  // The fee is only a cost to this account when it paid it (it was the
  // transaction source). Fee is per transaction, so a multi-operation
  // transaction repeats it on each of its rows.
  let fee = "";
  if (tx && tx.source_account === account && tx.fee_charged !== undefined) {
    fee = fromStroops(BigInt(tx.fee_charged));
  }

  return {
    date: String(op.created_at ?? ""),
    type: String(op.type ?? ""),
    direction,
    amount,
    asset,
    counterparty,
    memo: tx?.memo ?? "",
    fee,
    hash: String(op.transaction_hash ?? ""),
  };
}

/** Write honouring backpressure; rejects if the client disconnects mid-wait. */
function write(res: Response, chunk: string): Promise<void> {
  if (res.destroyed) return Promise.reject(new Error("client disconnected"));
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      res.off("close", onClose);
      resolve();
    };
    const onClose = () => {
      res.off("drain", onDrain);
      reject(new Error("client disconnected"));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

/**
 * Stream the export into `res`. The first Horizon page is fetched before any
 * header is sent, so a failure there (e.g. unknown account) still goes
 * through the normal JSON error envelope. A failure mid-stream can't change
 * the status any more, so the response is aborted instead — the client sees
 * a truncated download rather than a statement that silently looks complete.
 */
export async function streamTransactionCsv(
  res: Response,
  stellar: StellarService,
  params: { publicKey: string; from: Date; to: Date; pageSize?: number }
): Promise<void> {
  const { publicKey, from, to, pageSize } = params;
  const pages = stellar.iteratePaymentsForExport(publicKey, { from, to, pageSize });

  let first: IteratorResult<PaymentExportRecord[]>;
  try {
    first = await pages.next();
  } catch (err) {
    if ((err as { response?: { status?: number } })?.response?.status === 404) {
      throw new NotFoundError(`Account ${publicKey} was not found on Horizon`, "ACCOUNT_NOT_FOUND");
    }
    throw err;
  }

  const filename = `transactions-${publicKey.slice(0, 8)}-${from.toISOString().slice(0, 10)}-${to
    .toISOString()
    .slice(0, 10)}.csv`;
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");

  try {
    await write(res, CSV_COLUMNS.join(",") + "\r\n");
    if (!first.done) {
      for (const record of first.value) await write(res, toCsvLine(toCsvRow(publicKey, record)));
      for await (const page of pages) {
        for (const record of page) await write(res, toCsvLine(toCsvRow(publicKey, record)));
      }
    }
    res.end();
  } catch (err) {
    console.error(`[export] CSV export for ${publicKey} aborted mid-stream: ${err}`);
    res.destroy(err instanceof Error ? err : undefined);
  }
}
