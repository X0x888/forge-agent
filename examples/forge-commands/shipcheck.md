---
description: Production readiness smoke (typecheck + tests + doctor)
---
Production readiness check for this Forge change$ARGUMENTS.

1. npm run typecheck
2. npm test (or the cheapest suite that proves the change)
3. npm run build if types/exports changed
4. Summarize: ✅/❌ per step, remaining risks, whether ready for experts in production

Do not commit unless asked.
