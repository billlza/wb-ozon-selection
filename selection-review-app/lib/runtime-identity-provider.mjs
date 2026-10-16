import { authorizeOperation, createLocalDevelopmentActor } from "./runtime-identity.mjs";
import { createLocalOwnerIdentityProvider, createPrivateOwnerCredentialRepository, OwnerIdentityError } from "./local-owner-identity.mjs";
import { createTeamAccountIdentityProvider } from "./team-account-identity.mjs";
import { createPostgresTeamAccountStore } from "./team-account-store.mjs";

export { OwnerIdentityError } from "./local-owner-identity.mjs";

export function createConfiguredIdentityProvider({ configuration, clock = () => new Date().toISOString(), credentialRepository,
  env = process.env, accountStore } = {}) {
  if (configuration?.identityProvider === "development_default") {
    return createDevelopmentIdentityProvider({ userId: configuration.defaultUserId, clock });
  }
  // Team accounts sit in the same database as the business state (their own table); the address comes only from the
  // environment, like the repository's.
  if (configuration?.identityProvider === "team_accounts" && configuration.stateAdapter === "postgres") {
    return createTeamAccountIdentityProvider({ clock, secureCookies: new URL(configuration.publicOrigin).protocol === "https:",
      trustedProxyHops: configuration.trustedProxyHops ?? 0,
      accountStore: accountStore ?? createPostgresTeamAccountStore({ connectionString: String(env?.SELECTION_REVIEW_DATABASE_URL ?? "").trim() }) });
  }
  if (configuration?.identityProvider === "local_owner_password" && configuration.deploymentMode === "local_development" &&
      configuration.localOwnerIdentity?.credentialFile && Array.isArray(configuration.localOwnerIdentity.protectedPaths) &&
      configuration.localOwnerIdentity.protectedPaths.length > 0 && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(configuration.bindHost)) {
    return createLocalOwnerIdentityProvider({ clock, secureCookies: new URL(configuration.publicOrigin).protocol === "https:",
      credentialRepository: credentialRepository ?? createPrivateOwnerCredentialRepository({
        filePath: configuration.localOwnerIdentity.credentialFile, protectedPaths: configuration.localOwnerIdentity.protectedPaths
      }) });
  }
  throw new OwnerIdentityError("IDENTITY_PROVIDER_NOT_IMPLEMENTED", 503, "所配置的身份提供器尚未实现或不适用于当前运行模式");
}

export function createDevelopmentIdentityProvider({ userId, clock = () => new Date().toISOString() } = {}) {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId || typeof clock !== "function") throw new Error("IDENTITY_PROVIDER_CONFIGURATION_INVALID");
  return Object.freeze({
    boundaryType: "runtime_identity_provider",
    providerType: "development_default",
    multiUserReady: false,
    async initialize() {},
    publicAccessState() { return { providerType: "development_default", status: "development_only", user: null }; },
    async setup() { throw new OwnerIdentityError("OWNER_IDENTITY_NOT_CONFIGURED", 503, "请先启用本地主人认证"); },
    async login() { throw new OwnerIdentityError("OWNER_IDENTITY_NOT_CONFIGURED", 503, "请先启用本地主人认证"); },
    logout() { throw new OwnerIdentityError("OWNER_IDENTITY_NOT_CONFIGURED", 503, "请先启用本地主人认证"); },
    resolveActor(requestContext = {}) {
      return createLocalDevelopmentActor({
        at: clock(),
        userId: normalizedUserId,
        sessionId: String(requestContext.sessionId || "local-development-session")
      });
    }
  });
}

export function assertIdentityProviderBoundary(provider) {
  if (!provider || provider.boundaryType !== "runtime_identity_provider" || typeof provider.resolveActor !== "function") {
    throw new Error("IDENTITY_PROVIDER_BOUNDARY_REQUIRED");
  }
  return Object.freeze({
    providerType: String(provider.providerType || "unknown"),
    multiUserReady: provider.multiUserReady === true
  });
}

export function authorizeIdentityProviderOperation({ provider, requestContext, requiredRoles }) {
  const boundary = assertIdentityProviderBoundary(provider);
  const actor = provider.resolveActor(requestContext);
  authorizeOperation({ actor, requiredRoles });
  return Object.freeze({ actor, boundary });
}
