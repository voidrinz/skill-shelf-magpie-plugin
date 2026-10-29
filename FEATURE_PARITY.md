# Desktop Feature Alignment

Baseline: Skill Shelf desktop **0.1.14**, commit `a826cd0`.
Plugin version: **0.1.15**. Metadata sync format: **v5**.

The plugin now follows desktop core functionality rather than an organizer-only
product boundary. The plugin release and desktop baseline are tracked separately;
the baseline does not imply complete implementation or verification of every desktop capability.

## Implemented

| Area | Plugin behavior |
| --- | --- |
| UI primitives | Desktop-aligned buttons, inputs, menus, selects, tooltips, top-center notifications, Radix dialogs and switches. Dialogs share overlay, focus management and dismissal behavior. |
| Magpie page | Sidebar entry opens the workbench inside Magpie. The local backend handles filesystem operations; sandbox preferences persist in shelf data, and exports are saved to the local exports folder. |
| Skills | Global/project catalog, folders, tags, Finder views, previews and installed-Skill updates remain available. |
| Discovery | skills.sh all-time, trending, hot, official creators/repositories, topics, search and Skill details. Data comes from bounded same-site HTML/API requests, with stale-cache fallback. |
| Installation | Confirmed GitHub/skills.sh or absolute local sources; registered global/project targets and the desktop Agent registry. The pinned skills 1.5.23 CLI downloads into an isolated HOME/cwd; validated files and lock records are promoted without replacing existing destinations. |
| Removal | Preview actual installation entry paths, recheck them at confirmation and stage deletion transactionally. External source symlinks are detached instead of deleting their source trees. |
| Agent access | Dedicated searchable workspace with shared access, local files and Agent information. Desktop ownership, expiring previews, copies/links, copy updates, repairs, disconnects and recovery notices are retained. External files are not adopted or overwritten. |
| Project instructions | Edit AGENTS.md/CLAUDE.md, retain original backups, detect revision changes, keep unsafe files read-only and add the Claude import without replacing existing instructions. |
| Packs | Independent copies, organization and deployment. Single-Pack exports now use desktop metadata v5. Import requires preview/conflict decisions; private plugin v1 Pack imports remain supported. |
| Sync | v5 portable identities, files, nested folders, colors, tags, positions, translations, custom descriptions, portable preference fields and folder/Pack view options. Same-name Pack merges are disclosed; equivalent unique copies can match despite different local IDs. |
| AI | Existing Magpie model/credential integration remains; no separate desktop provider account store is introduced. |

## Adaptation Boundaries And Remaining Work

- Discovery uses the workbench backed by skills.sh requests, not an embedded
  Electron browser. Arbitrary remote source hosts, arbitrary pasted shell
  commands and the desktop marketplace security-audit presentation are not
  implemented.
- Installation/removal expose the current operation and result. The desktop's
  persistent multi-task queue, interactive terminal and PTY sessions are not
  ported. The bundled CLI still needs a working Git executable for GitHub sources.
- The existing interface is primarily Simplified Chinese. The portable language
  preference is preserved, but the complete English desktop interface is not yet
  implemented.
- Imports merge with previewed conflicts; desktop replace-import mode and the
  complete per-device cloud-history UI are not implemented.
- Compatible view settings are applied in Finder. Desktop update-status grouping
  falls back to a supported sort/group in the plugin; its portable value remains
  preserved until the user explicitly changes that view.
- Magpie owns model accounts. Desktop AI connections/credentials are not adopted
  by the plugin. Applicable organization and portable preferences are separate
  from installation paths and local ownership records.
- Tray menus, native windows, application updater and standalone background
  lifetime belong to the desktop/host layer. The plugin remains dependent on
  Magpie, and keeps automatic browser opening opt-in.

## Maintenance

`src/agent-registry.mjs`, `src/agent-programs.mjs`, `src/agent-access.mjs` and the
Agent access components are standalone transplants from the baseline. Keep their
contracts and filesystem semantics aligned with upstream; adapt IPC only in the
local HTTP bridge. The plugin must not require the sibling desktop checkout at
runtime.

Version metadata lives in `src/version.mjs` and `package.json`; the About screen
reads the same metadata. Update the baseline, this matrix and packaged `dist`
together. Do not equate a version bump with completed parity.

This alignment has compiler/build validation only. No real user Skill install,
update, removal, Agent mutation, model invocation or WebDAV operation is used
to validate it; full automated or live-host regression is not claimed.
