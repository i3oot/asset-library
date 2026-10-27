import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
  PUBLIC_UPLOAD_PARALLELISM: { public: true, schema: (value) => value ?? '4' },
});
