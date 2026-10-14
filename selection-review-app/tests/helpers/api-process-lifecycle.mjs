/** The isolated runner owns every port. Tests never choose another port or fall back to a PID. */
export function allocatedTestPorts(env = process.env) {
  const keys = ['SELECTION_REVIEW_TEST_PORT', 'SELECTION_REVIEW_TEST_SECOND_PORT', 'SELECTION_REVIEW_TEST_GATEWAY_PORT'];
  const ports = keys.map(key => {
    const text = env[key];
    if (typeof text !== 'string' || !/^[1-9][0-9]*$/u.test(text)) throw new Error('TEST_REQUIRES_ISOLATED_PORT');
    const port = Number(text);
    if (!Number.isSafeInteger(port) || port > 65535 || [4317, 4318, 4173, 4319].includes(port)) {
      throw new Error('TEST_REQUIRES_ISOLATED_PORT');
    }
    return port;
  });
  if (new Set(ports).size !== ports.length) throw new Error('TEST_REQUIRES_ISOLATED_PORT');
  return Object.freeze({ api: ports[0], second: ports[1], gateway: ports[2] });
}

function exitError(code, signal) {
  if (code === 0 || (code === null && signal === "SIGTERM")) return null;
  return new Error(`API_PROCESS_EXIT_FAILED: code=${code}, signal=${signal}`);
}

export async function stopApiProcess(child, { timeoutMs = 5000, killTimeoutMs = 1000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(killTimeoutMs) || killTimeoutMs < 1) {
    throw new Error("API_PROCESS_CLEANUP_INVALID_TIMEOUT");
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    const error = exitError(child.exitCode, child.signalCode);
    if (error) throw error;
    return;
  }

  await new Promise((resolve, reject) => {
    let timer;
    let shutdownTimedOut = false;
    const timeoutError = () => new Error("API_PROCESS_SHUTDOWN_TIMEOUT: SIGTERM did not stop the test server; SIGKILL was required");
    const finish = (error) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code, signal) => finish(shutdownTimedOut ? timeoutError() : exitError(code, signal));
    const onError = (error) => finish(new Error("API_PROCESS_CLEANUP_FAILED", { cause: error }));
    const sendSignal = (signal) => {
      try {
        if (!child.kill(signal)) finish(new Error(`API_PROCESS_SIGNAL_FAILED: ${signal}`));
      } catch (error) {
        onError(error);
      }
    };

    child.once("exit", onExit);
    child.once("error", onError);
    timer = setTimeout(() => {
      shutdownTimedOut = true;
      timer = setTimeout(() => finish(timeoutError()), killTimeoutMs);
      sendSignal("SIGKILL");
    }, timeoutMs);
    sendSignal("SIGTERM");
  });
}
