import { createHash } from 'node:crypto';

/**
 * Compute a stable 32-bit integer seed from the model and messages.
 * Same model + same messages → same seed, every time, on every machine.
 */
export function computeSeed(model: string, messages: unknown[]): number {
  const payload = JSON.stringify({ model, messages });
  const hex = createHash('sha256').update(payload).digest('hex');
  return parseInt(hex.slice(0, 8), 16); // first 32 bits as unsigned int
}

/**
 * If the request opts into deterministic mode, patch the body with
 * temperature=0, top_p=1, and a content-derived seed.
 *
 * Opt-in via:
 *   - Header:  X-Deterministic: true
 *   - Body:    { ..., "deterministic": true }  (field is stripped before forwarding)
 *
 * Returns the (possibly patched) body and the seed that was applied (null if not deterministic).
 */
export function applyDeterministicParams(
  body: any,
  headerValue: string | undefined,
): { body: any; seed: number | null } {
  const requested = headerValue === 'true' || body.deterministic === true;
  if (!requested) return { body, seed: null };

  const seed = computeSeed(body.model ?? 'default', body.messages ?? []);

  const patched = { ...body, temperature: 0, top_p: 1, seed };
  delete patched.deterministic; // don't forward our custom field

  return { body: patched, seed };
}
