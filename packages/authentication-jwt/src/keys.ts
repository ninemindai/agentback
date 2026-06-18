// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import type {JWTService} from './jwt.service.js';

export namespace JWTBindings {
  export const SECRET = BindingKey.create<string>('jwt.secret');
  /** Expires-in in seconds, or a string accepted by jsonwebtoken (e.g. '1h'). */
  export const EXPIRES_IN = BindingKey.create<string | number>('jwt.expiresIn');
  export const SERVICE = BindingKey.create<JWTService>('jwt.service');
}
