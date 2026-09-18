# Agent Factory Extension Project

- This checkout owns the VS Code extension, its UI, adapters, tests and VSIX.
- Before choosing an edit target, read the three-domain boundary in the [extension project rules](docs/skills/rule-extension-development/SKILL.md). Distributed Skills serve product users; plugin and extension project Skills serve their respective developers.
- Read [architecture](docs/skills/info-extension-architecture/SKILL.md) and the relevant design under `docs/skills/`.
- Do not apply the plugin repository’s Python tests, cachebuster or publication procedure to this checkout.
- Coordinate the matching plugin release using its version and publication evidence.
- Keep unrelated changes intact. Shared release coordination grants no extra publication authority.
