---
name: Bug report
about: Something isn't working
title: ""
labels: bug
assignees: ""
---

<!--
⚠️ BEFORE YOU PASTE YOUR TERMINAL OUTPUT — SCRUB TWO SECRETS:

  1. The URL Mirafold opens contains `?token=…`. That token is what keeps
     other accounts on your machine off your session. Remove it.
  2. If you use the relay (remote access), the boot log prints a `pairing
     code`. Anyone who has it can drive a shell on your machine. Remove it.

Replace either with `[redacted]`. Everything else is safe to share.
-->

**What happened**

<!-- What did you do, and what went wrong? -->

**What you expected**

**Version**

<!-- Output of `mirafold --version` -->

**Environment**

- OS:
- Node version (`node --version`):
- Agent (Claude Agent / Codex / Gemini CLI):

**Logs**

<!--
The terminal where mirafold is running (SCRUB the token and pairing code
per the note above). If the failure is in the browser, the DevTools console
too. Setting `MIRAFOLD_DEBUG=1` before launching adds normalized event traces.
-->

```
[paste redacted logs here]
```
