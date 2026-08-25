---
name: Bug report
about: The proxy misbehaved, a session compacted, or something broke
---

**What happened**

**What you expected**

**Environment**
- onepass-proxy version (`npm ls -g onepass-proxy` or `npx onepass-proxy --version`):
- Claude Code CLI version (`claude --version`):
- OS:
- Auth: API key / subscription OAuth

**Report output**

Paste the output of:

```
npx onepass-report ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
```

(No conversation content is included — the report prints counts and sizes only.)
