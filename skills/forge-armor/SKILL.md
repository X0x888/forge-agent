---
name: forge-armor
description: >-
  Security-minded review and change discipline. Use when touching auth, user
  input, secrets, multi-tenant data, parsers, shell, network, or crypto.
---

# Forge Armor

Assume hostile input. Prefer boring, proven controls over clever ones.

## Triggers

- Authn/authz, sessions, tokens, cookies  
- SQL/NoSQL/HTML/shell/path construction from data  
- File uploads, SSRF-prone fetches, webhooks  
- Secret handling, logging, debug endpoints  
- Deserialization, template engines, eval-like APIs  
- Permission modes, sandbox bypasses, CI credentials  

## Checklist (change-scoped)

1. **Authz** — is every sensitive action checked server-side?  
2. **Input** — validate/encode at boundaries; reject bad data early  
3. **Injection** — parameterized queries; no shell string concat; safe paths  
4. **Secrets** — not in repo, logs, client bundles, or skill artifacts  
5. **Session** — expiry, rotation, cookie flags, CSRF where relevant  
6. **Least privilege** — default deny; new endpoints not world-open  
7. **Deps** — new packages justified; pin when the repo pins  
8. **Fail closed** — errors must not grant access  

## Severity labels (align with inspect)

- **bug** — exploitable or clear exposure  
- **risk** — defense-in-depth gap likely to bite  
- **suggestion** — hardening  
- **nit** — style of security comments  

## Out of scope

Do not run offensive exploits against third-party systems.
Do not produce weaponized payloads; describe classes of issues and fixes.

## Output

Findings-first (`forge-inspect` format). For implementations: fix criticals before ship; document residual risk.
