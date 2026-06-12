# @agentback/authentication-jwt

> JWT Bearer authentication strategy — minimal ESM port of
> `@loopback/authentication-jwt` with no `@loopback/repository` dependencies.

Wires a complete JWT Bearer auth stack into an AgentBack application via a
single component. Provides token sign/verify (`JWTService`), the strategy that
satisfies `@authenticate('jwt')`, and an OpenAPI spec enhancer that declares
`securitySchemes.jwtAuth` so Swagger UI's Authorize button works automatically.

```bash
pnpm add @agentback/authentication-jwt jsonwebtoken
```

## What it provides

| Export                       | Kind                           | Purpose                                                                                                     |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `JWTAuthenticationComponent` | `Component` class              | Registers `JWTService`, `JWTAuthenticationStrategy`, and `JWTSecuritySpecEnhancer` in one call              |
| `JWTService`                 | injectable class               | `generateToken(profile)` / `verifyToken(token)` — user-shape agnostic, round-trips all `UserProfile` fields |
| `JWTAuthenticationStrategy`  | injectable class               | Implements `AuthenticationStrategy` with `name = 'jwt'`; reads `Authorization: Bearer <token>` header       |
| `JWTSecuritySpecEnhancer`    | injectable class               | Adds `securitySchemes.jwtAuth` to the assembled OpenAPI 3.1 spec                                            |
| `JWTBindings.SECRET`         | `BindingKey<string>`           | Bind the JWT signing secret before adding the component                                                     |
| `JWTBindings.EXPIRES_IN`     | `BindingKey<string \| number>` | Token TTL: seconds or jsonwebtoken string (`'1h'`, `'7d'`)                                                  |
| `JWTBindings.SERVICE`        | `BindingKey<JWTService>`       | Resolved `JWTService` instance                                                                              |

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {
  JWTAuthenticationComponent,
  JWTBindings,
  JWTService,
} from '@agentback/authentication-jwt';
import {authenticate} from '@agentback/authentication';
import {inject} from '@agentback/context';
import {securityId, type UserProfile} from '@agentback/security';
import {post, get} from '@agentback/openapi';
import {z} from 'zod';

const app = new RestApplication({rest: {port: 3000}});

// 1. Bind config before the component.
app.bind(JWTBindings.SECRET).to(process.env.JWT_SECRET!);
app.bind(JWTBindings.EXPIRES_IN).to('1h');
app.component(JWTAuthenticationComponent);

// 2. Issue tokens in an auth controller.
const LoginIn = z.object({username: z.string(), password: z.string()});

class AuthController {
  constructor(@inject(JWTBindings.SERVICE) private jwt: JWTService) {}

  @post('/auth/login', {body: LoginIn, response: z.object({token: z.string()})})
  async login(input: {body: z.infer<typeof LoginIn>}) {
    // verify credentials…
    const profile: UserProfile = {
      [securityId]: 'user-42',
      name: input.body.username,
    };
    return {token: await this.jwt.generateToken(profile)};
  }
}

// 3. Protect routes with @authenticate('jwt').
@authenticate('jwt')
class WidgetController {
  @get('/widgets')
  list() {
    return [];
  }
}

app.controller(AuthController);
app.controller(WidgetController);
await app.start();
```

## Layering

Depends on: `@agentback/authentication`, `@agentback/context`,
`@agentback/core`, `@agentback/openapi`, `@agentback/security`,
`jsonwebtoken`.

Sits above `@agentback/authentication` (implements its strategy interface)
and is consumed directly by application code. The `JWTSecuritySpecEnhancer`
integrates with `@agentback/openapi`'s enhancer extension point so
Swagger UI reflects the correct security scheme without manual spec edits.
