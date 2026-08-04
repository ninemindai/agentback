// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync} from 'node:fs';
import path from 'node:path';
import {Project} from 'ts-morph';

/**
 * Build a ts-morph `Project` over the app's sources, lazily.
 *
 * ts-morph vendors its own TypeScript, so this is immune to whatever
 * `typescript` version the app pins — which matters given the framework's own
 * TS 6 / TS 7 side-by-side arrangement and the template's `typescript: ^5.9.0`.
 *
 * @param onBuild test seam, invoked the first time the project is constructed.
 */
export function createLazyProject(
  root: string,
  onBuild?: () => void,
): () => Project {
  let project: Project | undefined;
  return () => {
    if (project) return project;
    const tsconfig = path.join(root, 'tsconfig.json');
    // A tsconfig that `extends` a package (@tsconfig/node22, a shared preset)
    // cannot resolve before `npm install`, and detection is contractually
    // required to work on a never-installed tree. Glob is the fallback: it
    // loses compiler options we do not use, and never throws.
    if (existsSync(tsconfig)) {
      try {
        project = new Project({tsConfigFilePath: tsconfig});
      } catch {
        project = undefined;
      }
    }
    if (!project) {
      project = new Project({skipAddingFilesFromTsConfig: true});
      project.addSourceFilesAtPaths(path.join(root, 'src/**/*.ts'));
    }
    // A tsconfig can resolve yet still match nothing (an `include` that points
    // elsewhere). An empty project silently makes every advisory pass.
    if (project.getSourceFiles().length === 0) {
      project.addSourceFilesAtPaths(path.join(root, 'src/**/*.ts'));
    }
    onBuild?.();
    return project;
  };
}
