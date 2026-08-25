// The URL contract: /s/<id> is a session viewport; everything else is
// mission control (the fleet page at /).
const SESSION_PATH = /^\/s\/([\w-]+)/;

export const sessionIdFromPath = (pathname: string): string | null =>
  pathname.match(SESSION_PATH)?.[1] ?? null;

export const sessionPath = (sessionId: string): string => `/s/${sessionId}`;
