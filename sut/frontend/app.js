/**
 * Trading UI.
 *
 * Deliberately small, and deliberately built the way a real client is: an
 * initial snapshot followed by incremental deltas, rather than re-fetching the
 * whole book on every change.
 *
 * That choice is the reason this file exists at all. Re-fetching would make the
 * frontend trivially consistent with the backend and there would be nothing to
 * test. Applying deltas is what real clients do and it is where real clients
 * drift out of sync, so it is what the end-to-end suite checks.
 *
 * Every quantity stays a string. Parsing a size into a JavaScript number here
 * would undo the string encoding the API went to the trouble of using.
 */

const bids = new Map()
const asks = new Map()
let lastSequence = 0

const el = (id) => document.getElementById(id)
const test = (name) => document.querySelector(`[data-testid="${name}"]`)

function renderSide(map, tbody, descending) {
  const rows = [...map.entries()]
    .map(([price, level]) => ({ price, ...level }))
    .sort((a, b) => (descending ? cmp(b.price, a.price) : cmp(a.price, b.price)))

  tbody.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement('tr')
      tr.dataset.price = row.price
      for (const value of [row.price, row.quantity, String(row.orderCount)]) {
        const td = document.createElement('td')
        td.textContent = value
        tr.append(td)
      }
      return tr
    }),
  )
}

/** Compare decimal integer strings without going through Number. */
function cmp(a, b) {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function render() {
  renderSide(bids, el('bids-body'), true)
  renderSide(asks, el('asks-body'), false)
  test('sequence').textContent = String(lastSequence)
}

function applySnapshot(message) {
  bids.clear()
  asks.clear()
  for (const level of message.bids) bids.set(level.price, level)
  for (const level of message.asks) asks.set(level.price, level)
  lastSequence = message.sequence
  render()
}

function applyDelta(message) {
  for (const change of message.changes) {
    const side = change.side === 'buy' ? bids : asks
    // Zero means the level is gone. Treating it as a level of size zero would
    // leave a phantom row that never clears.
    if (change.quantity === '0') side.delete(change.price)
    else side.set(change.price, { quantity: change.quantity, orderCount: change.orderCount })
  }
  lastSequence = message.sequence
  render()
}

function connect() {
  const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`)
  const status = test('connection')

  socket.addEventListener('open', () => {
    status.textContent = 'live'
    status.dataset.state = 'open'
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.type === 'snapshot') {
      applySnapshot(message)
      return
    }
    // A gap means messages were missed and the local book is not trustworthy.
    // Re-snapshot rather than carry on applying deltas to stale state.
    if (message.sequence !== lastSequence + 1) {
      status.textContent = `gap at ${message.sequence}, resynchronising`
      void resnapshot()
      return
    }
    if (message.type === 'delta') applyDelta(message)
    else lastSequence = message.sequence
  })

  socket.addEventListener('close', () => {
    status.textContent = 'disconnected'
    status.dataset.state = 'closed'
    setTimeout(connect, 500)
  })
}

async function resnapshot() {
  const response = await fetch('/book')
  const book = await response.json()
  applySnapshot({ type: 'snapshot', ...book })
  const status = test('connection')
  status.textContent = 'live'
  status.dataset.state = 'open'
}

async function refreshAccount(accountId) {
  const response = await fetch(`/accounts/${encodeURIComponent(accountId)}`)
  if (!response.ok) return
  const account = await response.json()
  test('balance-base').textContent = account.base
  test('balance-quote').textContent = account.quote
  test('position').textContent = account.position
}

el('order-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = new FormData(event.target)
  const accountId = String(form.get('accountId'))
  const status = test('order-status')
  status.textContent = 'submitting'

  const response = await fetch('/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId,
      side: String(form.get('side')),
      price: String(form.get('price')),
      quantity: String(form.get('quantity')),
    }),
  })
  const body = await response.json()

  status.textContent =
    response.status === 201
      ? `${body.status}: filled ${body.filled}, remaining ${body.remaining}`
      : `rejected: ${body.reason ?? body.message ?? 'unknown'}`
  status.dataset.status = response.status === 201 ? body.status : 'rejected'

  await refreshAccount(accountId)
})

test('account').addEventListener('change', (event) => refreshAccount(event.target.value))

void resnapshot()
void refreshAccount(test('account').value)
connect()
