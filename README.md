# Sockless NuGet Package Manager

A visual NuGet package manager for VS Code that feels familiar if you use the
**Manage NuGet Packages** dialog in Visual Studio: tabbed Browse / Installed /
Updates / Consolidate, fast search across your configured feeds, and a details
pane with a **correctly version-sorted** dropdown and per-project install /
update / uninstall.

## Features

- **Browse** – search every configured feed at once (or pick one), with prerelease
  toggle, download counts, verified-owner badges and package icons.
- **Version-correct** – versions are ordered with NuGet's own rules (four-part
  versions, prerelease precedence, `10.0.0` above `9.0.1`, `2.0.0` above
  `2.0.0-beta`), not naive string or SemVer comparison.
- **Installed** – everything referenced in the workspace, with package icons, an
  *Include transitive* toggle that shows the resolved dependency **tree** (which
  direct package pulls in each transitive one), and deprecation / vulnerability
  badges. Vulnerable **transitive** packages are always flagged, even with the
  toggle off.
- **Updates** – packages with a newer version available, plus **Update All**.
- **Supply-chain guardrail** – versions published within `nuget.minimumPackageAgeDays`
  (default 7) are flagged and held back from *Update All* and the default version
  selection; you can still pick them manually.
- **Consolidate** – packages referenced at different versions across projects.
- **Central Package Management** – detected automatically; versions are written to
  `Directory.Packages.props` and projects keep bare `<PackageReference>`.
- **Any feed** – reads solution / user / machine `nuget.config`, including private
  authenticated feeds (token stored in VS Code SecretStorage).
- **Safe writes** – uses the `dotnet` CLI when the .NET SDK is available; otherwise
  edits project files directly (preserving formatting) and tells you to restore.

## Usage

Open the manager from the command palette (**Manage NuGet Packages…**), the
editor-title icon on a `.csproj`, or the explorer context menu on a project file.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nuget.defaultIncludePrerelease` | `false` | Include prerelease packages by default. |
| `nuget.additionalSources` | `[]` | Extra `{ "name", "url" }` feeds to query. |
| `nuget.dotnetPath` | `dotnet` | Path to the `dotnet` executable. |
| `nuget.autoRestore` | `true` | Run `dotnet restore` after a change. |
| `nuget.minimumPackageAgeDays` | `7` | Days a version must be public before it is trusted; newer versions are flagged and held back. `0` disables. |

## Development

```bash
npm install
npm run watch      # esbuild in watch mode (extension + webview)
npm run test:unit  # version sorting, nuget.config parsing, csproj edits
```

Press <kbd>F5</kbd> to launch the Extension Development Host against
`sample-workspace/`, then run **Manage NuGet Packages…**.

### Building the VSIX

```bash
npm install
npm run vsix
```

This runs the production esbuild bundle (via the `vscode:prepublish` hook) and
writes `vs-code-nuget-manager-<version>.vsix` to the repo root. `--no-dependencies`
is used because everything is already bundled into `dist/`.

Install the result locally with either:

```bash
code --install-extension vs-code-nuget-manager-0.1.0.vsix
```

or **Extensions view → ··· → Install from VSIX…** in VS Code.

Other targets:

- `npm run vsix:prerelease` – packs with the `--pre-release` flag for the
  Marketplace pre-release channel.
- `npx vsce publish` – publishes to the Marketplace (needs a
  [publisher](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
  Personal Access Token; set `VSCE_PAT` or run `vsce login sockless-coding` first).
- `npx ovsx publish vs-code-nuget-manager-0.1.0.vsix -p <token>` – publishes to
  Open VSX.

Bump `version` in `package.json` before packaging a release.

### Architecture

| Area | Location |
| --- | --- |
| Activation, command wiring, request routing | [src/extension.ts](src/extension.ts) |
| Webview panel shell (CSP, message pump) | [src/panel/](src/panel/) |
| NuGet v3 API (service index, search, metadata) | [src/nuget/](src/nuget/) |
| Version parsing & ordering | [src/nuget/NuGetVersion.ts](src/nuget/NuGetVersion.ts) |
| Feeds & credentials | [src/nuget/feeds.ts](src/nuget/feeds.ts), [src/nuget/nugetConfig.ts](src/nuget/nugetConfig.ts) |
| Project discovery, installed/updates, mutations | [src/projects/](src/projects/) |
| Resolved dependency graph & audit warnings (`project.assets.json`) | [src/projects/assetsGraph.ts](src/projects/assetsGraph.ts) |
| `dotnet` CLI wrapper | [src/dotnet/cli.ts](src/dotnet/cli.ts) |
| React UI | [src/webview/](src/webview/) |

## License

MIT
