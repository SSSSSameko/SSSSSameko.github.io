function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function processGroupIsRunning(child) {
  if (process.platform === 'win32' || !child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function targetIsRunning(child, processGroup) {
  if (processGroup && process.platform !== 'win32') return processGroupIsRunning(child);
  return !hasExited(child);
}

function signalChild(child, signal, processGroup) {
  if (processGroup && process.platform !== 'win32' && child?.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    return;
  }
  if (!hasExited(child)) child.kill(signal);
}

async function waitForTargetExit(child, timeoutMs, processGroup) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (targetIsRunning(child, processGroup) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !targetIsRunning(child, processGroup);
}

export async function stopChildProcess(child, options = {}) {
  const gracefulSignal = options.gracefulSignal || 'SIGTERM';
  const gracefulTimeoutMs = options.gracefulTimeoutMs || 5000;
  const killTimeoutMs = options.killTimeoutMs || 5000;
  const processGroup = options.processGroup === true;
  if (!targetIsRunning(child, processGroup)) return;

  signalChild(child, gracefulSignal, processGroup);
  if (await waitForTargetExit(child, gracefulTimeoutMs, processGroup)) return;

  signalChild(child, 'SIGKILL', processGroup);
  if (await waitForTargetExit(child, killTimeoutMs, processGroup)) return;
  throw new Error(`${processGroup ? '进程组' : '子进程'} ${child.pid || '-'} 无法终止`);
}
