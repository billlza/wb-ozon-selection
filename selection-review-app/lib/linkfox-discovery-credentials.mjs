import { CredentialStoreError, createOsCredentialStore, isCredentialStorePlatformSupported } from './credential-store.mjs';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { ADiscoveryError } from './a-discovery-contract.mjs';
import { LinkfoxDiscoveryError } from './linkfox-discovery-api.mjs';

const label = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);

export function normalizeLinkfoxDiscoveryCredentialBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length > 1) throw new TypeError('A_DISCOVERY_CREDENTIAL_CONFIGURATION_INVALID');
  return Object.freeze(bindings.map(binding => {
    const fields = ['credentialAlias', 'keychainService', 'keychainAccount'];
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).length !== fields.length ||
        !fields.every(field => Object.hasOwn(binding, field)) || !isCanonicalFrozenRef(binding.credentialAlias) ||
        !label(binding.keychainService) || !label(binding.keychainAccount)) {
      throw new TypeError('A_DISCOVERY_CREDENTIAL_CONFIGURATION_INVALID');
    }
    return Object.freeze({ ...binding });
  }));
}

/** Local development credential boundary. Construction and configuration reads do not access the OS credential store. */
export function createLinkfoxDiscoverySecretReader(options) {
  return createLocalDiscoverySecretReader(options, 'linkfox', LinkfoxDiscoveryError);
}

export function createSeerfarDiscoverySecretReader(options) {
  return createLocalDiscoverySecretReader(options, 'seerfar', ADiscoveryError);
}

function createLocalDiscoverySecretReader({ bindings, runtimeMode, execFileImpl, platform = process.platform, credentialStore },
  expectedProvider, ErrorType) {
  const routes = normalizeLinkfoxDiscoveryCredentialBindings(bindings);
  if (execFileImpl !== undefined && typeof execFileImpl !== 'function' ||
      credentialStore !== undefined && typeof credentialStore?.readSecret !== 'function') throw new TypeError('A_DISCOVERY_CREDENTIAL_READER_INVALID');
  const store = credentialStore ?? createOsCredentialStore({ platform, ...(execFileImpl ? { execFileImpl } : {}) });
  return async function readSecret({ credentialAlias, provider, signal }) {
    if (runtimeMode !== 'local_development' || credentialStore === undefined && !isCredentialStorePlatformSupported(platform)) {
      throw new ErrorType('CREDENTIAL_UNAVAILABLE');
    }
    if (provider !== expectedProvider || !isCanonicalFrozenRef(credentialAlias) || signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('A_DISCOVERY_CREDENTIAL_REQUEST_INVALID');
    }
    const route = routes.find(value => value.credentialAlias === credentialAlias);
    if (!route) throw new ErrorType('CREDENTIAL_MISSING');
    signal?.throwIfAborted();
    let stdout;
    try {
      stdout = await store.readSecret({ service: route.keychainService, account: route.keychainAccount },
        { maxBuffer: 8192, timeout: 5000, signal });
    } catch (error) {
      signal?.throwIfAborted();
      // The credential store already reduced subprocess failures to a code; subprocess text can contain secrets.
      if (error instanceof CredentialStoreError) {
        throw new ErrorType(error.code === 'credential_missing' ? 'CREDENTIAL_MISSING'
          : error.code === 'credential_store_unavailable' ? 'CREDENTIAL_UNAVAILABLE' : 'CREDENTIAL_READ_FAILED');
      }
      throw error;
    }
    signal?.throwIfAborted();
    if (typeof stdout !== 'string') throw new TypeError('A_DISCOVERY_CREDENTIAL_READER_RESULT_INVALID');
    const secret = stdout.trim();
    if (!secret || secret.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(secret)) throw new ErrorType('CREDENTIAL_MISSING');
    return secret;
  };
}
