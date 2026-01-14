import type { Checkout, ConfirmCheckout } from '@moneydevkit/api-contract'

import { log, error as logError } from './logging'
import { createMoneyDevKitClient, createMoneyDevKitNode } from './mdk'
import { hasPaymentBeenReceived, markPaymentReceived } from './payment-state'
import { is_preview_environment } from './preview'
import { failure, success } from './types'
import type { Result } from './types'
import { createInvoiceFromLnAddress, getLightningAddress, eurToSats, satsToEur } from './bringin-provider.js'
import { createSession } from './bringin-sessions.js'

/**
 * Convert any string format to camelCase.
 * Supports: snake_case, kebab-case, space separated, PascalCase, camelCase
 * @example toCamelCase('custom_field') => 'customField'
 * @example toCamelCase('custom-field') => 'customField'
 * @example toCamelCase('custom field') => 'customField'
 * @example toCamelCase('Custom Field') => 'customField'
 */
function toCamelCase(str: string): string {
  return str
    // Split on underscores, hyphens, or spaces
    .split(/[-_\s]+/)
    // Also split on camelCase/PascalCase boundaries
    .flatMap(word => word.split(/(?<=[a-z])(?=[A-Z])/))
    // Filter empty strings
    .filter(Boolean)
    // Convert to camelCase
    .map((word, index) => {
      const lower = word.toLowerCase()
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
}

/**
 * Normalize field names to camelCase.
 * Standard fields (email, name) are kept as-is.
 */
function normalizeFieldName(field: string): string {
  const standardFields = ['email', 'name', 'externalId']
  const camel = toCamelCase(field)
  // Keep standard fields exactly as expected
  if (standardFields.includes(camel)) {
    return camel
  }
  return camel
}

export async function getCheckout(checkoutId: string): Promise<Checkout> {
  // createMoneyDevKitClient can throw on invalid config
  const client = createMoneyDevKitClient()
  return await client.checkouts.get({ id: checkoutId })
}

export async function confirmCheckout(confirm: ConfirmCheckout): Promise<Checkout> {
  const client = createMoneyDevKitClient()
  const lnAddress = getLightningAddress()

  // Check if Bringin mode is enabled
  if (lnAddress) {
    log('Using Bringin LNURL-pay for checkout confirmation')
    return await confirmCheckoutBringin(confirm, lnAddress)
  }

  // Fallback to LDK mode
  log('Using LDK for checkout confirmation')
  const node = createMoneyDevKitNode()
  const confirmedCheckout = await client.checkouts.confirm(confirm)

  const invoice = confirmedCheckout.invoiceScid
    ? node.invoices.createWithScid(confirmedCheckout.invoiceScid, confirmedCheckout.invoiceAmountSats)
    : node.invoices.create(confirmedCheckout.invoiceAmountSats)

  const pendingPaymentCheckout = await client.checkouts.registerInvoice({
    paymentHash: invoice.paymentHash,
    invoice: invoice.invoice,
    invoiceExpiresAt: invoice.expiresAt,
    checkoutId: confirmedCheckout.id,
    nodeId: node.id,
    scid: invoice.scid,
  })

  return pendingPaymentCheckout
}

/**
 * Confirm checkout using Bringin LNURL-pay
 */
async function confirmCheckoutBringin(confirm: ConfirmCheckout, lnAddress: string): Promise<Checkout> {
  const client = createMoneyDevKitClient()
  const confirmedCheckout = await client.checkouts.confirm(confirm)

  // Convert sats to EUR using hard-coded rate
  // The confirmed checkout has invoiceAmountSats set
  const satsAmount = confirmedCheckout.invoiceAmountSats || 1000
  const eurAmount = satsToEur(satsAmount)

  // Generate LNURL-pay invoice via Bringin
  const invoiceResult = await createInvoiceFromLnAddress(eurAmount, lnAddress)

  if (invoiceResult.error) {
    throw new Error(`Failed to create Bringin invoice: ${invoiceResult.error.message}`)
  }

  const bringinInvoice = invoiceResult.data
  const expiryDate = bringinInvoice.expiresAt ? new Date(bringinInvoice.expiresAt) : new Date(Date.now() + 15 * 60 * 1000)

  // Register invoice with MDK API
  const pendingPaymentCheckout = await client.checkouts.registerInvoice({
    paymentHash: bringinInvoice.paymentHash || bringinInvoice.bolt11.slice(0, 32),
    invoice: bringinInvoice.bolt11,
    invoiceExpiresAt: expiryDate,
    checkoutId: confirmedCheckout.id,
    nodeId: 'bringin-lnurl', // Use a placeholder node ID for Bringin
    scid: '', // No SCID for LNURL-pay invoices
  })

  // Store session for verify polling
  createSession({
    checkoutId: confirmedCheckout.id,
    lnAddress,
    eurAmount,
    sats: bringinInvoice.sats,
    msats: bringinInvoice.msats,
    bolt11: bringinInvoice.bolt11,
    verifyUrl: bringinInvoice.verifyUrl,
    paymentHash: bringinInvoice.paymentHash,
    expiresAt: expiryDate,
  })

  return pendingPaymentCheckout
}

/**
 * Valid fields that can be required at checkout time.
 * 'email' and 'name' are standard fields, anything else is a custom string field.
 */
export type CustomerField = string

/**
 * Customer data for checkout - flat structure with standard and custom fields.
 */
export type CustomerInput = {
  name?: string
  email?: string
  externalId?: string
} & Record<string, string>

/**
 * Strip empty strings from customer object and normalize keys to camelCase.
 */
function cleanCustomerInput(customer: CustomerInput | undefined): CustomerInput | undefined {
  if (!customer) return undefined
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(customer)) {
    if (typeof value === 'string' && value.trim() !== '') {
      // Normalize key to camelCase
      cleaned[normalizeFieldName(key)] = value
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}

/**
 * Normalize requireCustomerData field names to camelCase.
 */
function normalizeRequireCustomerData(fields: string[] | undefined): string[] | undefined {
  if (!fields) return undefined
  return fields.map(normalizeFieldName)
}

/**
 * Checkout params for creating a checkout.
 */
export interface CreateCheckoutParams {
  title: string
  description: string
  amount: number
  currency?: 'USD' | 'SAT'
  successUrl?: string
  checkoutPath?: string
  metadata?: Record<string, unknown>
  customer?: CustomerInput
  requireCustomerData?: string[]
}

export async function createCheckout(
  params: CreateCheckoutParams
): Promise<Result<{ checkout: Checkout }>> {
  const amount = params.amount ?? 200
  const currency = params.currency ?? 'USD'
  const metadataOverrides = params.metadata ?? {}

  try {
    const client = createMoneyDevKitClient()
    const lnAddress = getLightningAddress()

    // Determine node ID based on mode
    let nodeId: string
    if (lnAddress) {
      log('Creating checkout in Bringin mode')
      nodeId = 'bringin-lnurl'
    } else {
      const node = createMoneyDevKitNode()
      nodeId = node.id
    }

    const checkout = await client.checkouts.create(
      {
        amount,
        currency,
        metadata: {
          title: params.title,
          description: params.description,
          successUrl: params.successUrl,
          ...metadataOverrides,
        },
        // Customer data (nested object) - strip empty strings and normalize keys
        customer: cleanCustomerInput(params.customer),
        // Required customer fields - normalize to camelCase
        requireCustomerData: normalizeRequireCustomerData(params.requireCustomerData),
      },
      nodeId,
    )

    if (checkout.status === 'CONFIRMED') {
      // Use Bringin provider if Lightning Address is configured
      if (lnAddress) {
        const satsAmount = checkout.invoiceAmountSats || 1000
        const eurAmount = satsToEur(satsAmount)
        const invoiceResult = await createInvoiceFromLnAddress(eurAmount, lnAddress)

        if (invoiceResult.error) {
          throw new Error(`Failed to create Bringin invoice: ${invoiceResult.error.message}`)
        }

        const bringinInvoice = invoiceResult.data
        const expiryDate = bringinInvoice.expiresAt ? new Date(bringinInvoice.expiresAt) : new Date(Date.now() + 15 * 60 * 1000)

        const pendingPaymentCheckout = await client.checkouts.registerInvoice({
          paymentHash: bringinInvoice.paymentHash || bringinInvoice.bolt11.slice(0, 32),
          invoice: bringinInvoice.bolt11,
          invoiceExpiresAt: expiryDate,
          checkoutId: checkout.id,
          nodeId: 'bringin-lnurl',
          scid: '', // No SCID for LNURL-pay invoices
        })

        // Store session for verify polling
        createSession({
          checkoutId: checkout.id,
          lnAddress,
          eurAmount,
          sats: bringinInvoice.sats,
          msats: bringinInvoice.msats,
          bolt11: bringinInvoice.bolt11,
          verifyUrl: bringinInvoice.verifyUrl,
          paymentHash: bringinInvoice.paymentHash,
          expiresAt: expiryDate,
        })

        return success({ checkout: pendingPaymentCheckout })
      }

      // Fallback to LDK mode
      const node = createMoneyDevKitNode()
      const invoice = checkout.invoiceScid
        ? node.invoices.createWithScid(checkout.invoiceScid, checkout.invoiceAmountSats)
        : node.invoices.create(checkout.invoiceAmountSats)

      const pendingPaymentCheckout = await client.checkouts.registerInvoice({
        paymentHash: invoice.paymentHash,
        invoice: invoice.invoice,
        invoiceExpiresAt: invoice.expiresAt,
        checkoutId: checkout.id,
        nodeId: node.id,
        scid: invoice.scid,
      })

      return success({ checkout: pendingPaymentCheckout })
    }

    return success({ checkout })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logError('Checkout creation failed:', message)
    return failure({
      code: 'checkout_creation_failed',
      message: `Failed to create checkout: ${message}`,
    })
  }
}

export async function markInvoicePaidPreview(paymentHash: string, amountSats: number) {
  if (!is_preview_environment()) {
    throw new Error('markInvoicePaidPreview can only be used in preview environments.')
  }

  const client = createMoneyDevKitClient()
  const paymentsPayload = {
    payments: [
      {
        paymentHash,
        amountSats,
        sandbox: true,
      },
    ],
  }
  const result = await client.checkouts.paymentReceived(paymentsPayload)

  markPaymentReceived(paymentHash)

  return result
}

export async function paymentHasBeenReceived(paymentHash: string) {
  if (!paymentHash) {
    return false
  }
  log('Checking payment received for', paymentHash)
  return hasPaymentBeenReceived(paymentHash)
}
