/**
 * End-to-end tests over the real browser, real backend and real feed.
 *
 * Scope is narrow on purpose. This layer is slow and it breaks for reasons that
 * have nothing to do with the exchange, so it only covers what cannot be
 * checked anywhere cheaper: that what a human sees in the browser matches what
 * the backend actually holds.
 *
 * There are no tests here for validation rules, order types or fee arithmetic.
 * Those are covered by the unit, property and contract suites, in milliseconds
 * rather than seconds, with better failure messages.
 */
import { expect, test, type Page } from '@playwright/test'

async function placeOrder(
  page: Page,
  order: { account?: string; side: 'buy' | 'sell'; price: string; quantity: string },
): Promise<void> {
  if (order.account !== undefined) {
    await page.getByTestId('account').fill(order.account)
    await page.getByTestId('account').blur()
  }
  await page.getByTestId('side').selectOption(order.side)
  await page.getByTestId('price').fill(order.price)
  await page.getByTestId('quantity').fill(order.quantity)
  await page.getByTestId('submit').click()
}

/** The book as the browser is rendering it. */
async function renderedBook(page: Page, side: 'bids' | 'asks') {
  return page.getByTestId(side).locator('tbody tr').evaluateAll((rows) =>
    rows.map((row) => {
      const cells = row.querySelectorAll('td')
      return {
        price: cells[0]?.textContent ?? '',
        quantity: cells[1]?.textContent ?? '',
        orderCount: Number(cells[2]?.textContent ?? '0'),
      }
    }),
  )
}

/** The book as the backend holds it. */
async function backendBook(page: Page, side: 'bids' | 'asks') {
  const response = await page.request.get('/book')
  const body = (await response.json()) as Record<string, unknown[]>
  return body[side]
}

test.describe('critical trading paths', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'open')
  })

  test('a resting order appears in the book', async ({ page }) => {
    await placeOrder(page, { account: 'maker-1', side: 'sell', price: '104', quantity: '3' })

    await expect(page.getByTestId('order-status')).toContainText('resting')
    await expect(page.getByTestId('asks').locator('tr[data-price="104"]')).toBeVisible()
  })

  test('a crossing order reports a fill and moves the position', async ({ page }) => {
    await placeOrder(page, { account: 'maker-1', side: 'sell', price: '106', quantity: '2' })
    await placeOrder(page, { account: 'taker-1', side: 'buy', price: '106', quantity: '2' })

    await expect(page.getByTestId('order-status')).toContainText('filled 2')
    await expect(page.getByTestId('position')).toHaveText('2')
  })

  test('a rejected order says why, and does not touch the book', async ({ page }) => {
    const before = await backendBook(page, 'bids')

    await placeOrder(page, { account: 'taker-1', side: 'buy', price: '100', quantity: '0' })

    await expect(page.getByTestId('order-status')).toContainText('invalid_quantity')
    expect(await backendBook(page, 'bids')).toEqual(before)
  })

  test('an unfunded account is refused rather than filled', async ({ page }) => {
    await placeOrder(page, { account: 'maker-1', side: 'sell', price: '107', quantity: '1' })
    // broke-1 is seeded with nothing. An exchange that fills this order has a
    // much worse problem than a UI bug.
    await placeOrder(page, { account: 'broke-1', side: 'buy', price: '107', quantity: '1' })

    await expect(page.getByTestId('order-status')).toContainText('rejected')
    await expect(page.getByTestId('position')).toHaveText('0')
  })
})

test.describe('the browser and the backend agree', () => {
  test('after a session of orders, fills and cancels', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'open')

    // Build depth, cross some of it, and empty a level. The frontend never
    // refetches: everything below is the result of applying deltas.
    await placeOrder(page, { account: 'maker-1', side: 'buy', price: '96', quantity: '4' })
    await placeOrder(page, { account: 'maker-1', side: 'buy', price: '95', quantity: '2' })
    await placeOrder(page, { account: 'maker-2', side: 'sell', price: '109', quantity: '5' })
    await placeOrder(page, { account: 'maker-2', side: 'sell', price: '110', quantity: '1' })
    await placeOrder(page, { account: 'taker-1', side: 'sell', price: '96', quantity: '4' })

    await expect(page.getByTestId('bids').locator('tr[data-price="96"]')).toHaveCount(0)

    for (const side of ['bids', 'asks'] as const) {
      expect(await renderedBook(page, side), `${side} disagree`).toEqual(
        await backendBook(page, side),
      )
    }
  })

  test('a page reloaded mid-session shows the true book', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'open')
    await placeOrder(page, { account: 'maker-1', side: 'buy', price: '94', quantity: '7' })

    // Activity from elsewhere, then a reload. This is the recovery path a user
    // actually takes, and it exercises the same resnapshot code that a feed gap
    // triggers.
    //
    // Socket-level reconnect is not tested here. Cutting a live WebSocket from
    // a browser test is unreliable, and the gap-detection and recovery logic is
    // already covered precisely in qe/suites/contract/websocket.test.ts, where
    // sequence numbers can be controlled directly. See docs/NON-GOALS.md.
    await page.request.post('/orders', {
      data: { accountId: 'maker-2', side: 'sell', price: '111', quantity: '6' },
    })
    await page.reload()
    await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'open')

    await expect(page.getByTestId('asks').locator('tr[data-price="111"]')).toBeVisible()
    await expect(page.getByTestId('bids').locator('tr[data-price="94"]')).toBeVisible()
    for (const side of ['bids', 'asks'] as const) {
      expect(await renderedBook(page, side), `${side} disagree after reload`).toEqual(
        await backendBook(page, side),
      )
    }
  })
})
