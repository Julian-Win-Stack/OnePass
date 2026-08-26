---
name: Bug report
about: The proxy misbehaved, a session compacted, or something broke
---

**What happened**

**What you expected**

**Environment**
- onepass-proxy version (`git log -1 --oneline` in your clone):
- Claude Code CLI version (`claude --version`):
- OS:
- Auth: API key / subscription OAuth

**Report output**

Paste the output of:

```
npm run report -- ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
```

(No conversation content is included — the report prints counts and sizes only.)
