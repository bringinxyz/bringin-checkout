# Bringin Checkout

This repository hosts Bringin Checkout - a fork of Money Dev Kit that replaces Bitcoin/LDK invoice issuance with **Bringin-issued Lightning Address payments (LNURL-pay)** and confirmation via polling the LNURL verify endpoint.

## What is Bringin Checkout?

Bringin Checkout provides the exact same developer experience, file structure, and example flow as Money Dev Kit, but uses:

- **Lightning Addresses** issued by Bringin (e.g., `store123@bringin.app`)
- **Auto-conversion** of incoming sats to EUR, credited to merchant's Bringin EUR account
- **LNURL-pay** for invoice generation
- **Verify endpoint polling** for payment confirmation (NO webhooks required)

## Key Differences from MDK

| Feature | MDK | Bringin Checkout |
|---------|-----|------------------|
| **Invoice Generation** | LDK node (`node.invoices.create()`) | LNURL-pay via Lightning Address |
| **Payment Confirmation** | Webhook from LDK node | Polling LNURL verify endpoint |
| **Required Config** | `MDK_ACCESS_TOKEN`, `MDK_MNEMONIC` | `BRINGIN_LN_ADDRESS`, `MDK_ACCESS_TOKEN` |
| **Settlement** | Bitcoin (sats) | Auto-convert to EUR via Bringin |
| **BTC/EUR Rate** | Live market rate | Hard-coded: 1 BTC = 100,000 EUR (demo) |

## Quick Start (Next.js)

### 1. Set Environment Variables

```bash
# Required: Your Bringin-issued Lightning Address
BRINGIN_LN_ADDRESS=store123@bringin.app

# Required: MDK API access token (for checkout session management)
MDK_ACCESS_TOKEN=your_mdk_token_here
```

**Note:** No `MDK_MNEMONIC` or LDK node configuration needed!

### 2. Render the Checkout Page

```jsx
// app/checkout/[id]/page.js
"use client";
import { Checkout } from "@moneydevkit/nextjs";
import { use } from "react";

export default function CheckoutPage({ params }) {
  const { id } = use(params);
  return <Checkout id={id} />;
}
```

### 3. Expose the API Endpoint

```js
// app/api/mdk/route.js
export { POST } from "@moneydevkit/nextjs/server/route";
```

### 4. Run Your App

```bash
npm install
npm run dev
```

See [packages/nextjs/README.md](packages/nextjs/README.md) for full setup instructions.

## How It Works

1. **Merchant Setup**: Complete KYB on Bringin and receive a Lightning Address like `store123@bringin.app`
2. **Invoice Generation**: When a customer checks out, Bringin Checkout:
   - Resolves the Lightning Address to an LNURL-pay endpoint
   - Requests a BOLT11 invoice with the calculated sat amount
   - Returns a verify URL for payment status polling
3. **Payment Confirmation**: Server-side polling of the verify URL until status is `paid` or `expired`
4. **Auto-Conversion**: Incoming sats are automatically converted to EUR and credited to merchant's Bringin account
5. **UX**: Customer sees invoice QR code → pays → UI auto-updates to "paid" → redirects to success page

## Demo Mode

When the LNURL verify endpoint is unreachable (e.g., local development), Bringin Checkout automatically falls back to **mock payment mode**:

- Invoices are auto-marked as "paid" 12 seconds after creation
- Enables smooth local testing without external dependencies
- **Remove this fallback in production** when verify URLs are reliable

See [bringin-sessions.ts:98](packages/core/src/bringin-sessions.ts#L98) for the mock logic.

## Packages

- `@moneydevkit/nextjs` – Next.js checkout components (Bringin-compatible)
- `@moneydevkit/core` – Core checkout logic with Bringin provider
- `@moneydevkit/create` – Developer onboarding CLI

## Workspace scripts
Run commands from the repo root using npm workspaces:

```bash
npm install               # install all package deps
npm run build             # build every package
npm run test -- --watch   # pass flags through to workspace scripts
npm run build -w @moneydevkit/nextjs
npm run build -w create
```

To work on an individual package, `cd` into its folder under `packages/` and run the usual commands (e.g., `npm run dev`).

## Releasing

All `@moneydevkit/*` packages share a unified version number and are released together.

### Beta releases (automatic)

Every push to `main` that modifies files in `packages/` triggers the `publish-beta` workflow:
1. All packages are bumped to the next beta version (e.g., `0.4.0-beta.0` → `0.4.0-beta.1`)
2. All packages are published to npm with the `beta` tag

Install the latest beta with:
```bash
npx @moneydevkit/create@beta
npm install @moneydevkit/nextjs@beta
```

### Stable releases

1. Create a GitHub release with a tag matching the version in package.json (e.g., if package.json has `0.4.0-beta.3`, create tag `v0.4.0`)
2. The `publish-release` workflow validates, publishes, and bumps to the next minor version

### Version flow example

```
0.4.0           ← initial version in package.json
    ↓ push to main
0.4.0-beta.0    ← publish-beta.yml
    ↓ push to main
0.4.0-beta.1    ← publish-beta.yml
    ↓ push to main
0.4.0-beta.2    ← publish-beta.yml
    ↓ gh release create v0.4.0
0.4.0 @latest   ← publish-release.yml (publishes stable)
0.5.0           ← publish-release.yml (auto-bumps to next minor)
    ↓ push to main
0.5.0-beta.0    ← publish-beta.yml
...
```

### Error cases

```
package.json: 0.4.0-beta.2
    ↓ gh release create v0.3.0
ERROR: Tag version 0.3.0 does not match package.json version 0.4.0
       (cannot release older version)

package.json: 0.4.0-beta.2
    ↓ gh release create v0.5.0
ERROR: Tag version 0.5.0 does not match package.json version 0.4.0
       (must release 0.4.0 first, then betas will be 0.5.0-beta.X)

package.json: 0.4.0-beta.2
    ↓ gh release create v0.4.0
SUCCESS: Publishes 0.4.0, then bumps to 0.5.0
```
.
