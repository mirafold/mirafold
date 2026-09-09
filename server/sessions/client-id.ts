// The one shape rule for client-minted ids (fs correlation ids, bang ids):
// short and word-safe or the message is dropped whole.
export const CLIENT_ID_RE = /^[\w-]{1,64}$/;

/** A malformed correlation id drops the message whole (nothing to answer) —
 *  the one grammar every client-correlated handler applies. */
export const badClientId = (id: unknown): boolean =>
  typeof id !== "string" || !CLIENT_ID_RE.test(id);
