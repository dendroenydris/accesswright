export interface RepairExecOptions {
  environment?: Readonly<Record<string, string>>;
  user?: string;
  timeoutMs?: number;
}
export interface RepairExecResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }

export interface RepairTransport {
  readonly kind: "docker" | "ephemeral";
  readonly application: string;
  readonly baseUrl: "http://accesswright-app:3000" | "http://127.0.0.1:3000";
  create(source: string): Promise<void>;
  exec(role: "application" | "browser", command: readonly string[], options?: RepairExecOptions): Promise<RepairExecResult>;
  copyToApplication(source: string, destination: string): Promise<void>;
  ownWorkspace(paths: readonly string[]): Promise<void>;
  finishInstall(): Promise<void>;
  syncEvidence(names: readonly string[]): Promise<void>;
  close(): Promise<void>;
}
