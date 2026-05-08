import type { Page } from '@playwright/test';

interface FaucetResponse {
  ok: boolean;
  signature?: string;
  recipient?: string;
  amount?: number;
  error?: string;
  note?: string;
}

/**
 * POST to the dapp's `/api/faucet/mint` endpoint to fund a test wallet
 * with mock USDC. Server-side the route loads the deployer + mint
 * authority keypairs from `keys/` and signs the mint, so no browser
 * wallet auth is required — useful for test setup.
 *
 * Returns the parsed JSON response so callers can assert on the
 * signature and amount. Throws if the request fails or the API returns
 * `ok: false`.
 */
export async function mintFromFaucet(
  page: Page,
  recipient: string,
  amount = 10_000,
): Promise<FaucetResponse> {
  // page.request honours the context's baseURL, so a relative URL works
  // here regardless of whether the test is hitting localhost or a CI
  // ephemeral port.
  const r = await page.request.post('/api/faucet/mint', {
    headers: { 'content-type': 'application/json' },
    data: { recipient, amount },
  });
  const body = (await r.json()) as FaucetResponse;
  if (!r.ok() || !body.ok) {
    throw new Error(
      `[faucet] mint failed: ${body.error ?? `HTTP ${r.status()}`}`,
    );
  }
  return body;
}
