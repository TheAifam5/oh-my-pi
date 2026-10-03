// `bun test` preload: git run through Bun shell or with `env: process.env` ignores global and system config.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
