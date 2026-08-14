// Plain-object config (no `import 'vitest/config'`): importing the package
// makes vitest bundle the config through rolldown, whose Windows realpath
// helper spawns a piped child process — denied in sandboxed environments.
export default {
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'node',
    // The default forks pool spawns child processes with piped stdio, which
    // sandboxed environments deny (EPERM); worker threads need no pipes.
    pool: 'threads',
  },
}

