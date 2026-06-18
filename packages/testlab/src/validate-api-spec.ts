// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createRequire} from 'module';
import {promisify} from 'util';

const require = createRequire(import.meta.filename);
const validator = require('oas-validator');

const validateAsync = promisify(validator.validate);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function validateApiSpec(spec: any): Promise<void> {
  await validateAsync(spec, {});
}
