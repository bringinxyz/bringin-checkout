/**
 * Bringin Payment Verification Handler
 *
 * Polls the LNURL verify endpoint to check payment status.
 * Replaces webhook-based payment confirmation with active polling.
 */

import { checkInvoiceStatus } from '../bringin-provider.js';
import {
  getSession,
  updateSessionStatus,
  isSessionExpired,
  shouldMockPaid,
} from '../bringin-sessions.js';
import { createMoneyDevKitClient } from '../mdk.js';
import { failure, success, type Result } from '../types.js';

/**
 * Response from verify status check
 */
export interface VerifyStatusResponse {
  status: 'pending' | 'paid' | 'expired';
  paidAt?: string;
  amountSatsReceived?: number;
}

/**
 * Check payment status for a checkout session
 *
 * This handler:
 * 1. Looks up the checkout session by ID
 * 2. Checks if session has expired
 * 3. Polls the verify URL for payment status
 * 4. Falls back to mock payment mode if verify URL is unreachable (local demo)
 * 5. Notifies MDK API when payment is confirmed
 * 6. Updates local session state
 */
export async function handleVerifyStatus(
  checkoutId: string
): Promise<Result<VerifyStatusResponse>> {
  // Get session from store
  const session = getSession(checkoutId);
  if (!session) {
    return failure({
      code: 'session_not_found',
      message: `No session found for checkout: ${checkoutId}`,
    });
  }

  // If already paid, return cached status
  if (session.status === 'paid') {
    return success({
      status: 'paid',
      paidAt: session.paidAt?.toISOString(),
      amountSatsReceived: session.sats,
    });
  }

  // Check if expired
  if (isSessionExpired(session)) {
    updateSessionStatus(checkoutId, 'expired');
    return success({
      status: 'expired',
    });
  }

  // Poll verify URL
  const statusResult = await checkInvoiceStatus(session.verifyUrl);

  // If verify URL is unreachable or returns pending, check mock mode
  if (statusResult.error || statusResult.data.status === 'pending') {
    // LOCAL DEMO MODE: Auto-mark as paid after 12 seconds
    // REMOVE THIS IN PRODUCTION when verify URLs are reliable
    if (shouldMockPaid(checkoutId, session.createdAt)) {
      console.log(`[Bringin Demo] Mock payment confirmed for checkout: ${checkoutId}`);

      // Mark as paid locally
      const paidAt = new Date();
      updateSessionStatus(checkoutId, 'paid', paidAt);

      // Notify MDK API
      try {
        const client = createMoneyDevKitClient();
        await client.checkouts.paymentReceived({
          payments: [
            {
              paymentHash: session.paymentHash || session.bolt11.slice(0, 32),
              amountSats: session.sats,
              sandbox: true,
            },
          ],
        });
      } catch (error) {
        console.error('[Bringin] Failed to notify API of mock payment:', error);
      }

      return success({
        status: 'paid',
        paidAt: paidAt.toISOString(),
        amountSatsReceived: session.sats,
      });
    }

    // Still pending
    return success({
      status: 'pending',
    });
  }

  // Handle verify response
  const { status, paidAt: paidAtStr } = statusResult.data;

  if (status === 'paid') {
    // Mark as paid locally
    const paidAt = paidAtStr ? new Date(paidAtStr) : new Date();
    updateSessionStatus(checkoutId, 'paid', paidAt);

    // Notify MDK API
    try {
      const client = createMoneyDevKitClient();
      await client.checkouts.paymentReceived({
        payments: [
          {
            paymentHash: session.paymentHash || session.bolt11.slice(0, 32),
            amountSats: session.sats,
            sandbox: false,
          },
        ],
      });
    } catch (error) {
      console.error('[Bringin] Failed to notify API of payment:', error);
    }

    return success({
      status: 'paid',
      paidAt: paidAt.toISOString(),
      amountSatsReceived: session.sats,
    });
  }

  if (status === 'expired') {
    updateSessionStatus(checkoutId, 'expired');
    return success({
      status: 'expired',
    });
  }

  // Still pending
  return success({
    status: 'pending',
  });
}
