/**
 * Bringin Lightning Address Payment Provider
 *
 * Handles LNURL-pay invoice generation and payment verification for Bringin-issued
 * Lightning Addresses that auto-convert sats to EUR.
 *
 * Required Environment Variable:
 *   BRINGIN_LN_ADDRESS - Merchant's Bringin Lightning Address (e.g., store123@bringin.app)
 *
 * Flow:
 *   1. Convert EUR amount to sats/msats using hard-coded rate (100,000 EUR/BTC)
 *   2. Resolve Lightning Address to LNURL-pay endpoint
 *   3. Request invoice via LNURL-pay callback
 *   4. Poll verify endpoint for payment status
 */

import { success, failure, type Result } from './types.js';

// Hard-coded BTC rate: 1 BTC = 100,000 EUR
const BTC_EUR_RATE = 100_000;

/**
 * Invoice response from LNURL-pay callback
 */
export interface BringinInvoice {
  bolt11: string;
  verifyUrl: string;
  expiresAt?: string;
  sats: number;
  msats: number;
  paymentHash?: string;
}

/**
 * Payment status from verify endpoint
 */
export interface BringinPaymentStatus {
  status: 'pending' | 'paid' | 'expired';
  paidAt?: string;
  eurCredited?: boolean;
}

/**
 * LNURL-pay params from .well-known endpoint
 */
interface LnUrlPayParams {
  callback: string;
  minSendable: number; // millisatoshis
  maxSendable: number; // millisatoshis
  metadata: string;
  tag: 'payRequest';
  commentAllowed?: number;
}

/**
 * LNURL-pay callback response
 */
interface LnUrlPayCallback {
  pr: string; // BOLT11 invoice
  routes?: any[];
  successAction?: any;
  verify?: string;
  k1?: string;
  paymentHash?: string;
  checkingId?: string;
}

/**
 * Convert EUR to satoshis using hard-coded rate
 */
export function eurToSats(eurAmount: number): number {
  // 1 BTC = 100,000 EUR
  // sats = (eur / 100,000) * 100,000,000
  return Math.round((eurAmount / BTC_EUR_RATE) * 100_000_000);
}

/**
 * Convert satoshis to millisatoshis
 */
export function satsToMsats(sats: number): number {
  return sats * 1000;
}

/**
 * Resolve Lightning Address to LNURL-pay endpoint
 *
 * Converts user@domain into https://domain/.well-known/lnurlp/user
 */
function resolveLightningAddress(lnAddress: string): Result<string> {
  const parts = lnAddress.split('@');
  if (parts.length !== 2) {
    return failure({
      code: 'invalid_ln_address',
      message: `Invalid Lightning Address format: ${lnAddress}`,
    });
  }

  const [user, domain] = parts;
  if (!user || !domain) {
    return failure({
      code: 'invalid_ln_address',
      message: `Lightning Address must be in format user@domain`,
    });
  }

  return success(`https://${domain}/.well-known/lnurlp/${user}`);
}

/**
 * Fetch LNURL-pay parameters from Lightning Address
 */
