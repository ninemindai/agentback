// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export interface ResolvedBuilder {entry: string; exportName: string;}
export interface GenerateOpts {builder: ResolvedBuilder; cwd: string; isConsoleBuilder: boolean; force: boolean; eject: boolean;}
export interface FileEdit {path: string; contents: string;}
export interface Diagnostic {ok: boolean; message: string;}
export interface RunDeps {exec: import('./exec.js').Exec; fetchFn: typeof fetch; cwd: string;}
export interface RunOutcome {status: 'deployed' | 'ejected' | 'dry-run'; url?: string; verify?: import('./verify.js').VerifyResult;}
export interface DeployTarget {
  id: 'vercel' | 'cloudflare';
  generateEntry(o: GenerateOpts): FileEdit;
  generateConfig(o: GenerateOpts): FileEdit[];
  preflight(o: GenerateOpts, deps: RunDeps): Promise<Diagnostic[]>;
  deploy(args: import('./args.js').DeployArgs, deps: RunDeps): Promise<{url: string}>;
  defaultVerifyPath(): string;
}
