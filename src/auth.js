import { constantTimeEqual } from "./util.js";

export function createAuth(token) {
  return {
    token,
    authorize(req) {
      const header = String(req.headers.authorization ?? "");
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) return false;
      return constantTimeEqual(match[1].trim(), token);
    },
  };
}
