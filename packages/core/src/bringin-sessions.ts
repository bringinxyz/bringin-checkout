/**
 * Bringin Checkout Session Store
 *
 * In-memory storage for checkout sessions with verify URLs and payment status.
 * Used for tracking LNURL-pay invoice verification without webhooks.
 */

export interface BringinCheckoutSession {
  checkoutId: string;
  lnAddress: string;
  eurAmount: number;
  sats: number;
  msats: number;
  bolt11: string;
  verifyUrl: string;
  paymentHash?: string;
  createdAt: Date;
  expiresAt: Date;
  status: 'pending' | 'paid' | 'expired';
  paidAt?: Date;
  lastCheckedAt?: Date;
}

// In-memory store (Map: checkoutId -> session)
const sessions = new Map<string, BringinCheckoutSession>();

// Mock payment tracking (for local demo when verify URL is unreachable)
const mockPaidTimestamps = new Map<string, Date>();

/**
 * Create new checkout session
 */
export function createSession(session: Omit<BringinCheckoutSession, 'status' | 'createdAt'>): void {
  sessions.set(session.checkoutId, {
    ...session,
    status: 'pending',
    createdAt: new Date(),
  });
}

/**
 * Get checkout session by ID
 */
export function getSession(checkoutId: string): BringinCheckoutSession | undefined {
  return sessions.get(checkoutId);
}

/**
 * Update checkout session status
 */
export function updateSessionStatus(
  checkoutId: string,
  status: 'pending' | 'paid' | 'expired',
  paidAt?: Date
): void {
  const session = sessions.get(checkoutId);
  if (session) {
    session.status = status;
    session.lastCheckedAt = new Date();
    if (paidAt) {
      session.paidAt = paidAt;
    }
  }
}

/**
 * Delete checkout session
 */
export function deleteSession(checkoutId: string): void {
  sessions.delete(checkoutId);
  mockPaidTimestamps.delete(checkoutId);
}

/**
 * Clear all sessions (useful for testing)
 */
export function clearAllSessions(): void {
  sessions.clear();
  mockPaidTimestamps.clear();
}

/**
 * Get all sessions (for debugging)
 */
export function getAllSessions(): BringinCheckoutSession[] {
  return Array.from(sessions.values());
}

/**
 * Check if session has expired
 */
export function isSessionExpired(session: BringinCheckoutSession): boolean {
  return new Date() > session.expiresAt;
}

/**
 * Mock payment mode: Mark invoice as paid after delay (for local demo)
 *
 * This simulates the verify endpoint returning "paid" status when the actual
 * Bringin verify URL is unreachable during local development.
 *
 * IMPORTANT: Remove this in production or when verify URLs are reliable.
 */
export function shouldMockPaid(checkoutId: string, createdAt: Date): boolean {
  // If we've already marked it as mock paid, return true
  if (mockPaidTimestamps.has(checkoutId)) {
    return true;
  }

  // Auto-mark as paid 12 seconds after creation
  const elapsed = Date.now() - createdAt.getTime();
  if (elapsed > 12_000) {
    mockPaidTimestamps.set(checkoutId, new Date());
    return true;
  }

  return false;
}

/**
 * Clean up expired sessions periodically
 */
export function cleanupExpiredSessions(): number {
  let cleaned = 0;
  const now = new Date();

  for (const [checkoutId, session] of sessions.entries()) {
    // Remove sessions that expired more than 1 hour ago
    if (session.status === 'expired' && (now.getTime() - session.expiresAt.getTime()) > 3600_000) {
      sessions.delete(checkoutId);
      mockPaidTimestamps.delete(checkoutId);
      cleaned++;
    }
  }

  return cleaned;
}

// Auto-cleanup every 10 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    cleanupExpiredSessions();
  }, 10 * 60 * 1000);
}
