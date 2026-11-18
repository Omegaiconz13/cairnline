# pstack model configuration (project-local). One line per role.
# Single-model setup: every role runs on the model the parent chat is already running,
# instead of pinning a different model per task. In Hermes this means delegation.model
# and delegation.provider stay empty, so delegates inherit the parent model and nothing
# else needs to be written outside this project.
# `inherit-parent` / `auto`: run the subagent with no `model` override.
# defaults: 3
# budget: inherit (the parent chat's reasoning effort; delegation.reasoning_effort is unset)
feature, refactoring: inherit-parent
bug-fix: inherit-parent
perf-issue: inherit-parent
hillclimb: inherit-parent
judgment and prose: inherit-parent
arena runners: inherit-parent
arena cross-judge pool: inherit-parent
swarm workers: inherit-parent
interrogate reviewers: inherit-parent
