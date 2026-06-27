// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingScope} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {FILE_STORE, InMemoryFileStore} from '@agentback/files';
import {FilesController} from './files.controller.js';
import {FileMetaStore, FILE_META} from './file-meta.store.js';

/**
 * hello-uploads: first-class multipart upload + streaming download.
 *
 * The `fileField()` on the upload route's body schema drives everything — the
 * multipart parser (which streams to the bound FileStore under a server UUID),
 * runtime validation, and the OpenAPI `multipart/form-data` contract.
 *
 * Two production swaps, neither touching the controller:
 *  - `InMemoryFileStore` → `S3FileStore` from `@agentback/files-s3`
 *  - `FileMetaStore` (a Map) → a Drizzle `files` table (`@agentback/drizzle`)
 */
export class HelloUploadsApplication extends RestApplication {
  constructor() {
    super();
    this.bind(FILE_STORE).to(new InMemoryFileStore());
    this.bind(FILE_META).toClass(FileMetaStore).inScope(BindingScope.SINGLETON);
    this.restController(FilesController);
  }
}
