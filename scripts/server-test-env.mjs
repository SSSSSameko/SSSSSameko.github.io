import path from 'node:path';

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function serverTestEnv(runtimeDir, overrides = {}) {
  const outputDir = path.resolve(runtimeDir);
  const storage = {
    OUTPUT_DIR: outputDir,
    DRAWS_DIR: path.join(outputDir, 'draws'),
    DRAW_ATTEMPTS_FILE: path.join(outputDir, 'draw-attempts.jsonl'),
    FEEDBACK_FILE: path.join(outputDir, 'feedback.json'),
  };

  for (const [name, target] of Object.entries(storage)) {
    if (name !== 'OUTPUT_DIR' && !isInside(outputDir, target)) {
      throw new Error(`${name} must stay inside the test runtime directory`);
    }
  }

  return {
    ...process.env,
    ...overrides,
    ...storage,
  };
}
