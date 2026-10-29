# Skill Shelf for Magpie

[简体中文](README.md) · English

A visual shelf for your AI agent Skills, right inside your Magpie workflow. Browse what you already have, organize it into folders and tags, and keep reusable collections in Packs.

Install the plugin in [Magpie](https://usemagpie.ai), then open it directly inside the Magpie window. You do not need the [Skill Shelf desktop app](https://github.com/voidrinz/skill-shelf) to get started.

## What you can do

- **Discover and install Skills.** Browse skills.sh rankings, trending, hot, official sources and topics; search, inspect and confirm global or registered-project installations.
- **Manage Agent access.** Preview shared Skill connections using links or copies, update unchanged copies, repair managed links and disconnect safely.
- **Edit project instructions.** Edit AGENTS.md and CLAUDE.md, or connect Claude to AGENTS.md without replacing its existing instructions.
- **Find your Skills.** See Skills across your agents and projects, search your library, and check where each one is installed.
- **Organize visually.** Use folders, tags, and icon, list, or column views. Read descriptions and preview files without opening an editor.
- **Build your own Packs.** Make independent copies of useful Skills, group them by task, and export or deploy them when needed.
- **Get help from AI.** Ask about a Skill, generate a description, or translate its description using models you already have in Magpie.
- **Sync with Skill Shelf.** Exchange Packs and organization with the desktop app through WebDAV or a sync file.

The current plugin release is **v0.1.15**, following the **Skill Shelf desktop v0.1.14** core feature baseline, including discovery, installation, Agent access, project instructions and independent Packs. Both editions use metadata sync format v5. The plugin release and desktop baseline are tracked separately; see the [alignment record](FEATURE_PARITY.md).

## Get started

### 1. Download the plugin

Install [Magpie](https://usemagpie.ai) first. Download this repository using **Code → Download ZIP** on GitHub and extract it, or clone it:

```sh
git clone https://github.com/voidrinz/skill-shelf-magpie-plugin.git
```

The repository includes the built plugin, so you do not need to install Node.js or run a build just to use it.

### 2. Add it to Magpie

Open Magpie's **Plugins** page, add the extracted or cloned `skill-shelf-magpie-plugin` folder as a local plugin, and enable it. Choose the folder containing `package.json`, not its `dist` subfolder.

If you prefer the terminal:

```sh
magpie plugin add /absolute/path/to/skill-shelf-magpie-plugin
```

Replace the example path with the folder's actual location. Keep that folder in place while the plugin is installed.

### 3. Open your shelf

The plugin starts quietly in the background by default, without opening a browser when Magpie starts, restarts or reloads the plugin. It prefers `127.0.0.1:47822`; if another application is using that port, it automatically chooses a free one. No source-code changes or manual port settings are needed.

After enabling the plugin, choose **Plugins → Skill Shelf** in Magpie's sidebar. The shelf opens inside the application window, with settings available within the shelf. This requires a recent Magpie version supporting `magpie.page`. If the entry is missing, update Magpie, then disable and re-enable the plugin.

The local service continues to handle scanning and filesystem operations. The page uses the actual workbench address, including automatic port fallback. The plugin installation folder must be writable so startup can update the in-app connection file.

Magpie's page sandbox does not allow browser storage or downloads. In-app preferences are saved with the shelf data. Pack and sync exports are saved in the data folder's `exports/` directory, which opens automatically. External links open in your system browser.

You can also open **`Skill Shelf.html`** in the plugin data folder to use the shelf in a standalone browser. This local entry uses the actual address; fallback ports may change, so avoid relying only on a bookmark to one port.

**Keep Magpie running while you use the shelf.** If you use the CLI instead of the app, keep `magpie web` running; the one-off installation command does not keep the workbench online.

### Startup options (advanced)

Normally no changes are needed. The plugin supports `open` (open the browser on startup, `false` by default), `port` (preferred port, `47822` by default, with automatic fallback) and `dataDir` (an absolute path to the shelf data). Only an explicit `open: true` enables automatic opening. If an older configuration enabled it, disable it while keeping the in-app entry:

```sh
magpie plugin options /absolute/path/to/skill-shelf-magpie-plugin '{"open":false,"port":47822}'
```

Replace the path with the local folder used when installing the plugin, or use the installed spec for other installation methods. Options apply when the plugin host reloads. Changing `dataDir` selects another shelf; it does not migrate existing data.

Magpie currently shows its graphical **Options** button only for gateway middleware. Skill Shelf does not process gateway requests and does not register empty middleware just to expose that button. Manage scanning sources, appearance, AI and sync in the workbench settings instead of duplicating them in startup options.

## Your first few minutes

1. Start on **Workbench (工作台)** to see which agents and Skills were found.
2. Open **Skills**, choose a scope, and search or switch views. If something is missing, add its folder or project under **设置 → Skills 与 Agent**, then click **重新扫描** to refresh the local inventory.
3. Open a Skill to read its description and files. Add folders and tags to make it easier to find next time.
4. Right-click a Skill and choose **导入到 Packs** to keep an independent copy in the Default Pack. You can then organize it in **Packs**.

For supported installed Skills, **扫描更新** checks for upstream updates. Review and confirm before updating; unlike organizing or previewing, an update changes the installed files.

## Discovery, Installation And Agent Access

Open **Discover**, or use **Install from source** in Skills. Supported sources include GitHub, skills.sh links and absolute local directories. Recognized `npx skills add` command text is parsed, never executed as arbitrary shell input. Downloads run in an isolated directory; existing destinations are not silently overwritten. Installation and removal require confirmation.

Choose **Manage access** in the Workbench to connect global shared Skills to an Agent. Direct shared readers need no deployment. External files are not adopted, overwritten or removed, and modified managed copies are protected. Every write uses an expiring preview. Pack deployments remain a separate workflow.

In a project scope, open **Project instructions** to edit AGENTS.md and CLAUDE.md. Existing files are backed up before saving and checked for external edits. Symlinked or otherwise unsafe files remain read-only.

Single-Pack exports now use desktop-compatible metadata v5, with import preview and conflict decisions. Legacy plugin Pack files remain importable. Portable preferences, custom descriptions and folder/Pack view options participate in synchronization; Magpie credentials are not imported.

## Working with Packs

A Pack is your own collection of Skill copies: for example, “Writing”, “Frontend”, or “Code review”. Importing into a Pack does not move or change the original Skill.

You can export a Pack as a file to share or back it up, or deploy its Skills to an agent's Skills folder. **Copy** makes separate files; **symlink** keeps the destination linked to the Pack. Remove linked deployments before deleting their source. Deleting a Pack does not delete previously deployed copies.

## AI help

Choose your models and output language in the workbench settings, then use the assistant or a Skill's description actions. There is no separate provider signup or API key setup in this plugin. Reading files does not invoke AI, and whole-file translation is not included.

AI runs only when you request it. The relevant Skill text, your question, and conversation context may be sent to the model provider configured in Magpie; that provider's fees, limits, and privacy policy still apply. You can organize and browse without AI.

## Sync with the desktop app

Sync is optional and manual, not automatic:

1. Configure the same WebDAV address and account in the plugin's **设置 → 同步** and the Skill Shelf desktop app.
2. Upload from the side with the data you want to share. Review the preview and any conflicts before confirming.
3. Pull on the other side, review, and confirm the merge.

You can also export and import a file through **同步** if you do not use WebDAV. Use this rather than a standalone Pack export when exchanging your library organization with the desktop app.

Sync includes Pack copies and matching installed Skills' folders, tags, layout, custom descriptions, translations and folder view settings. Portable theme, density and focused-Agent preferences merge per field. It does **not** install the original Skills on another machine; install them there separately. Plugin sync is separate from Magpie's own sync.

Use a trusted WebDAV service: desktop sync files may contain AI credentials. The plugin also stores its WebDAV password locally without encryption.

## Common questions

### Will organizing change my installed Skills?

No. Folders, tags, previews, and AI annotations leave the original Skill files unchanged. Confirmed installations, updates, removals, Agent access, project instruction saves and Pack deployments do write files, so review those actions before proceeding. The plugin does not execute scripts inside Skills.

### Why is the page unavailable?

Make sure Magpie is running and the plugin is enabled. Open Magpie's Plugins page once if it has not loaded the plugin yet. After restarting or updating the plugin, reopen Skill Shelf from the sidebar; if a new version is not showing, disable and re-enable the plugin first.

### What if the default port is already in use?

It automatically moves to a free port without stopping the other application or using another shelf's data. Multiple Magpie processes loading the same shelf share one workbench. On restart, the plugin tries to keep the previous address; if that port is also occupied, it chooses another and updates the manual entry points without opening a browser by default.

This does not require a graphical port setting in Magpie, editing source code or JSON, or running commands. Reopen `Skill Shelf.html` if you need the current address.

### Do I still open it through Add provider?

No. The plugin now uses Magpie's `magpie.page` entry and does not register a provider or sign-in actions. After updating, disable and re-enable the plugin, then choose **Plugins → Skill Shelf** in the sidebar.

### Where is my data?

Your shelf data and the `Skill Shelf.html` entry are stored locally in `skill-shelf/` under Magpie's configuration directory. The default is normally `.config/magpie/skill-shelf/` in your home folder; use the actual location if you customized Magpie's configuration directory. On macOS, use Finder's **Go → Go to Folder** with `~/.config/magpie/skill-shelf/`, then double-click the entry file.

Closing the shelf page or removing the plugin does not automatically delete your data. Back up important Packs before manually deleting data.

---

[MIT](LICENSE) © [Rin](https://github.com/voidrinz)
