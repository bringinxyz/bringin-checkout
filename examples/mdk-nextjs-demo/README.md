# Bringin Checkout Next.js Demo

A minimal App Router project that demonstrates Bringin Checkout with Lightning Address payments:

- `/` – launch a checkout with `useCheckout()`
- `/checkout/[id]` – render the hosted checkout component
- `/checkout/success` – verify payment with `useCheckoutSuccess()`
- `/api/mdk` – unified checkout API endpoint

## What's Different?

This demo uses **Bringin LNURL-pay** instead of LDK:
- ✅ No Bitcoin node setup required
- ✅ No `MDK_MNEMONIC` needed
- ✅ Only requires `BRINGIN_LN_ADDRESS` (e.g., `store123@bringin.app`)
- ✅ Auto-converts incoming sats to EUR
- ✅ Payment confirmation via LNURL verify polling (no webhooks)

## Run Locally

### 1. Set up environment variables

Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```

Then edit `.env.local`:
```bash
# Required: Your Bringin Lightning Address
BRINGIN_LN_ADDRESS=store123@bringin.app

# Required: MDK API token (for checkout session management)
MDK_ACCESS_TOKEN=your_mdk_token_here
```

### 2. Install and run

```bash
npm install
npm run dev
```

### 3. Test the checkout flow

1. Visit `http://localhost:3000`
2. Click "Start Checkout" to create a new checkout session
3. You'll be redirected to `/checkout/<id>` showing:
   - Invoice QR code
   - BOLT11 invoice string
   - Payment amount in sats
4. In **demo mode**, the payment will auto-complete after 12 seconds
5. The page will auto-redirect to the success page

## Demo Mode (Local Testing)

When running locally, the LNURL verify endpoint may be unreachable. Bringin Checkout automatically enables **mock payment mode**:

- Payments are auto-marked as "paid" 12 seconds after invoice creation
- No external Lightning wallet needed for local testing
- Perfect for development and UI testing

**In production**, remove the mock fallback in [bringin-sessions.ts](../../packages/core/src/bringin-sessions.ts#L98).

## Deploy with Vercel CLI

```bash
npx vercel pull --yes --environment=preview --cwd=examples/mdk-nextjs-demo
npx vercel build --cwd=examples/mdk-nextjs-demo
npx vercel deploy --prebuilt --cwd=examples/mdk-nextjs-demo
```

Make sure your Vercel project has these environment variables configured:
- `BRINGIN_LN_ADDRESS` – Your Bringin Lightning Address
- `MDK_ACCESS_TOKEN` – Your MDK API token

## Hard-Coded Exchange Rate

This demo uses a **hard-coded rate** for simplicity:
- **1 BTC = 100,000 EUR**
- Conversion: `sats = (eur / 100,000) * 100,000,000`

See [bringin-provider.ts:17](../../packages/core/src/bringin-provider.ts#L17) to change the rate.
