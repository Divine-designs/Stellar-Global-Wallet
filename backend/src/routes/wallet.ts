import { Router, Request, Response, NextFunction } from "express";
import { body, param } from "express-validator";
import { jwtAuth } from "../middleware/jwtAuth";
import { assertValidRequest } from "../middleware/requestValidation";
import { logKeypairIssuance } from "../services/auditLog";
import { StellarService } from "../services/stellar";
import { isGAddress, publicKeyMessage, destinationMessage } from "../utils/stellarAddress";
import { validatePathAssets } from "../validation/stellarAsset";
import { isValidMemoText, memoTextMessage } from "@globe-wallet/sdk";
import * as StellarSdk from "@stellar/stellar-sdk";
import { getCachedResult, cacheResult } from "../services/idempotency";

const SEP7_PAY_PREFIX = "web+stellar:pay?";

interface Sep7PayFields {
  destination: string;
  amount?: string;
  asset_code?: string;
  asset_issuer?: string;
  memo?: string;
  memo_type?: string;
  origin_domain?: string;
  signature?: string;
}

function buildSep7PayUri(fields: Sep7PayFields): string {
  const params = new URLSearchParams();
  params.set("destination", fields.destination);
  if (fields.amount !== undefined) params.set("amount", fields.amount);
  if (fields.asset_code !== undefined) params.set("asset_code", fields.asset_code);
  if (fields.asset_issuer !== undefined) params.set("asset_issuer", fields.asset_issuer);
  if (fields.memo !== undefined) {
    params.set("memo", fields.memo);
    params.set("memo_type", fields.memo_type ?? "MEMO_TEXT");
  }
  if (fields.origin_domain !== undefined) params.set("origin_domain", fields.origin_domain);
  if (fields.signature !== undefined) params.set("signature", fields.signature);
  return SEP7_PAY_PREFIX + params.toString();
}

function parseSep7PayUri(uri: string): { fields: Sep7PayFields; warnings: string[] } {
  const warnings: string[] = [];
  if (!uri.startsWith(SEP7_PAY_PREFIX)) {
    throw new Error("URI must start with web+stellar:pay?");
  }
  const query = uri.slice(SEP7_PAY_PREFIX.length);
  const params = new URLSearchParams(query);
  const fields: Sep7PayFields = { destination: params.get("destination") ?? "" };
  const amount = params.get("amount");
  if (amount !== null) fields.amount = amount;
  const assetCode = params.get("asset_code");
  if (assetCode !== null) fields.asset_code = assetCode;
  const assetIssuer = params.get("asset_issuer");
  if (assetIssuer !== null) fields.asset_issuer = assetIssuer;
  const memo = params.get("memo");
  if (memo !== null) fields.memo = memo;
  const memoType = params.get("memo_type");
  if (memoType !== null) fields.memo_type = memoType;
  const originDomain = params.get("origin_domain");
  if (originDomain !== null) fields.origin_domain = originDomain;
  const signature = params.get("signature");
  if (signature !== null) fields.signature = signature;

  if (!fields.destination) {
    warnings.push("Missing destination");
  } else if (!isGAddress(fields.destination)) {
    warnings.push("Destination is not a valid Stellar address");
  }
  if (fields.amount !== undefined && !/^\d+(\.\d{1,7})?$/.test(fields.amount)) {
    warnings.push("Amount must be a decimal string with at most 7 decimal places");
  }
  if (fields.asset_code !== undefined && fields.asset_code !== "XLM" && !fields.asset_issuer) {
    warnings.push("asset_issuer is required for non-native assets");
  }
  if (fields.asset_issuer !== undefined && !isGAddress(fields.asset_issuer)) {
    warnings.push("asset_issuer is not a valid Stellar address");
  }
  if (fields.memo !== undefined && !isValidMemoText(fields.memo)) {
    warnings.push(memoTextMessage);
  }
  return { fields, warnings };
}

async function handleIdempotentRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  secretKey: string | undefined,
  execute: () => Promise<{ hash: string; successful: boolean }>
) {
  try {
    assertValidRequest(req);
    const idempotencyKey = req.body.idempotencyKey;
    let sourcePublicKey: string | undefined;

    if (idempotencyKey && secretKey) {
      const keypair = StellarSdk.Keypair.fromSecret(secretKey);
      sourcePublicKey = keypair.publicKey();
      const cached = await getCachedResult(sourcePublicKey, idempotencyKey);
      if (cached) {
        res.json({ hash: cached.hash, successful: cached.successful });
        return;
      }
    }

    const result = await execute();

    if (idempotencyKey && sourcePublicKey) {
      await cacheResult(sourcePublicKey, idempotencyKey, result.hash, result.successful);
    }

    res.json({ hash: result.hash, successful: result.successful });
  } catch (err) {
    next(err);
  }
}

