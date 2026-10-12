import type * as vscode from "vscode";
import { PROVIDER_IDS, type ProviderAuthStatus, type ProviderId } from "../../common/types/provider";
import { loginTerminalLaunch, probeProviderAuth, type AuthProbe } from "../agent-factory/provider-authentication";
import { runtimeEnvironment } from "../agent-factory/process-environment";
import type { ProviderStatus } from "../agent-factory/provider-detection";

export interface ProviderAuthSnapshot {
  readonly auth: Partial<Readonly<Record<ProviderId, ProviderAuthStatus>>>;
  readonly checking: boolean;
  /** Providers whose sign-in terminal is still running. */
  readonly signingIn: readonly ProviderId[];
}

export interface ProviderAuthenticationOptions {
  readonly window: Pick<typeof vscode.window, "createTerminal" | "onDidCloseTerminal">;
  readonly statuses: () => readonly ProviderStatus[];
  readonly publish: (snapshot: ProviderAuthSnapshot) => unknown;
  readonly terminalName: (id: ProviderId) => string;
  readonly probe?: AuthProbe;
  readonly environment?: () => NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/**
 * Sign-in state and sign-in terminals for the detected provider CLIs. Status checks run the CLI's
 * own non-interactive command in the same extension host (local, SSH, WSL or container) and with
 * the same executable and PATH that Work uses; a sign-in only ever starts from an explicit request.
 */
export class ProviderAuthentication {
  private auth: Partial<Record<ProviderId, ProviderAuthStatus>> = {};
  private pending?: Promise<void>;
  private checking = false;
  private queued = false;
  private readonly terminals = new Map<ProviderId, vscode.Terminal>();
  private readonly closeListener: vscode.Disposable;

  public constructor(private readonly options: ProviderAuthenticationOptions) {
    this.closeListener = options.window.onDidCloseTerminal(terminal => {
      for (const [id, owned] of this.terminals) {
        if (owned !== terminal) continue;
        this.terminals.delete(id);
        // Closing the terminal proves nothing about the sign-in; ask the CLI again.
        void this.refresh();
      }
    });
  }

  public snapshot(): ProviderAuthSnapshot {
    return { auth: this.auth, checking: this.checking, signingIn: [...this.terminals.keys()] };
  }

  /** Re-check every provider; overlapping requests share one check and run once more afterwards. */
  public refresh(): Promise<void> {
    if (this.pending) {
      this.queued = true;
      return this.pending;
    }
    this.checking = true;
    const pending = (async () => {
      try {
        do {
          this.queued = false;
          await this.options.publish(this.snapshot());
          const statuses = this.options.statuses();
          const entries = await Promise.all(PROVIDER_IDS.map(async id => {
            const status = statuses.find(item => item.id === id);
            const path = status?.detected ? status.path : undefined;
            return [id, await probeProviderAuth(id, path, this.options.probe)] as const;
          }));
          this.auth = Object.fromEntries(entries);
        } while (this.queued);
      } finally {
        this.pending = undefined;
        this.checking = false;
      }
      await this.options.publish(this.snapshot());
    })();
    this.pending = pending;
    return pending;
  }

  /** Start the provider's own sign-in in a terminal, or reveal the one already running. */
  public login(id: ProviderId): "started" | "shown" | "unavailable" {
    const running = this.terminals.get(id);
    if (running && running.exitStatus === undefined) {
      running.show();
      return "shown";
    }
    if (running) {
      this.terminals.delete(id);
      running.dispose();
    }
    const status = this.options.statuses().find(item => item.id === id && item.detected);
    const launch = status?.path ? loginTerminalLaunch(id, status.path, this.options.platform) : undefined;
    if (!launch) return "unavailable";
    const environment = (this.options.environment ?? runtimeEnvironment)();
    const pathKey = environment.PATH === undefined && environment.Path !== undefined ? "Path" : "PATH";
    const terminal = this.options.window.createTerminal({
      name: this.options.terminalName(id),
      shellPath: launch.file,
      shellArgs: typeof launch.args === "string" ? launch.args : [...launch.args],
      ...(environment[pathKey] ? { env: { [pathKey]: environment[pathKey] } } : {})
    });
    this.terminals.set(id, terminal);
    terminal.show();
    void this.options.publish(this.snapshot());
    return "started";
  }

  public dispose(): void {
    this.closeListener.dispose();
    this.terminals.clear();
  }
}
