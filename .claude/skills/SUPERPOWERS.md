# Vendored: obra/superpowers

These fourteen skills are a vendored copy of [obra/superpowers](https://github.com/obra/superpowers)
by Jesse Vincent, MIT licensed. The licence is retained alongside them as
`SUPERPOWERS-LICENSE` and must stay with the files.

| | |
|---|---|
| Upstream | https://github.com/obra/superpowers |
| Plugin version | 6.3.0 |
| Commit vendored | `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` |
| Vendored on | 2026-08-30 |
| Licence | MIT — Copyright (c) 2025 Jesse Vincent |

## Why vendored rather than installed as a plugin

Plugins are installed per-user (`/plugin marketplace add obra/superpowers`) and do not
travel with a repository, so they are absent from Claude Code web and cloud sessions and
from any teammate who has not installed them. Skills committed under `.claude/skills/`
load automatically for every session on this repository — local, web, or cloud — for
everyone. That was the requirement, so vendoring is the mechanism.

## What was changed from upstream

Two deliberate deviations. Both matter when re-syncing.

**1. The plugin namespace was stripped.** Upstream skills refer to each other as
`superpowers:test-driven-development`. Repository skills carry no plugin namespace, so
every reference was rewritten to the bare name (`test-driven-development`). Twenty-six
references across nine files. Without this the cross-references between skills do not
resolve.

**2. The SessionStart hook was not vendored.** Upstream ships a hook that injects the
`using-superpowers` skill into every session as required reading. It is benign — it reads
a file and prints JSON, with no network access and no writes — but it branches on
`CLAUDE_PLUGIN_ROOT`, which only a real plugin install sets. Vendored as repository
skills that variable is unset, so the hook would emit the JSON shape Claude Code does not
consume, and silently do nothing.

`using-superpowers` is still present as an ordinary skill and is still the right place to
start. It is simply discovered on demand rather than forced into every session, which is
also the better default for a repository shared across a team.

## Re-syncing from upstream

```sh
git clone --depth 1 https://github.com/obra/superpowers /tmp/superpowers
rm -rf .claude/skills/*/                     # only the skill directories
cp -r /tmp/superpowers/skills/* .claude/skills/
cp /tmp/superpowers/LICENSE .claude/skills/SUPERPOWERS-LICENSE
grep -rl 'superpowers:' .claude/skills | xargs -r sed -i 's/superpowers:\([a-z-]\)/\1/g'
```

Then update the version and commit in the table above. Review the upstream diff before
committing: these files are instructions that shape how Claude behaves for everyone
working in this repository, so they deserve the same review as code.

## What is now enabled for everyone

| Skill | For |
|---|---|
| `using-superpowers` | How the rest of these work — read this first |
| `brainstorming` | Structured idea generation and refinement |
| `writing-plans` | Turning an intent into an executable plan |
| `executing-plans` | Working through a plan without losing the thread |
| `test-driven-development` | TDD discipline |
| `systematic-debugging` | Debugging by method rather than by guess |
| `verification-before-completion` | Proving work is done before claiming it |
| `requesting-code-review` | Asking for review well |
| `receiving-code-review` | Acting on review well |
| `subagent-driven-development` | Delegating work to subagents |
| `dispatching-parallel-agents` | Running agents concurrently |
| `using-git-worktrees` | Worktree workflows |
| `finishing-a-development-branch` | Landing a branch cleanly |
| `writing-skills` | Authoring new skills |

They load automatically. Nobody needs to install anything.
