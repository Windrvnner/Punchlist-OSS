/** A dropped request may already have run and been billed. Repeat only reads, deletes, or requests that never went out
 * (#454). A timeout waiting for a reply always counts as unreachable. */
export function retryDroppedRequest(error: unknown, method: string): boolean {
  const failure = error as { name?: string; cause?: { code?: unknown }; code?: unknown } | null | undefined;
  if (failure?.name === 'TimeoutError') return false;
  if (method === 'GET' || method === 'DELETE') return true;
  const code = failure?.cause?.code ?? failure?.code ?? '';
  return /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)$/.test(String(code));
}
