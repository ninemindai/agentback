// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export interface VerifyResult {
  ok: boolean;
  status: number;
  body?: string;
}

export async function verifyDeploy(
  url: string,
  opts: {verifyPath: string; headers?: Record<string, string>},
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<VerifyResult> {
  const target = new URL(opts.verifyPath, url).toString();
  const res = await fetchFn(target, {headers: opts.headers});
  if (res.status === 200) return {ok: true, status: 200};
  const text = await res.text().catch(() => '');
  return {ok: false, status: res.status, body: text.slice(0, 500)};
}
