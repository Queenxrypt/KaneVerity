# AcmeDesk demo scenario: answer key

> **For humans only.** This file is for the project team and the demo video.
> It is **never** served by the docs server, read by the KaneVerity orchestrator,
> included in a Kane objective, or given to Claude during a correction.
> Verification results must come only from Kane's execution evidence.

AcmeDesk Docs is served at `http://127.0.0.1:5175/`. AcmeDesk runs at `http://127.0.0.1:5174/` and starts from the same seed data on every fresh page load (3 projects, 3 team members, 1 API key).

## Tutorials and expected KaneVerity results

| Tutorial | Docs file | Documented path | Matches app? | Expected first result |
|---|---|---|---|---|
| Create a project | `apps/docs/content/tutorials/create-a-project.md` | Dashboard → Projects → New project → Create project | Yes | PASSED |
| Invite a team member | `apps/docs/content/tutorials/invite-a-team-member.md` | Dashboard → Team Members → Invite member → Send invite | Yes | PASSED |
| Generate an API key | `apps/docs/content/tutorials/generate-an-api-key.md` | Dashboard → **Settings → API → Create API Key** | **No (outdated on purpose)** | FAILED at step 1 ("Settings" does not exist) |
| Configure workspace settings | `apps/docs/content/tutorials/configure-workspace-settings.md` | Dashboard → **Settings → General** → Workspace name → Save changes | **No (outdated on purpose)** | FAILED at step 1 ("Settings" does not exist) |

## Actual application paths

- **API key:** Dashboard → **Developer Settings** → **API Keys** → **Generate Key**.
  Outcome: `API key generated successfully.`, a new row `demo_fake_key_0002`, and the count changes from `1 key` to `2 keys`.
- **Workspace settings:** Dashboard → **Workspace Settings** → **Workspace name** → **Save changes**.
  "General" is only a section heading on that page, not something to click, so the corrected tutorial removes that step rather than renaming it.
  Outcome: `Workspace settings saved.` and the field shows the new name.

## Primary demo loop

1. Run the API-key tutorial. Kane fails at "Settings" and captures evidence.
2. Claude receives only the tutorial, the failed step and sanitized evidence, and proposes a correction. If the evidence doesn't establish the route, KaneVerity requests a Kane exploration run first.
3. Approve the diff. KaneVerity writes the change to the Markdown file.
4. Kane reruns the corrected tutorial. VERIFIED only if every documented outcome assertion passes.

## Signals visible to a human reader

The outdated tutorials have older "Last reviewed" dates (2025) than the correct ones (2026-11-10). Nothing else on the docs site marks them.
