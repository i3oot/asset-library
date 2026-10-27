import type { LayoutServerLoad } from './$types';
export const load: LayoutServerLoad = ({ locals }) => ({ auth: { enabled: locals.nativeAuth, user: locals.user } });
