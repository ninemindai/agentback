import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as esbuild from 'esbuild';

// dist/widget/html.js → <project>/widget/
const WIDGET_DIR = new URL('../../widget/', import.meta.url);

let html: Promise<string> | undefined;

/**
 * The widget HTML: widget/view.js bundled with esbuild (it imports the
 * ext-apps bridge from npm) and inlined into widget/shell.html. Built once, on
 * first read, so starting the server stays a plain `node dist/main.js`.
 */
export function widgetHtml(): Promise<string> {
  html ??= (async () => {
    const {outputFiles} = await esbuild.build({
      entryPoints: [fileURLToPath(new URL('view.js', WIDGET_DIR))],
      bundle: true,
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    const shell = readFileSync(new URL('shell.html', WIDGET_DIR), 'utf8');
    return shell.replace('/*__VIEW_BUNDLE__*/', () => outputFiles[0].text);
  })();
  return html;
}