export function createWalletRouter(stellar: StellarService): Router {
  const walletRouter = Router();

  walletRouter.use(jwtAuth);

  walletRouter.post(
    "/payment-requests",
    body("destination")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(destinationMessage),
    body("amount").optional().isString().matches(/^\d+(\.\d{1,7})?$/),
    body("asset_code").optional().isString().isLength({ min: 1, max: 12 }),
    body("asset_issuer")
      .optional()
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(destinationMessage),
    body("memo").optional().isString().custom(isValidMemoText).withMessage(memoTextMessage),
    body("memo_type").optional().isIn(["MEMO_TEXT", "MEMO_ID", "MEMO_HASH", "MEMO_RETURN"]),
    body("origin_domain").optional().isString().isLength({ max: 255 }),
    body("signature").optional().isString().isLength({ max: 255 }),
    (req, res, next) => {
      try {
        assertValidRequest(req);
        const { destination, amount, asset_code, asset_issuer, memo, memo_type, origin_domain, signature } = req.body;
        if (asset_code && asset_code !== "XLM" && !asset_issuer) {
          res.status(400).json({
            error: { code: "INVALID_ASSET", message: "asset_issuer is required for non-native assets" },
          });
          return;
        }
        const uri = buildSep7PayUri({
          destination,
          amount,
          asset_code,
          asset_issuer,
          memo,
          memo_type,
          origin_domain,
          signature,
        });
        res.json({ uri });
      } catch (err) {
        next(err);
      }
    }
  );

  walletRouter.post(
    "/payment-requests/parse",
    body("uri").isString().notEmpty(),
    (req, res, next) => {
      try {
        assertValidRequest(req);
        const { fields, warnings } = parseSep7PayUri(req.body.uri);
        res.json({ fields, warnings });
      } catch (err) {
        next(err);
      }
    }
  );

  walletRouter.post(
    "/send",
    body("sourceSecretKey").isLength({ min: 56, max: 56 }),
    body("destinationPublicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(destinationMessage),
    body("amount").isDecimal({ decimal_digits: "0,7" }),
    body("asset").optional().isString(),
    // Stellar's MEMO_TEXT limit is 28 *bytes* once UTF-8 encoded, not 28
    // characters — `isLength({ max: 28 })` (the previous check here) counts
    // characters, so it wrongly accepted e.g. a 20-character memo full of
    // emoji/CJK text that's well over 28 bytes and would be rejected
    // on-chain. See packages/sdk/src/validate/memo.ts (#103).
    body("memo").optional().isString().custom(isValidMemoText).withMessage(memoTextMessage),
    body("idempotencyKey").optional().isString().isLength({ max: 255 }),
    (req, res, next) =>
      handleIdempotentRequest(req, res, next, req.body.sourceSecretKey, () => stellar.sendPayment(req.body))
  );

  walletRouter.post(
    "/fee-bump",
    body("transactionXdr").isString().notEmpty(),
    body("feeSecretKey").isLength({ min: 56, max: 56 }),
    body("fee").optional().isDecimal({ decimal_digits: "0,7" }),
    body("idempotencyKey").optional().isString().isLength({ max: 255 }),
    (req, res, next) =>
      handleIdempotentRequest(req, res, next, req.body.feeSecretKey, () => stellar.feeBumpTransaction(req.body))
  );

  walletRouter.post(
    "/path-payment-strict-send",
    body("sourceSecretKey").isLength({ min: 56, max: 56 }),
    body("destinationPublicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const account = await stellar.server.loadAccount(req.params.publicKey);
        const reserves = computeReserveBreakdown(account);
        const assets = computeAssetSpendable(account);
        res.json({ reserves, assets });
      } catch (err) {
        next(err);
      }
    }
  );

  // Generate a muxed (M-address) receive address for a base account. Exchanges
  // and custodial services use muxed accounts to tag deposits to a sub-account.
  walletRouter.post(
    "/:publicKey/muxed",
    param("publicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    body("id")
      .exists({ checkNull: true })
      .bail()
      .custom(isValidMuxedId)
      .withMessage("id must be a non-negative integer within the uint64 range"),
    (req, res, next) => {
      try {
        assertValidRequest(req);
        const publicKey = req.params.publicKey;
        const id = BigInt(req.body.id);
        const muxed = new StellarSdk.MuxedAccount(
          StellarSdk.Keypair.fromPublicKey(publicKey),
          id
        );
        res.json({
          publicKey,
          id: id.toString(),
          muxedAccount: muxed.accountId(),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // Build an unsigned `setOptions` transaction for multisig management
  // (add/remove signers, master weight, thresholds). Returns the XDR for
  // client-side signing; never accepts a secret key. Rejects changes that
  // would lock the account out.
  walletRouter.post(
    "/set-options/build",
    body("sourcePublicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    body("addSigners")
      .optional()
      .isArray({ max: 20 })
      .withMessage("addSigners must be an array of at most 20 signers"),
    body("addSigners.*.key")
      .if(body("addSigners").exists())
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    body("addSigners.*.weight")
      .if(body("addSigners").exists())
      .custom(isValidWeight)
      .withMessage(`weight must be an integer between 0 and ${MAX_WEIGHT}`),
    body("removeSigners")
      .optional()
      .isArray({ max: 20 })
      .withMessage("removeSigners must be an array of at most 20 signer keys"),
    body("removeSigners.*")
      .if(body("removeSigners").exists())
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    body("masterWeight")
      .optional()
      .custom(isValidWeight)
      .withMessage(`masterWeight must be an integer between 0 and ${MAX_WEIGHT}`),
    body("lowThreshold")
      .optional()
      .custom(isValidWeight)
      .withMessage(`lowThreshold must be an integer between 0 and ${MAX_WEIGHT}`),
    body("mediumThreshold")
      .optional()
      .custom(isValidWeight)
      .withMessage(`mediumThreshold must be an integer between 0 and ${MAX_WEIGHT}`),
    body("highThreshold")
      .optional()
      .custom(isValidWeight)
      .withMessage(`highThreshold must be an integer between 0 and ${MAX_WEIGHT}`),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const input: SetOptionsInput = {
          sourcePublicKey: req.body.sourcePublicKey,
          addSigners: req.body.addSigners,
          removeSigners: req.body.removeSigners,
          masterWeight: req.body.masterWeight,
          lowThreshold: req.body.lowThreshold,
          mediumThreshold: req.body.mediumThreshold,
          highThreshold: req.body.highThreshold,
        };

        const account = await stellar.server.loadAccount(input.sourcePublicKey);
        const simulation = simulateSetOptions(account, input);

        const builder = new StellarSdk.TransactionBuilder(account, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: stellar.networkPassphrase,
        });

        const opts: StellarSdk.OperationOptions.SetOptions = {};
        if (input.masterWeight !== undefined) {
          opts.masterWeight = input.masterWeight;
        }
        if (input.lowThreshold !== undefined) {
          opts.lowThreshold = input.lowThreshold;
        }
        if (input.mediumThreshold !== undefined) {
          opts.mediumThreshold = input.mediumThreshold;
        }
        if (input.highThreshold !== undefined) {
          opts.highThreshold = input.highThreshold;
        }
        if (input.addSigners && input.addSigners.length > 0) {
          opts.signer = {
            ed25519PublicKey: input.addSigners[0].key,
            weight: input.addSigners[0].weight,
          };
        }

        builder.addOperation(StellarSdk.Operation.setOptions(opts));

        // Additional signers beyond the first are added as separate operations.
        for (const signer of (input.addSigners ?? []).slice(1)) {
          builder.addOperation(
            StellarSdk.Operation.setOptions({
              signer: { ed25519PublicKey: signer.key, weight: signer.weight },
            })
          );
        }

        // Removing a signer is expressed by setting its weight to 0.
        for (const key of input.removeSigners ?? []) {
          if (key === input.sourcePublicKey) {
            continue;
          }
          builder.addOperation(
            StellarSdk.Operation.setOptions({
              signer: { ed25519PublicKey: key, weight: 0 },
            })
          );
        }

        builder.setTimeout(180);
        const transaction = builder.build();

        const result: SetOptionsResult = {
          xdr: transaction.toXDR(),
          networkPassphrase: stellar.networkPassphrase,
          warnings: simulation.warnings,
          resultingSigners: simulation.signers,
          resultingThresholds: simulation.thresholds,
        };
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  walletRouter.post(
    "/send",
    body("sourceSecretKey").isLength({ min: 56, max: 56 }),
    body("destinationPublicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(destinationMessage),
    body("amount").isDecimal({ decimal_digits: "0,7" }),
    body("asset").optional().isString(),
    // Stellar's MEMO_TEXT limit is 28 *bytes* once UTF-8 encoded, not 28
    // characters — `isLength({ max: 28 })` (the previous check here) counts
    // characters, so it wrongly accepted e.g. a 20-character memo full of
    // emoji/CJK text that's well over 28 bytes and would be rejected
    // on-chain. See packages/sdk/src/validate/memo.ts (#103).
    body("memo").optional().isString().custom(isValidMemoText).withMessage(memoTextMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const result = await stellar.buildPartialTransaction(req.body);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return walletRouter;
}
