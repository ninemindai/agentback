// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {fromDisk} from './asset-source-disk.js';

/** @deprecated use `fromDisk` from asset-source. Kept for back-compat. */
export const serveStaticDir = fromDisk;
