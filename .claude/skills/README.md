# Bundled Anthropic skills

This directory mirrors the subset of
[anthropics/skills](https://github.com/anthropics/skills) that MARVIN's
personality prompt expects to be available on the user's machine.

Shipping them in-repo means:

- A fresh clone of MARVIN works offline — `scripts/install-skills.sh`
  copies from here into `~/.claude/skills/` without any network call.
- When Claude Code is run inside the MARVIN repo itself (i.e. you
  working on MARVIN), these project-local skills are picked up too.
- The version shipped with MARVIN is a pinned, reviewable checkpoint —
  no silent upstream drift between clones.

To install into your user-level skills dir:

```bash
bash scripts/install-skills.sh
```

The script is idempotent; existing skills in `~/.claude/skills/` are
left alone.

## What's here

| Category | Skills |
|---|---|
| Design | `frontend-design`, `canvas-design`, `theme-factory`, `brand-guidelines` |
| Productivity — docs | `doc-coauthoring`, `docx`, `pdf`, `pptx` |
| Data | `xlsx` |
| Engineering | `claude-api`, `mcp-builder`, `webapp-testing`, `web-artifacts-builder`, `skill-creator` |
| Operations / PM | `internal-comms` |

`graphify` ships from `~/.claude/skills/graphify/` separately (it's a
local authored skill, not from the Anthropic bundle).

`honeycomb:*` ships via the `honeycomb@honeycomb-plugins` Claude Code
plugin — install with `/plugin install honeycomb` inside Claude Code.

## When to refresh

When upstream `anthropics/skills` publishes meaningful updates. To
refresh the bundle:

```bash
# inside the marvin repo
rm -rf /tmp/anthropic-skills-refresh
git clone --depth=1 https://github.com/anthropics/skills.git /tmp/anthropic-skills-refresh
for name in brand-guidelines canvas-design claude-api doc-coauthoring docx \
            frontend-design internal-comms mcp-builder pdf pptx \
            skill-creator theme-factory web-artifacts-builder \
            webapp-testing xlsx; do
  rm -rf ".claude/skills/$name"
  cp -R "/tmp/anthropic-skills-refresh/skills/$name" ".claude/skills/$name"
done
rm -rf /tmp/anthropic-skills-refresh
```

Then commit the diff and run `/graphify . --update`.