async function fetchLnUrlPayParams(lnAddress: string): Promise<Result<LnUrlPayParams>> {
  const urlResult = resolveLightningAddress(lnAddress);
  if (urlResult.error) {
    return urlResult;
  }

  try {
    const response = await fetch(urlResult.data, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return failure({
        code: 'lnurl_fetch_failed',
        message: `Failed to fetch LNURL params: ${response.status} ${response.statusText}`,
      });
    }

    const data = await response.json();

    // Validate response
    if (data.tag !== 'payRequest') {
      return failure({
        code: 'invalid_lnurl_response',
        message: `Expected tag "payRequest", got: ${data.tag}`,
      });
    }

    if (!data.callback || !data.metadata) {
      return failure({
        code: 'invalid_lnurl_response',
        message: 'Missing required fields: callback or metadata',
      });
    }

    if (typeof data.minSendable !== 'number' || typeof data.maxSendable !== 'number') {
      return failure({
        code: 'invalid_lnurl_response',
        message: 'minSendable and maxSendable must be numbers',
      });
    }

    return success(data as LnUrlPayParams);
  } catch (error) {
    return failure({
      code: 'lnurl_fetch_error',
      message: `Network error fetching LNURL params: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Request invoice from LNURL-pay callback
 */
async function requestInvoice(
  callback: string,
  msats: number,
  minSendable: number,
  maxSendable: number
): Promise<Result<LnUrlPayCallback>> {
  // Validate amount is within range
  if (msats < minSendable || msats > maxSendable) {
    return failure({
      code: 'amount_out_of_range',
      message: `Amount ${msats} msats is outside allowed range: ${minSendable}-${maxSendable} msats`,
    });
  }

  try {
    // Build callback URL with amount parameter
    const callbackUrl = new URL(callback);
    callbackUrl.searchParams.set('amount', msats.toString());

    const response = await fetch(callbackUrl.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return failure({
        code: 'invoice_request_failed',
        message: `Failed to request invoice: ${response.status} ${response.statusText}`,
      });
    }

    const data = await response.json();

    // Check for error in response
    if (data.status === 'ERROR' || data.reason) {
      return failure({
        code: 'invoice_request_error',
        message: data.reason || 'Unknown error from LNURL callback',
      });
    }

    // Validate required fields
    if (!data.pr) {
      return failure({
        code: 'invalid_invoice_response',
        message: 'Missing required field: pr (BOLT11 invoice)',
      });
    }

    return success(data as LnUrlPayCallback);
  } catch (error) {
    return failure({
      code: 'invoice_request_error',
      message: `Network error requesting invoice: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Extract or construct verify URL from callback response
 */
function getVerifyUrl(callbackResponse: LnUrlPayCallback, callback: string, lnAddress: string): string {
  // Priority 1: Explicit verify URL in response
  if (callbackResponse.verify) {
    return callbackResponse.verify;
  }

  // Priority 2: k1 token - construct verify URL from callback base
  if (callbackResponse.k1) {
    const callbackUrl = new URL(callback);
    // Replace /callback with /verify or append /verify
    const verifyPath = callbackUrl.pathname.replace('/callback', '/verify');
    callbackUrl.pathname = verifyPath;
    callbackUrl.searchParams.set('k1', callbackResponse.k1);
    return callbackUrl.toString();
  }

  // Priority 3: paymentHash - construct Bringin-specific verify URL
  if (callbackResponse.paymentHash) {
    const domain = lnAddress.split('@')[1];
    const handle = lnAddress.split('@')[0];
    return `https://api.${domain}/lnurlp/${handle}/verify?paymentHash=${callbackResponse.paymentHash}`;
  }

  // Priority 4: checkingId - similar to paymentHash
  if (callbackResponse.checkingId) {
    const domain = lnAddress.split('@')[1];
    const handle = lnAddress.split('@')[0];
    return `https://api.${domain}/lnurlp/${handle}/verify?checkingId=${callbackResponse.checkingId}`;
  }

  // Fallback: derive from callback URL (replace /callback with /verify)
  const callbackUrl = new URL(callback);
  callbackUrl.pathname = callbackUrl.pathname.replace('/callback', '/verify');
  return callbackUrl.toString();
}

/**
 * Create invoice from Lightning Address (main entry point)
 *
 * @param eurAmount - Amount in EUR
 * @param lnAddress - Bringin Lightning Address (e.g., store123@bringin.app)
 * @returns Invoice with BOLT11 and verify URL
 */
export async function createInvoiceFromLnAddress(
  eurAmount: number,
  lnAddress: string
): Promise<Result<BringinInvoice>> {
  // Validate input
  if (!lnAddress) {
    return failure({
      code: 'missing_ln_address',
      message: 'BRINGIN_LN_ADDRESS environment variable is required',
    });
  }

  if (eurAmount <= 0) {
    return failure({
      code: 'invalid_amount',
      message: 'EUR amount must be greater than 0',
    });
  }

  // Convert EUR to sats/msats
  const sats = eurToSats(eurAmount);
  const msats = satsToMsats(sats);

  // Step 1: Fetch LNURL-pay params
  const paramsResult = await fetchLnUrlPayParams(lnAddress);
  if (paramsResult.error) {
    return paramsResult;
  }

  const params = paramsResult.data;

  // Step 2: Request invoice from callback
  const invoiceResult = await requestInvoice(
    params.callback,
    msats,
    params.minSendable,
    params.maxSendable
  );
  if (invoiceResult.error) {
    return invoiceResult;
  }

  const callbackResponse = invoiceResult.data;

  // Step 3: Extract or construct verify URL
  const verifyUrl = getVerifyUrl(callbackResponse, params.callback, lnAddress);

  // Step 4: Parse expiry from BOLT11 (optional - could decode invoice)
  // For now, use default 15 minutes
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  return success({
    bolt11: callbackResponse.pr,
    verifyUrl,
    expiresAt,
    sats,
    msats,
    paymentHash: callbackResponse.paymentHash,
  });
}

/**
 * Check invoice payment status via verify endpoint
 *
 * @param verifyUrl - URL to poll for payment status
 * @returns Payment status
 */
export async function checkInvoiceStatus(verifyUrl: string): Promise<Result<BringinPaymentStatus>> {
  try {
    const response = await fetch(verifyUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      // If verify endpoint is unreachable, return pending for local mock fallback
      if (response.status === 404 || response.status === 503) {
        return success({ status: 'pending' });
      }
      return failure({
        code: 'verify_request_failed',
        message: `Failed to check status: ${response.status} ${response.statusText}`,
      });
    }

    const data = await response.json();

    // Parse status from response
    // Support multiple response formats
    let status: 'pending' | 'paid' | 'expired' = 'pending';

    if (data.settled === true || data.paid === true || data.status === 'paid') {
      status = 'paid';
    } else if (data.expired === true || data.status === 'expired') {
      status = 'expired';
    } else if (data.pending === true || data.status === 'pending') {
      status = 'pending';
    }

    return success({
      status,
      paidAt: data.settledAt || data.paidAt,
      eurCredited: data.eurCredited,
    });
  } catch (error) {
    // Network error - return pending for local mock fallback
    return success({ status: 'pending' });
  }
}

/**
 * Get configured Lightning Address from environment
 */
export function getLightningAddress(): string | undefined {
  return process.env.BRINGIN_LN_ADDRESS;
}

/**
 * Convert sats to EUR using hard-coded rate
 */
export function satsToEur(sats: number): number {
  // 1 BTC = 100,000 EUR
  // eur = (sats / 100,000,000) * 100,000
  return (sats / 100_000_000) * BTC_EUR_RATE;
}
