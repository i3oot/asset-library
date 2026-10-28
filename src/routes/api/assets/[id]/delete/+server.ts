import { json, type RequestHandler } from '@sveltejs/kit';
import { DELETE } from '../+server';

export const POST: RequestHandler = async event => {
  if (event.request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'JSON action required.' }, { status: 415 });
  let body;
  try { body = await event.request.json(); }
  catch { return json({ error: 'Invalid JSON action.' }, { status: 400 }); }
  if (body?.action !== 'delete') return json({ error: 'Explicit delete action required.' }, { status: 400 });
  return DELETE(event);
};
