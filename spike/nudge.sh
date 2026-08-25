#!/bin/sh
# UserPromptSubmit hook. stdout is injected into the agent's context.
# Deliberately states a fact rather than issuing an order — the spike is testing
# whether the agent chooses to recall, not whether it obeys when commanded.
cat <<'MSG'
<onepass>
Parts of this session's earlier context may have been removed by compaction or tool-result clearing.
The complete original history is on disk and searchable: recall_search(query) then recall_get(ref).
</onepass>
MSG
