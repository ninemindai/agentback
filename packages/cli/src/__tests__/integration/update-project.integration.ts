// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createLazyProject} from '../../update/project.js';

// Deliberately idiosyncratic formatting: 4-space indent, no trailing commas,
// a blank line inside the class, an aligned comment. A codemod that reflows
// the file destroys all of it, and a scaffolded app ships no prettier to put
// it back.
const SOURCE = `import {api, get} from '@agentback/openapi';

@api({basePath: '/v1'})
export class GreetController {
    // greet the caller
    @get('/hello')
    async hello() {
        return {ok: true}
    }

    async unused() {
        return 1
    }
}
`;

describe('createLazyProject', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'abc-proj-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'greet.ts'), SOURCE);
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  it('does not parse the source tree until called', () => {
    let built = false;
    const project = createLazyProject(root, () => {
      built = true;
    });
    expect(built).toBe(false);
    project();
    expect(built).toBe(true);
  });

  it('returns the same Project instance across calls', () => {
    const project = createLazyProject(root);
    expect(project()).toBe(project());
  });

  it('falls back to a glob when tsconfig extends an uninstalled package', () => {
    // The contract is "works on a tree that has never been installed", and
    // `extends` into node_modules cannot resolve before install.
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({extends: '@tsconfig/node22/tsconfig.json'}),
    );
    const files = createLazyProject(root)().getSourceFiles();
    expect(files.map(f => path.basename(f.getFilePath()))).toContain(
      'greet.ts',
    );
  });

  it('adds the sources of every workspace package', () => {
    // Workspace apps keep their code in sub-packages reached via tsconfig
    // `references`, which ts-morph does not follow — so a root-only project
    // makes every advisory pass by not looking.
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({name: 'root', workspaces: ['packages/*']}),
    );
    mkdirSync(path.join(root, 'packages', 'app', 'src'), {recursive: true});
    writeFileSync(
      path.join(root, 'packages', 'app', 'package.json'),
      JSON.stringify({name: 'app'}),
    );
    writeFileSync(
      path.join(root, 'packages', 'app', 'src', 'deep.ts'),
      'export const deep = 1;\n',
    );
    const names = createLazyProject(root)()
      .getSourceFiles()
      .map(f => path.basename(f.getFilePath()));
    expect(names).toContain('deep.ts');
    expect(names).toContain('greet.ts');
  });

  it('leaves untouched regions byte-identical after a transform', () => {
    const project = createLazyProject(root);
    const file = project().getSourceFileOrThrow('greet.ts');

    // Synthetic transform standing in for a future real codemod: rename one
    // method. Everything else in the file must survive unchanged. This is the
    // guard that must exist BEFORE the first real codemod ships, not with it.
    file
      .getClassOrThrow('GreetController')
      .getMethodOrThrow('unused')
      .rename('renamed');
    file.saveSync();

    const after = readFileSync(path.join(root, 'src', 'greet.ts'), 'utf8');
    expect(after).toBe(SOURCE.replace('async unused()', 'async renamed()'));
  });
});
