/** Importing startSavedDEApi means a real API subprocess: only classified API tests may do so. */
const sharedApiFixtureImport=/import\s*\{[^}]*\bstartSavedDEApi\b[^}]*\}\s*from\s*['"]\.\/helpers\/d-e-saved-api-fixture\.mjs['"]/u;

const forbiddenPatterns = [
  ["API server entrypoint", /server\.mjs/u],
  ["child process", /node:child_process|\bspawn(?:Sync)?\s*\(|\bexec(?:File|FileSync|Sync)?\s*\(/u],
  ["network server", /\bcreateServer\s*\(|\.listen\s*\(/u],
  ["network client", /\bfetch\s*\(|\bWebSocket\s*\(|\bXMLHttpRequest\b|node:https?/u],
  ["live candidate fixture", /candidates\.json/u],
  ["isolated API fixture", sharedApiFixtureImport],
];

/** API tests may use the shared isolated subprocess fixture or the packaged launch script; inspect those implementations too. */
export function assertIsolatedApiTestSource({file,source,sharedFixtureSource,launchScriptSource}) {
  const direct=source.includes('server.mjs');
  const shared=sharedApiFixtureImport.test(source)&&
    /\bstartSavedDEApi\s*\(/u.test(source)&&typeof sharedFixtureSource==='string'&&
    sharedFixtureSource.includes('node:child_process')&&sharedFixtureSource.includes('server.mjs')&&sharedFixtureSource.includes('TEST_REQUIRES_ISOLATED_PORT');
  // Packaged: the test prepares a runtime package in temporary storage and starts it through the package's own launch script,
  // which must exec the bundled Node on server.mjs. The launch script source is inspected, not trusted by name.
  const packaged=/import\s*\{[^}]*\bprepareRuntimePackage\b[^}]*\}\s*from\s*['"]\.\.\/scripts\/runtime-package\.mjs['"]/u.test(source)&&
    /\bprepareRuntimePackage\s*\(/u.test(source)&&source.includes('scripts/launch-server.sh')&&source.includes('node:child_process')&&
    source.includes('TEST_REQUIRES_ISOLATED_PORT')&&typeof launchScriptSource==='string'&&
    /\bexec\s+"\$REVIEW_NODE"\s+"\$REVIEW_RUNTIME_ROOT\/server\.mjs"/u.test(launchScriptSource);
  if(!source.includes('mkdtemp')||!direct&&!shared&&!packaged)throw new Error(`CI_API_TEST_BOUNDARY_MISSING:${file}`);
}

/** Local Seatbelt permits only the runner's three allocated ports. Inspect the named helper, not a comment marker. */
export function assertLocalApiTestPortsSource({ file, source, portFixtureSource, sharedFixtureSource }) {
  const usesAllocated = /import\s*\{[^}]*\ballocatedTestPorts\b[^}]*\}\s*from\s*['"]\.\/helpers\/api-process-lifecycle\.mjs['"]/u.test(source)
    && /\ballocatedTestPorts\s*\(/u.test(source);
  if (usesAllocated) {
    const inspected = typeof portFixtureSource === 'string'
      && portFixtureSource.includes('export function allocatedTestPorts(')
      && ['SELECTION_REVIEW_TEST_PORT', 'SELECTION_REVIEW_TEST_SECOND_PORT', 'SELECTION_REVIEW_TEST_GATEWAY_PORT',
        '65535', 'new Set(ports)', 'TEST_REQUIRES_ISOLATED_PORT'].every(value => portFixtureSource.includes(value));
    const dynamic = /\bfreePort\s*\(|\.listen\s*\(\s*0\b|process\.pid\s*%/u.test(source);
    const shared = !sharedApiFixtureImport.test(source) || typeof sharedFixtureSource === 'string'
      && sharedFixtureSource.includes('const allocated = allocatedTestPorts();')
      && sharedFixtureSource.includes('const dependencyPort = allocated.gateway;')
      && sharedFixtureSource.includes('port !== allocated.api && port !== allocated.second');
    if (!inspected || dynamic || !shared) throw new Error(`LOCAL_API_TEST_PORT_BOUNDARY_MISSING:${file}`);
    return 'allocated_fixture';
  }
  // Previously classified direct/package tests retain their own explicit-port guard and the exact OS whitelist.
  if (!source.includes('SELECTION_REVIEW_TEST_PORT') || !source.includes('TEST_REQUIRES_ISOLATED_PORT')) {
    throw new Error(`LOCAL_API_TEST_PORT_BOUNDARY_MISSING:${file}`);
  }
  return 'direct_guard';
}

export function assertSelfContainedTestSource({
  file,
  source,
  allowTemporaryCandidateFixture = false,
}) {
  for (const [label, pattern] of forbiddenPatterns) {
    if (label === "live candidate fixture" && allowTemporaryCandidateFixture) {
      continue;
    }

    if (pattern.test(source)) {
      throw new Error(`CI_TEST_REQUIRES_CLASSIFICATION:${label}:${file}`);
    }
  }
}
