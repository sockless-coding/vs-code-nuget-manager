import * as vscode from "vscode";
import { NuGetPanel } from "./panel/NuGetPanel";
import {
  FeedInfo,
  HostResponsePayload,
  InitialState,
  PackageSummary,
  ProjectInfo,
  WebviewRequest
} from "./panel/messaging";
import { HttpClient, HttpError } from "./nuget/httpClient";
import { ServiceIndexCache } from "./nuget/serviceIndex";
import { SearchService, mergeSearchResults } from "./nuget/search";
import { mapWithConcurrency } from "./util";
import { MetadataService } from "./nuget/metadata";
import { FeedRegistry } from "./nuget/feeds";
import { DotnetCli } from "./dotnet/cli";
import { ProjectRegistry } from "./projects/discovery";
import { InstalledService } from "./projects/installed";
import { MutationService } from "./projects/mutations";

const ALL_SOURCES = "All sources";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("NuGet");
  context.subscriptions.push(output);

  const feeds = new FeedRegistry(context);
  feeds.refresh();

  const http = new HttpClient((url) => feeds.getAuthHeader(url));
  const indexes = new ServiceIndexCache(http);
  const search = new SearchService(http, indexes);
  const metadata = new MetadataService(http, indexes);

  const dotnet = new DotnetCli(output);
  const projects = new ProjectRegistry();
  context.subscriptions.push(projects);
  projects.start();
  await projects.refresh();

  const installed = new InstalledService(projects, dotnet, feeds, metadata);
  const mutations = new MutationService(projects, dotnet, output);

  const controller = new Controller(feeds, http, search, metadata, installed, mutations, projects);

  projects.onDidChange(() => NuGetPanel.instance?.sendEvent({ type: "event", event: "projectsChanged" }));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nuget")) {
        feeds.refresh();
        http.clearCache();
        dotnet.invalidateAvailability();
        NuGetPanel.instance?.sendEvent({ type: "event", event: "settingsChanged" });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nuget.openManager", () => {
      NuGetPanel.createOrShow(context, (req) => controller.handle(req));
    }),
    vscode.commands.registerCommand("nuget.refresh", async () => {
      feeds.refresh();
      http.clearCache();
      await projects.refresh();
      NuGetPanel.instance?.sendEvent({ type: "event", event: "installedChanged" });
    })
  );
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}

class Controller {
  constructor(
    private readonly feeds: FeedRegistry,
    private readonly http: HttpClient,
    private readonly search: SearchService,
    private readonly metadata: MetadataService,
    private readonly installed: InstalledService,
    private readonly mutations: MutationService,
    private readonly projects: ProjectRegistry
  ) {}

  async handle(req: WebviewRequest): Promise<HostResponsePayload | undefined> {
    switch (req.kind) {
      case "ready":
        return { kind: "ready", initialState: this.initialState() };

      case "listFeeds":
        return { kind: "listFeeds", feeds: this.feedInfos() };

      case "listProjects":
        return { kind: "listProjects", projects: this.projectInfos() };

      case "search":
        return this.doSearch(req);

      case "getPackageDetail":
        return this.doDetail(req);

      case "listInstalled": {
        const { packages, sdkAvailable } = await this.installed.list(req.includeTransitive);
        return { kind: "listInstalled", packages, sdkAvailable };
      }

      case "listUpdates":
        return { kind: "listUpdates", packages: await this.installed.listUpdates(this.minimumPackageAgeDays()) };

      case "mutate": {
        const feed = req.request.source ? this.feeds.findByName(req.request.source) : undefined;
        const result = await this.mutations.apply(req.request, feed?.isV3 ? undefined : feed?.url);
        NuGetPanel.instance?.sendEvent({ type: "event", event: "installedChanged" });
        return { kind: "mutate", result };
      }

      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(req.url));
        return { kind: "openExternal" };

      default:
        return undefined;
    }
  }

  private initialState(): InitialState {
    return {
      defaultIncludePrerelease: vscode.workspace
        .getConfiguration("nuget")
        .get<boolean>("defaultIncludePrerelease", false),
      feeds: this.feedInfos(),
      projects: this.projectInfos(),
      minimumPackageAgeDays: this.minimumPackageAgeDays()
    };
  }

  private minimumPackageAgeDays(): number {
    const raw = vscode.workspace.getConfiguration("nuget").get<number>("minimumPackageAgeDays", 7);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  private feedInfos(): FeedInfo[] {
    return this.feeds.getFeeds().map((f) => ({
      name: f.name,
      url: f.url,
      enabled: f.enabled && f.isV3,
      requiresAuth: !!f.username || f.hasEncryptedPassword || !!f.clearTextPassword
    }));
  }

  private projectInfos(): ProjectInfo[] {
    return this.projects.getProjects().map((p) => p.info);
  }

  private targetFeeds(source: string) {
    const enabled = this.feeds.getEnabledV3Feeds();
    if (source && source !== ALL_SOURCES) {
      return enabled.filter((f) => f.name === source);
    }
    return enabled;
  }

  private async doSearch(req: Extract<WebviewRequest, { kind: "search" }>): Promise<HostResponsePayload> {
    const feeds = this.targetFeeds(req.source);
    const lists = await Promise.all(
      feeds.map((feed) =>
        this.withAuthRetry(feed.name, () =>
          this.search.search(feed.url, feed.name, {
            query: req.query,
            skip: req.skip,
            take: req.take,
            includePrerelease: req.includePrerelease
          })
        ).catch(() => ({ results: [], hasMore: false }))
      )
    );
    const results = mergeSearchResults(lists.map((l) => l.results));
    // Best-effort supply-chain flag; never let it stall the result list.
    await Promise.race([
      this.enrichPublishDates(results),
      new Promise((resolve) => setTimeout(resolve, 2500))
    ]);
    return {
      kind: "search",
      results,
      hasMore: lists.some((l) => l.hasMore)
    };
  }

  /** Best-effort: attach the publish date of each result's latest version. */
  private async enrichPublishDates(results: PackageSummary[]): Promise<void> {
    await mapWithConcurrency(results, 8, async (r) => {
      const feed = this.feeds.findByName(r.source) ?? this.feeds.getEnabledV3Feeds()[0];
      if (!feed?.isV3) return;
      try {
        const dates = await this.metadata.publishedDates(feed.url, r.id);
        const d = dates.get(r.version.toLowerCase());
        if (d) r.latestPublished = d;
      } catch {
        /* ignore */
      }
    });
  }

  private async doDetail(req: Extract<WebviewRequest, { kind: "getPackageDetail" }>): Promise<HostResponsePayload> {
    const feeds = this.targetFeeds(req.source);
    const feed = feeds[0] ?? this.feeds.getEnabledV3Feeds()[0];
    if (!feed) {
      throw new Error("No NuGet v3 feed is configured.");
    }
    const detail = await this.withAuthRetry(feed.name, () =>
      this.metadata.getPackageDetail(feed.url, feed.name, req.packageId, req.includePrerelease)
    );
    return { kind: "getPackageDetail", detail };
  }

  /** Run `fn`; on a 401/403 prompt for credentials once and retry. */
  private async withAuthRetry<T>(feedName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        const saved = await this.feeds.promptForCredentials(feedName);
        if (saved) {
          this.http.clearCache();
          return fn();
        }
      }
      throw err;
    }
  }
}
