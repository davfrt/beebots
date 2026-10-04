import { log } from "./log.js";
import { redactString, safeError } from "./redact.js";

/** POST a plain-text line to ALERT_WEBHOOK_URL (works as-is with ntfy.sh topics). Same text at most once per 10 min. */
export class Alerts {
  private sent = new Map<string, number>();

  constructor(private url: string | undefined) {}

  async send(text: string, now = Date.now()): Promise<boolean> {
    const t = redactString(`[beebots] ${text}`);
    log.warn("alert", { text: t });
    if (!this.url) return false;
    const last = this.sent.get(t);
    if (last && now - last < 10 * 60_000) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(this.url, { method: "POST", body: t, headers: { "content-type": "text/plain" }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.sent.set(t, now);
        return true;
      } catch (err) {
        log.warn("alert webhook failed", { attempt: attempt + 1, err: safeError(err) });
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    return false;
  }
}
