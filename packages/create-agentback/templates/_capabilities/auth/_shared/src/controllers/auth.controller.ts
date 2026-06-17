import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, get, post} from '@agentback/openapi';
import {authenticate} from '@agentback/authentication';
import {JWTBindings, JWTService} from '@agentback/authentication-jwt';
import {
  securityId,
  SecurityBindings,
  type UserProfile,
} from '@agentback/security';

const LoginIn = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
const TokenOut = z.object({token: z.string()});
const MeOut = z.object({id: z.string(), name: z.string().optional()});

// Issues JWTs at POST /auth/login (public) and exposes a JWT-protected
// GET /auth/me. Replace the demo credential check with a real user lookup.
@api({basePath: '/auth'})
export class AuthController {
  constructor(@inject(JWTBindings.SERVICE) private jwt: JWTService) {}

  @post('/login', {body: LoginIn, response: TokenOut})
  async login(input: {
    body: z.infer<typeof LoginIn>;
  }): Promise<z.infer<typeof TokenOut>> {
    // DEMO ONLY: accept any non-empty credentials. Verify real ones here.
    const profile: UserProfile = {
      [securityId]: `user-${input.body.username}`,
      name: input.body.username,
    };
    return {token: await this.jwt.generateToken(profile)};
  }

  @authenticate('jwt')
  @get('/me', {response: MeOut})
  async me(
    @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
  ): Promise<z.infer<typeof MeOut>> {
    return {id: user?.[securityId] ?? 'unknown', name: user?.name};
  }
}
