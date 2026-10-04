# Pre-live evidence

Ticket 14 cannot make a live decision locally: the target host and OKX demo accounts are external evidence. Create a JSON record after each drill, then generate the packet. It is `NO-GO` unless every listed gate passes; skipped, flaky, unresolved, failed, or missing gates cannot be reinterpreted as a pass.

```sh
pnpm launch:evidence evidence.json evidence.md
```

The command exits non-zero for `NO-GO`, redacts command output, and requires digest-pinned engine, web, and backup images. Store the JSON, generated Markdown, command output files, and immutable release manifest together outside the application host.

Start from `docs/launch-evidence.template.json`; it deliberately generates `NO-GO` until an operator records every drill.

```json
{
  "release": "v2026.10.04",
  "manifest": "evidence/release.env",
  "images": {
    "engine": "ghcr.io/imikerussell/beebots-engine@sha256:<64-hex-digest>",
    "web": "ghcr.io/imikerussell/beebots-web@sha256:<64-hex-digest>",
    "backup": "ghcr.io/imikerussell/beebots-backup@sha256:<64-hex-digest>"
  },
  "gates": [{
    "gate": "okx-demo-minimum-open",
    "status": "pass",
    "reference": "evidence/okx-demo.log",
    "command": "pnpm demo:roundtrip XRP",
    "startedAt": "2026-10-04T12:00:00Z",
    "finishedAt": "2026-10-04T12:02:00Z",
    "output": "redacted command output"
  }]
}
```

Required gates are listed in the template. The demo proof is separately recorded for minimum opening, stop placement/verification, amendment, cancellation, reduce-only close, fee/fill retrieval, and final flatness. Live preflight separately records account permissions/IP binding, expected equity, and flatness.

`pnpm demo:roundtrip` proves the demo contract. The target-host drills, `KEYCHECK_ONLY=live pnpm keycheck`, and `pnpm flat:check` are manual by design; their redacted outputs populate their matching gates. Never run a real-money order merely to populate this packet. Passing the packet establishes safety readiness only, not profitability or protection from loss.
