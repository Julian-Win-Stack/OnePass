"""The Harbor `claude-code` agent with the Onepass eviction proxy in front of it.

This is the proxied arm of the Terminal-Bench 2.0 A/B. It subclasses Harbor's own
``ClaudeCode`` rather than reimplementing it, so the agent under test is the same real CLI,
installed the same way, invoked with the same command line as the control arm. Two hooks are
added:

* ``install()`` — after the stock install, clone this repo at a pinned commit inside the trial
  container and build ``proxy/`` with a pinned Node. Nothing is put on the container's ``PATH``:
  a task's own toolchain must not move between arms.
* ``run()`` — start ``onepass-proxy`` on 127.0.0.1 inside the container, then let the stock
  ``run()`` launch ``claude -p`` exactly as it would otherwise. The base URL is injected through
  ``_resolve_auth_env()``, which is the one place the stock agent decides where the CLI points.

The proxy is per container by construction, which is what the design needs: ``proxy/src/server.ts``
keeps one evicted-id set and one chars-per-token calibration per process, so two sessions must
never share one.

Nothing here changes eviction behaviour. Everything is packaging.
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Where the clone and the private Node live inside the trial container. Deliberately not on
# PATH: the task's own node/npm, if it has any, must be the ones its tests see.
ONEPASS_ROOT = "/opt/onepass"
REPO_DIR = f"{ONEPASS_ROOT}/repo"
NODE_DIR = f"{ONEPASS_ROOT}/node"
NODE_BIN = f"{NODE_DIR}/bin/node"
PROXY_ENTRY = f"{REPO_DIR}/proxy/dist/main.js"

# Pinned so every trial builds the proxy against the same runtime. The proxy needs >= 20.
DEFAULT_NODE_VERSION = "22.22.2"
DEFAULT_REPO_URL = "https://github.com/Julian-Win-Stack/OnePass.git"
DEFAULT_REF = "step2/harbor-tbench"

# 30k is a stress dose, not the shipped default (110k). Terminal-Bench tasks mostly stay under
# 110k, where the proxy is inert and the arms would be identical by construction.
DEFAULT_TRIP_TOKENS = 30_000

# Harbor mounts /logs/agent from the trial directory and downloads everything under it, so
# anything written here comes back with the run.
AGENT_LOGS = "/logs/agent"
PROXY_LOG_DIR = f"{AGENT_LOGS}/onepass"
PROXY_STDOUT = f"{AGENT_LOGS}/onepass-proxy.stdout.log"
BUILD_RECORD = f"{AGENT_LOGS}/onepass-build.txt"

PROXY_READY_TIMEOUT_SEC = 60


def _int_kwarg(value: Any, name: str, default: int) -> int:
    """Coerce a ``--ak name=value`` string (or a real int) to an int."""
    if value is None:
        return default
    try:
        parsed = int(str(value).strip())
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {value!r}") from exc
    if parsed < 0:
        raise ValueError(f"{name} must be non-negative, got {parsed}")
    return parsed


class OnepassClaudeCode(ClaudeCode):
    """``claude-code``, talking to the Anthropic API through a container-local Onepass proxy."""

    @staticmethod
    @override
    def name() -> str:
        # Not a member of Harbor's AgentName enum, which is fine: every enum lookup in the
        # runtime path is guarded by a `name in AgentName.values()` check. The distinct name is
        # what tells the two arms apart in results.json.
        return "onepass-claude-code"

    def __init__(
        self,
        logs_dir: Path,
        *args,
        onepass_repo_url: str | None = None,
        onepass_ref: str | None = None,
        onepass_node_version: str | None = None,
        onepass_port: Any = None,
        onepass_trip_tokens: Any = None,
        onepass_evict_after_turns: Any = None,
        onepass_protect_last_turns: Any = None,
        onepass_min_saved_chars: Any = None,
        **kwargs,
    ):
        # Popped before super(), which forwards unknown kwargs to BaseAgent and would reject them.
        self._repo_url = onepass_repo_url or DEFAULT_REPO_URL
        self._ref = onepass_ref or DEFAULT_REF
        self._node_version = onepass_node_version or DEFAULT_NODE_VERSION
        self._port = _int_kwarg(onepass_port, "onepass_port", 3777)
        self._trip_tokens = _int_kwarg(
            onepass_trip_tokens, "onepass_trip_tokens", DEFAULT_TRIP_TOKENS
        )
        # None means "leave the proxy's own default alone", so the eval only ever states the
        # knobs it actually moved.
        self._evict_after_turns = (
            None
            if onepass_evict_after_turns is None
            else _int_kwarg(onepass_evict_after_turns, "onepass_evict_after_turns", 8)
        )
        self._protect_last_turns = (
            None
            if onepass_protect_last_turns is None
            else _int_kwarg(onepass_protect_last_turns, "onepass_protect_last_turns", 4)
        )
        self._min_saved_chars = (
            None
            if onepass_min_saved_chars is None
            else _int_kwarg(onepass_min_saved_chars, "onepass_min_saved_chars", 50)
        )
        super().__init__(logs_dir, *args, **kwargs)

    @property
    def proxy_base_url(self) -> str:
        return f"http://127.0.0.1:{self._port}"

    @override
    def _resolve_auth_env(self) -> dict[str, str]:
        """The stock auth env, pointed at the container-local proxy.

        Set here rather than through ``--ae`` on purpose. ``--ae ANTHROPIC_BASE_URL=...`` would
        also be visible to ``_resolved_model_name()``, which returns the *prefixed* model name
        ("anthropic/claude-opus-5") whenever a base URL is configured. Adding it after the stock
        resolution keeps ``ANTHROPIC_MODEL`` byte-identical to the control arm's.

        ``_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`` is load-bearing: Claude Code decides the
        context window client-side and caps a natively-1M model at 200k behind a host that is not
        ``api.anthropic.com``. Without it the proxied arm would run a different window from the
        control (docs/findings.md §11).
        """
        env = super()._resolve_auth_env()
        env["ANTHROPIC_BASE_URL"] = self.proxy_base_url
        env["_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"] = "1"
        return env

    def _install_command(self) -> str:
        version = self._node_version
        return "; ".join(
            [
                "set -euo pipefail",
                f"rm -rf {ONEPASS_ROOT}",
                f"mkdir -p {ONEPASS_ROOT}",
                'arch="$(uname -m)"',
                'case "$arch" in '
                "x86_64|amd64) narch=x64 ;; "
                "aarch64|arm64) narch=arm64 ;; "
                '*) echo "onepass: unsupported arch $arch" >&2; exit 1 ;; '
                "esac",
                f'curl -fsSL "https://nodejs.org/dist/v{version}/node-v{version}-linux-$narch.tar.gz"'
                f" | tar -xz -C {ONEPASS_ROOT}",
                f'mv "{ONEPASS_ROOT}/node-v{version}-linux-$narch" {NODE_DIR}',
                f"git clone --quiet {shlex.quote(self._repo_url)} {REPO_DIR}",
                # A commit SHA resolves directly; a branch name only resolves through its
                # remote-tracking ref in a fresh clone.
                f"git -C {REPO_DIR} checkout --quiet --detach {shlex.quote(self._ref)}"
                f" || git -C {REPO_DIR} checkout --quiet --detach origin/{shlex.quote(self._ref)}",
                f"cd {REPO_DIR}/proxy",
                f'PATH="{NODE_DIR}/bin:$PATH" npm ci --no-audit --no-fund --loglevel=error',
                f'PATH="{NODE_DIR}/bin:$PATH" npm run build',
                f"chmod -R a+rX {ONEPASS_ROOT}",
                # One file that says exactly what got built, collected with the run.
                f"mkdir -p {AGENT_LOGS}",
                f"{{ echo \"repo_url={self._repo_url}\";"
                f' echo "ref={self._ref}";'
                f' echo "commit=$(git -C {REPO_DIR} rev-parse HEAD)";'
                f' echo "node=$({NODE_BIN} --version)";'
                f' echo "proxy_version=$({NODE_BIN} {PROXY_ENTRY} --version)";'
                f" }} > {BUILD_RECORD}",
            ]
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # The real Claude Code CLI, installed exactly as the control arm installs it.
        await super().install(environment)
        await self.ensure_system_dependencies(
            # Every spec here is presence-checked, so a container that already has them
            # runs no package manager at all — the proxied arm must not upgrade packages
            # the control arm keeps. (ca_certificates is deliberately absent: it carries
            # always_install=True and would apt-get on every trial.)
            environment,
            ("curl", "bash", "git", "tar"),
        )
        await self.exec_as_root(environment, command=self._install_command())

    def _proxy_env(self) -> dict[str, str]:
        env = {
            "ONEPASS_PORT": str(self._port),
            "ONEPASS_TRIP_TOKENS": str(self._trip_tokens),
        }
        if self._evict_after_turns is not None:
            env["ONEPASS_EVICT_AFTER_TURNS"] = str(self._evict_after_turns)
        if self._protect_last_turns is not None:
            env["ONEPASS_PROTECT_LAST_TURNS"] = str(self._protect_last_turns)
        if self._min_saved_chars is not None:
            env["ONEPASS_MIN_SAVED_CHARS"] = str(self._min_saved_chars)
        return env

    def _start_proxy_command(self) -> str:
        # The proxy writes its JSONL log to $HOME/.onepass and has no env var to redirect it, so
        # that directory is symlinked into the tree Harbor collects. Packaging, not a code change.
        assignments = " ".join(f"{k}={shlex.quote(v)}" for k, v in self._proxy_env().items())
        return "; ".join(
            [
                "set -euo pipefail",
                f"mkdir -p {PROXY_LOG_DIR}",
                'home="${HOME:-/root}"',
                'rm -rf "$home/.onepass"',
                f'ln -s {PROXY_LOG_DIR} "$home/.onepass"',
                # -u ONEPASS_JUDGE_API_KEY: the judge is off for this eval. It is measured at
                # 1.1% of eviction for ~$3 a session (docs/findings.md §17) and would put a
                # second model's spend inside a benchmark number.
                f"setsid env -u ONEPASS_JUDGE_API_KEY -u ONEPASS_DUMP_DIR {assignments}"
                f" {NODE_BIN} {PROXY_ENTRY} > {PROXY_STDOUT} 2>&1 < /dev/null &",
            ]
        )

    def _wait_for_proxy_command(self) -> str:
        return (
            "i=0; "
            f"while [ $i -lt {PROXY_READY_TIMEOUT_SEC} ]; do "
            f"  if grep -q 'eviction proxy listening' {PROXY_STDOUT} 2>/dev/null; then "
            f'    echo \"onepass: proxy up on port {self._port}\"; exit 0; '
            "  fi; "
            "  i=$((i+1)); sleep 1; "
            "done; "
            f'echo "onepass: proxy did not start within {PROXY_READY_TIMEOUT_SEC}s" >&2; '
            f"tail -n 40 {PROXY_STDOUT} >&2 2>/dev/null || true; "
            "exit 1"
        )

    @override
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        # Not decorated with @with_prompt_template: the stock run() carries the decorator, so
        # the instruction is rendered exactly once, on the way through super().
        await self.exec_as_agent(environment, command=self._start_proxy_command())
        await self.exec_as_agent(environment, command=self._wait_for_proxy_command())
        try:
            await super().run(instruction, environment, context)
        finally:
            # Give the proxy's buffered log writer a moment to drain, then stop it, before the
            # container goes away. A failure here must not mask the agent's own result.
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        "sleep 2; "
                        "pkill -TERM -f 'onepass/repo/proxy/dist/main.js' || true; "
                        "true"
                    ),
                )
            except Exception as exc:  # noqa: BLE001 - diagnostics only
                self.logger.debug(f"onepass: could not stop the proxy cleanly: {exc}")
