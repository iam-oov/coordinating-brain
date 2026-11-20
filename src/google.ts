import type { JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

export interface GoogleVerifier {
  verify(idToken: string, expectedNonce?: string): Promise<GoogleIdentity>;
}

export interface GoogleCodeExchange {
  exchange(code: string, codeVerifier: string, redirectUri: string): Promise<string>;
}

export interface GoogleAuth {
  clientId: string;
  verifier: GoogleVerifier;
  exchange: GoogleCodeExchange;
}

export class GoogleAuthError extends Error {}

export function createGoogleVerifier(
  audience: string,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)),
): GoogleVerifier {
  return {
    async verify(idToken, expectedNonce) {
      let payload;
      try {
        ({ payload } = await jwtVerify(idToken, keys, { issuer: GOOGLE_ISSUERS, audience, algorithms: ['RS256'] }));
      } catch (e) {
        throw new GoogleAuthError(`Invalid ID token: ${(e as Error).message}`);
      }
      if (expectedNonce !== undefined && payload.nonce !== expectedNonce) throw new GoogleAuthError('Nonce mismatch');
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
      if (!email || payload.email_verified !== true) throw new GoogleAuthError('Email not verified');
      if (!payload.sub) throw new GoogleAuthError('Missing subject');
      const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : email.split('@')[0];
      return { sub: payload.sub, email, name };
    },
  };
}

export function createGoogleCodeExchange(
  clientId: string,
  clientSecret: string,
  fetchFn: typeof fetch = fetch,
): GoogleCodeExchange {
  return {
    async exchange(code, codeVerifier, redirectUri) {
      const res = await fetchFn(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id_token?: unknown };
      if (!res.ok || typeof body.id_token !== 'string') throw new GoogleAuthError(`Token exchange failed (${res.status})`);
      return body.id_token;
    },
  };
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string, nonce: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params}`;
}
