# Client-side signing (web and mobile)

The backend exposes operation-specific builders that return unsigned XDR. The
client must present the operation and its effects, then ask the user's wallet
to sign with the network passphrase returned by the API. Never send a user's
secret key to the backend.

`GET /api/v1/config` is public and returns the active network passphrase,
Horizon/Soroban URLs, contract IDs, feature availability, and API/client
versions. It does not expose server secrets.

## Build and sign a trustline change

`POST /api/v1/wallet/trustline/build` requires authentication and accepts an
account, a non-native asset (`code` and checksum-validated `issuer`), and an
optional decimal-string `limit`. Omit `limit` to use the maximum supported
limit; pass `"0"` to remove an existing zero-balance trustline. Before signing,
show `reserveDelta` and `spendableXlmAfter` to the user. An unsponsored trustline addition locks 0.5 XLM of reserve; removing an
unsponsored trustline releases 0.5 XLM. Removing a sponsored trustline can
have no reserve impact for the account.

```ts
import { signTransaction } from "@stellar/freighter-api";

const response = await fetch("/api/v1/wallet/trustline/build", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    account: sourcePublicKey,
    asset: { code: "USDC", issuer: assetIssuer },
  }),
});

if (!response.ok) {
  throw new Error("Could not build the trustline transaction");
}

const build = await response.json();
// Show build.reserveDelta and build.spendableXlmAfter for user confirmation.
const { signedTxXdr, error } = await signTransaction(build.xdr, {
  networkPassphrase: build.networkPassphrase,
});
if (error) throw new Error(error);
```

The backend also exposes `POST /api/v1/contract/wallet/assets/build` and
`POST /api/v1/contract/wallet/assets/remove/build` for the Soroban wallet asset
registry. Those routes return unsigned XDR; native XLM uses
`{ code: "XLM", issuer: null }`.

## Submission availability

This API version does not expose a generic endpoint for submitting
client-signed XDR. Do not assume that `/wallet/submit` exists, and do not use a
deprecated secret-key route as a substitute. Submission of client-signed XDR
is outside the scope of the trustline, asset-registry, configuration, and
deprecation changes documented here.

## Wallet signing

Use the network passphrase returned by the build response. For Stellar
Wallets Kit, pass both the XDR and the account selected by the user:

```ts
const { signedTxXdr, error } = await StellarWalletsKit.signTransaction(build.xdr, {
  networkPassphrase: build.networkPassphrase,
  address: sourcePublicKey,
});
if (error) throw new Error(error);
```

Never put a secret key in a web/mobile bundle, request body, log, or telemetry.
The legacy `/send`, `/fee-bump`, path-payment, `/partial-transaction`,
`/contract/wallet/spend`, and `/keypair` routes are deprecated and emit
`Deprecation`, `Sunset`, and `Link` headers. See the migration table in the
[backend README](../README.md#legacy-secret-key-route-migration).
