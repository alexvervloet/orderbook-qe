/**
 * Wire encoding for the API.
 *
 * Every integer that crosses the network is a decimal string, never a JSON
 * number. A quantity of 9007199254740993 is not representable as a JavaScript
 * number, and `JSON.parse` will hand back 9007199254740992 without complaint.
 * On an exchange that is a silently wrong fill size.
 *
 * The rule is enforced in one place so it cannot be forgotten per route, and
 * asserted by a contract test that round-trips values above 2^53.
 */
import { z } from 'zod'

/** A non-negative integer as a decimal string, parsed to bigint. */
export const WireInt = z
  .string()
  .regex(/^-?\d+$/, 'must be a decimal integer string')
  .transform((s) => BigInt(s))

export const WireIntOut = z.bigint().transform((v) => v.toString())

export function encodeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(encodeBigInts)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, encodeBigInts(v)]),
    )
  }
  return value
}

// --------------------------------------------------------------- requests

export const SideSchema = z.enum(['buy', 'sell'])
export const OrderTypeSchema = z.enum(['limit', 'market', 'stop_market', 'stop_limit'])
export const TifSchema = z.enum(['GTC', 'IOC', 'FOK'])
export const StpSchema = z.enum(['none', 'cancel_taker', 'cancel_maker', 'cancel_both'])

export const SubmitOrderRequest = z.object({
  accountId: z.string().min(1),
  side: SideSchema,
  type: OrderTypeSchema.default('limit'),
  tif: TifSchema.default('GTC'),
  price: WireInt.nullable().default(null),
  quantity: WireInt,
  displayQuantity: WireInt.nullable().default(null),
  postOnly: z.boolean().default(false),
  reduceOnly: z.boolean().default(false),
  triggerPrice: WireInt.nullable().default(null),
  stpMode: StpSchema.default('none'),
  clientOrderId: z.string().min(1).max(64).optional(),
})
export type SubmitOrderRequest = z.input<typeof SubmitOrderRequest>

// -------------------------------------------------------------- responses

export const TradeResponse = z.object({
  id: z.string(),
  takerOrderId: z.string(),
  makerOrderId: z.string(),
  takerSide: SideSchema,
  price: z.string(),
  quantity: z.string(),
})

export const SubmitOrderResponse = z.object({
  orderId: z.string(),
  status: z.enum([
    'filled',
    'resting',
    'cancelled',
    'rejected',
    'pending_trigger',
  ]),
  reason: z.string().nullable(),
  filled: z.string(),
  remaining: z.string(),
  trades: z.array(TradeResponse),
  cancelledOrderIds: z.array(z.string()),
})

export const BookLevelResponse = z.object({
  price: z.string(),
  quantity: z.string(),
  orderCount: z.number().int().nonnegative(),
})

export const BookResponse = z.object({
  sequence: z.number().int().nonnegative(),
  bids: z.array(BookLevelResponse),
  asks: z.array(BookLevelResponse),
})

export const CancelResponse = z.object({
  orderId: z.string(),
  cancelled: z.boolean(),
  remainingAtCancel: z.string(),
})

export const AccountResponse = z.object({
  accountId: z.string(),
  base: z.string(),
  quote: z.string(),
  position: z.string(),
})

export const ErrorResponse = z.object({
  error: z.string(),
  message: z.string(),
})

// -------------------------------------------------- websocket market data

export const BookDeltaSchema = z.object({
  side: SideSchema,
  price: z.string(),
  /** Absolute quantity at the level after the change. "0" removes the level. */
  quantity: z.string(),
  orderCount: z.number().int().nonnegative(),
})

export const MarketDataMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    sequence: z.number().int().nonnegative(),
    bids: z.array(BookLevelResponse),
    asks: z.array(BookLevelResponse),
  }),
  z.object({
    type: z.literal('delta'),
    sequence: z.number().int().nonnegative(),
    changes: z.array(BookDeltaSchema),
  }),
  z.object({
    type: z.literal('trade'),
    sequence: z.number().int().nonnegative(),
    price: z.string(),
    quantity: z.string(),
    takerSide: SideSchema,
  }),
])
export type MarketDataMessage = z.infer<typeof MarketDataMessage>

// ------------------------------------------------------------- json-rpc

export const JsonRpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string(),
  params: z.unknown().optional(),
})

export const JsonRpcResponse = z.union([
  z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    result: z.unknown(),
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    error: z.object({ code: z.number(), message: z.string() }),
  }),
])

/** JSON-RPC 2.0 reserved codes, plus the application range. */
export const RpcErrors = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  rejected: -32000,
} as const
