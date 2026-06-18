// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/
import type {Diagnostic} from './deploy-target.js';
export async function runBundleDoctor(_entryPath: string): Promise<Diagnostic> {
  return {ok: true, message: ''};
}
